import {
  MAX_REMOTE_CURSORS,
  tileKeyFromWorld,
} from "@sea/domain";
import type { ServerMessage } from "@sea/protocol";

import type { ConnectedClient } from "./connectionShardDOOperations";
import type {
  CursorPresence,
  CursorRelayBatch,
} from "./cursorRelay";
import { selectCursorSubscriptions } from "./cursorSelection";

const CURSOR_TTL_MS = 5_000;
const CURSOR_SELECTION_REFRESH_MS = 250;
const CURSOR_RELAY_FLUSH_MS = 50;

export interface Clock {
  nowMs(): number;
}

export interface ShardTopology {
  peerShardNames(currentShard: string): string[];
}

export interface CursorRelayTransport {
  relayCursorBatch(peerShards: string[], body: string): Promise<void>;
}

interface CursorCoordinatorOptions {
  clients: Map<string, ConnectedClient>;
  getCurrentShardName: () => string;
  defer: (task: () => Promise<unknown>) => void;
  clock: Clock;
  shardTopology: ShardTopology;
  cursorRelayTransport: CursorRelayTransport;
  sendServerMessage: (client: ConnectedClient, message: ServerMessage) => void;
}

export class CursorCoordinator {
  #clients: Map<string, ConnectedClient>;
  #getCurrentShardName: () => string;
  #defer: (task: () => Promise<unknown>) => void;
  #clock: Clock;
  #shardTopology: ShardTopology;
  #cursorRelayTransport: CursorRelayTransport;
  #sendServerMessage: (client: ConnectedClient, message: ServerMessage) => void;

  #cursorByUid: Map<string, CursorPresence>;
  #cursorTileIndex: Map<string, Set<string>>;
  #localCursorSeqByUid: Map<string, number>;
  #pendingCursorRelays: Map<string, CursorPresence>;
  #cursorRelayFlushTimer: ReturnType<typeof setTimeout> | null;
  #cursorRelayInFlight: boolean;
  #cursorSelectionDirty: boolean;
  #lastCursorSelectionRefreshMs: number;
  #cursorSelectionRefreshTimer: ReturnType<typeof setTimeout> | null;

  constructor(options: CursorCoordinatorOptions) {
    this.#clients = options.clients;
    this.#getCurrentShardName = options.getCurrentShardName;
    this.#defer = options.defer;
    this.#clock = options.clock;
    this.#shardTopology = options.shardTopology;
    this.#cursorRelayTransport = options.cursorRelayTransport;
    this.#sendServerMessage = options.sendServerMessage;

    this.#cursorByUid = new Map();
    this.#cursorTileIndex = new Map();
    this.#localCursorSeqByUid = new Map();
    this.#pendingCursorRelays = new Map();
    this.#cursorRelayFlushTimer = null;
    this.#cursorRelayInFlight = false;
    this.#cursorSelectionDirty = false;
    this.#lastCursorSelectionRefreshMs = 0;
    this.#cursorSelectionRefreshTimer = null;
  }

  onClientConnected(client: ConnectedClient): void {
    client.cursorSubscriptions = new Set();
    this.#markCursorSelectionDirty();
    this.#refreshCursorSelections(true);
  }

  onClientDisconnected(uid: string): void {
    this.#removeCursor(uid);
    this.#localCursorSeqByUid.delete(uid);
    this.#pendingCursorRelays.delete(uid);
    this.#markCursorSelectionDirty();
    this.#refreshCursorSelections(true);
  }

  onSubscriptionsChanged(force: boolean): void {
    this.#markCursorSelectionDirty();
    this.#refreshCursorSelections(force);
  }

  onActivity(): void {
    this.#refreshCursorSelections(false);
  }

