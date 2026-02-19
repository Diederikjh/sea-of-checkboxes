import {
  MAX_REMOTE_CURSORS,
  tileKeyFromWorld,
} from "@sea/domain";
import type { ServerMessage } from "@sea/protocol";

import type { DurableObjectNamespaceLike } from "./doCommon";
import type { ConnectedClient } from "./connectionShardDOOperations";
import type {
  CursorPresence,
  CursorRelayBatch,
} from "./cursorRelay";
import { selectCursorSubscriptions } from "./cursorSelection";
import { peerShardNames } from "./sharding";

const CURSOR_TTL_MS = 5_000;
const CURSOR_SELECTION_REFRESH_MS = 250;
const CURSOR_RELAY_FLUSH_MS = 100;

interface CursorCoordinatorOptions {
  clients: Map<string, ConnectedClient>;
  connectionShardNamespace: DurableObjectNamespaceLike;
  getCurrentShardName: () => string;
  sendServerMessage: (client: ConnectedClient, message: ServerMessage) => void;
}

export class CursorCoordinator {
  #clients: Map<string, ConnectedClient>;
  #connectionShardNamespace: DurableObjectNamespaceLike;
  #getCurrentShardName: () => string;
  #sendServerMessage: (client: ConnectedClient, message: ServerMessage) => void;

  #cursorByUid: Map<string, CursorPresence>;
  #cursorTileIndex: Map<string, Set<string>>;
  #localCursorSeqByUid: Map<string, number>;
  #pendingCursorRelays: Map<string, CursorPresence>;
  #cursorRelayFlushTimer: ReturnType<typeof setTimeout> | null;
  #cursorSelectionDirty: boolean;
  #lastCursorSelectionRefreshMs: number;
  #cursorSelectionRefreshTimer: ReturnType<typeof setTimeout> | null;

  constructor(options: CursorCoordinatorOptions) {
    this.#clients = options.clients;
    this.#connectionShardNamespace = options.connectionShardNamespace;
    this.#getCurrentShardName = options.getCurrentShardName;
    this.#sendServerMessage = options.sendServerMessage;

    this.#cursorByUid = new Map();
    this.#cursorTileIndex = new Map();
    this.#localCursorSeqByUid = new Map();
    this.#pendingCursorRelays = new Map();
    this.#cursorRelayFlushTimer = null;
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
    const nowMs = Date.now();
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

  #scheduleCursorRelayFlush(): void {
    if (this.#cursorRelayFlushTimer) {
      return;
    }

    this.#cursorRelayFlushTimer = setTimeout(() => {
      this.#cursorRelayFlushTimer = null;
      void this.#flushCursorRelays();
    }, CURSOR_RELAY_FLUSH_MS);
  }

  async #flushCursorRelays(): Promise<void> {
    if (this.#pendingCursorRelays.size === 0) {
      return;
    }

    const updates = Array.from(this.#pendingCursorRelays.values());
    this.#pendingCursorRelays.clear();

    const currentShard = this.#getCurrentShardName();
    const peers = peerShardNames(currentShard);
    if (peers.length === 0) {
      return;
    }

    const body = JSON.stringify({
      from: currentShard,
      updates,
    });

    void Promise.all(
      peers.map(async (peerShard) => {
        const stub = this.#connectionShardNamespace.getByName(peerShard);
        await stub.fetch("https://connection-shard.internal/cursor-batch", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body,
        });
      })
    ).catch(() => {
      // Cursor fanout is best-effort.
    });
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
    const nowMs = Date.now();
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