  onLocalCursor(client: ConnectedClient, x: number, y: number): void {
    const nowMs = this.#clock.nowMs();
    client.lastCursorX = x;
    client.lastCursorY = y;

    const nextSeq = (this.#localCursorSeqByUid.get(client.uid) ?? 0) + 1;
    this.#localCursorSeqByUid.set(client.uid, nextSeq);

    const state: CursorPresence = {
      uid: client.uid,
      name: client.name,
      x,
      y,
      seenAt: nowMs,
      seq: nextSeq,
      tileKey: tileKeyFromWorld(x, y),
    };
    this.#upsertCursor(state);
    this.#markCursorSelectionDirty();
    this.#refreshCursorSelections(false);
    this.#sendCursorToSubscribedClients(state);

    this.#pendingCursorRelays.set(state.uid, state);
    this.#scheduleCursorRelayFlush();
  }

  onCursorBatch(batch: CursorRelayBatch): void {
    if (batch.from === this.#getCurrentShardName()) {
      return;
    }

    let hadChanges = false;
    for (const update of batch.updates) {
      const existing = this.#cursorByUid.get(update.uid);
      if (existing && existing.seq >= update.seq) {
        continue;
      }

      this.#upsertCursor(update);
      this.#sendCursorToSubscribedClients(update);
      hadChanges = true;
    }

    if (!hadChanges) {
      return;
    }

    this.#markCursorSelectionDirty();
    this.#refreshCursorSelections(false);
  }

  #scheduleCursorRelayFlush(delayMs: number = CURSOR_RELAY_FLUSH_MS): void {
    if (this.#cursorRelayFlushTimer) {
      return;
    }

    this.#cursorRelayFlushTimer = setTimeout(() => {
      this.#cursorRelayFlushTimer = null;
      this.#flushCursorRelays();
    }, Math.max(0, delayMs));
  }

  #flushCursorRelays(): void {
    if (this.#cursorRelayInFlight) {
      return;
    }

    if (this.#pendingCursorRelays.size === 0) {
      return;
    }

    const updates = Array.from(this.#pendingCursorRelays.values());
    this.#pendingCursorRelays.clear();

    const currentShard = this.#getCurrentShardName();
    const peers = this.#shardTopology.peerShardNames(currentShard);
    if (peers.length === 0) {
      return;
    }

    const body = JSON.stringify({
      from: currentShard,
      updates,
    });

    this.#cursorRelayInFlight = true;
    const relayTask = async (): Promise<void> => {
      try {
        await this.#cursorRelayTransport.relayCursorBatch(peers, body);
      } catch {
        // Cursor fanout is best-effort.
      } finally {
        this.#cursorRelayInFlight = false;
        if (this.#pendingCursorRelays.size > 0) {
          this.#scheduleCursorRelayFlush(0);
        }
      }
    };

    try {
      this.#defer(relayTask);
    } catch {
      void relayTask();
    }
  }

  #upsertCursor(state: CursorPresence): void {
    const previous = this.#cursorByUid.get(state.uid);
    if (previous?.tileKey && previous.tileKey !== state.tileKey) {
      const bucket = this.#cursorTileIndex.get(previous.tileKey);
      if (bucket) {
        bucket.delete(state.uid);
        if (bucket.size === 0) {
          this.#cursorTileIndex.delete(previous.tileKey);
        }
      }
    }

    let tileBucket = this.#cursorTileIndex.get(state.tileKey);
    if (!tileBucket) {
      tileBucket = new Set();
      this.#cursorTileIndex.set(state.tileKey, tileBucket);
    }
    tileBucket.add(state.uid);
    this.#cursorByUid.set(state.uid, state);
  }

  #removeCursor(uid: string): void {
    const existing = this.#cursorByUid.get(uid);
    if (!existing) {
      return;
    }

    const tileBucket = this.#cursorTileIndex.get(existing.tileKey);
    if (tileBucket) {
      tileBucket.delete(uid);
      if (tileBucket.size === 0) {
        this.#cursorTileIndex.delete(existing.tileKey);
      }
    }

    this.#cursorByUid.delete(uid);
  }

  #markCursorSelectionDirty(): void {
    this.#cursorSelectionDirty = true;
  }

  #pruneTransientState(nowMs: number): void {
    for (const [uid, cursor] of this.#cursorByUid) {
      if (nowMs - cursor.seenAt <= CURSOR_TTL_MS) {
        continue;
      }
      this.#removeCursor(uid);
    }
  }

  #refreshCursorSelections(force: boolean): void {
    const nowMs = this.#clock.nowMs();
    if (!force && !this.#cursorSelectionDirty) {
      return;
    }
    if (!force && nowMs - this.#lastCursorSelectionRefreshMs < CURSOR_SELECTION_REFRESH_MS) {
      const delayMs = CURSOR_SELECTION_REFRESH_MS - (nowMs - this.#lastCursorSelectionRefreshMs);
      if (!this.#cursorSelectionRefreshTimer) {
        this.#cursorSelectionRefreshTimer = setTimeout(() => {
          this.#cursorSelectionRefreshTimer = null;
          this.#refreshCursorSelections(true);
        }, delayMs);
      }
      return;
    }

    if (this.#cursorSelectionRefreshTimer) {
      clearTimeout(this.#cursorSelectionRefreshTimer);
      this.#cursorSelectionRefreshTimer = null;
    }

    this.#pruneTransientState(nowMs);

    for (const client of this.#clients.values()) {
      const previous = client.cursorSubscriptions ?? new Set<string>();
      const next = new Set(
        selectCursorSubscriptions({
          client,
          cursorByUid: this.#cursorByUid,
          cursorTileIndex: this.#cursorTileIndex,
          nowMs,
          cursorTtlMs: CURSOR_TTL_MS,
          nearestLimit: MAX_REMOTE_CURSORS,
        })
      );

      client.cursorSubscriptions = next;

      for (const uid of next) {
        if (previous.has(uid)) {
          continue;
        }
        const cursor = this.#cursorByUid.get(uid);
        if (!cursor) {
          continue;
        }
        this.#sendCursorUpdate(client, cursor);
      }
    }

    this.#lastCursorSelectionRefreshMs = nowMs;
    this.#cursorSelectionDirty = false;
  }

  #sendCursorToSubscribedClients(cursor: CursorPresence): void {
    for (const client of this.#clients.values()) {
      if (!client.cursorSubscriptions?.has(cursor.uid)) {
        continue;
      }
      this.#sendCursorUpdate(client, cursor);
    }
  }

  #sendCursorUpdate(client: ConnectedClient, cursor: CursorPresence): void {
    this.#sendServerMessage(client, {
      t: "curUp",
      uid: cursor.uid,
      name: cursor.name,
      x: cursor.x,
      y: cursor.y,
    });
  }
}
