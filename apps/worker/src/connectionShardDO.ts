import {
  MAX_REMOTE_CURSORS,
  parseTileKeyStrict,
  tileKeyFromWorld,
} from "@sea/domain";
import {
  decodeClientMessageBinary,
  encodeServerMessageBinary,
  type ClientMessage,
  type ServerMessage,
} from "@sea/protocol";

import {
  isWebSocketUpgrade,
  readJson,
  type DurableObjectStateLike,
  type Env,
  type TileSetCellRequest,
  type TileSetCellResponse,
  type TileWatchRequest,
} from "./doCommon";
import {
  disconnectClientFromShard,
  handleResyncMessage,
  handleSetCellMessage,
  handleSubMessage,
  handleUnsubMessage,
  receiveTileBatchMessage,
  type ConnectedClient,
  type ConnectionShardDOOperationsContext,
} from "./connectionShardDOOperations";
import {
  createCloudflareUpgradeResponseFactory,
  createRuntimeSocketPairFactory,
  type SocketPairFactory,
  type WebSocketUpgradeResponseFactory,
} from "./socketPair";
import { selectCursorSubscriptions } from "./cursorSelection";
import { peerShardNames } from "./sharding";

const CURSOR_TTL_MS = 5_000;
const CURSOR_SELECTION_REFRESH_MS = 250;
const CURSOR_RELAY_FLUSH_MS = 100;

interface CursorState {
  uid: string;
  name: string;
  x: number;
  y: number;
  seenAt: number;
  seq: number;
  tileKey: string;
}

interface CursorRelayUpdate {
  uid: string;
  name: string;
  x: number;
  y: number;
  seenAt: number;
  seq: number;
  tileKey: string;
}

interface CursorRelayBatch {
  from: string;
  updates: CursorRelayUpdate[];
}

function toBinaryPayload(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return null;
}

function readMessageEventData(event: unknown): unknown {
  if (typeof event !== "object" || event === null) {
    return null;
  }
  if (!("data" in event)) {
    return null;
  }
  return (event as { data: unknown }).data;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidCursorRelayUpdate(value: unknown): value is CursorRelayUpdate {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const update = value as Partial<CursorRelayUpdate>;
  if (typeof update.uid !== "string" || update.uid.length === 0) {
    return false;
  }
  if (typeof update.name !== "string" || update.name.length === 0) {
    return false;
  }
  if (!isFiniteNumber(update.x) || !isFiniteNumber(update.y)) {
    return false;
  }
  if (typeof update.seq !== "number" || !Number.isInteger(update.seq) || update.seq < 1) {
    return false;
  }
  if (!isFiniteNumber(update.seenAt) || update.seenAt < 0) {
    return false;
  }
  if (typeof update.tileKey !== "string" || parseTileKeyStrict(update.tileKey) === null) {
    return false;
  }

  return true;
}

function isValidCursorRelayBatch(value: unknown): value is CursorRelayBatch {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const batch = value as Partial<CursorRelayBatch>;
  if (typeof batch.from !== "string" || batch.from.length === 0) {
    return false;
  }
  if (!Array.isArray(batch.updates)) {
    return false;
  }
  return batch.updates.every((update) => isValidCursorRelayUpdate(update));
}

export class ConnectionShardDO {
  #state: DurableObjectStateLike;
  #env: Env;
  #shardName: string | null;
  #clients: Map<string, ConnectedClient>;
  #tileToClients: Map<string, Set<string>>;
  #socketPairFactory: SocketPairFactory;
  #upgradeResponseFactory: WebSocketUpgradeResponseFactory;
  #cursorByUid: Map<string, CursorState>;
  #cursorTileIndex: Map<string, Set<string>>;
  #localCursorSeqByUid: Map<string, number>;
  #pendingCursorRelays: Map<string, CursorRelayUpdate>;
  #cursorRelayFlushTimer: ReturnType<typeof setTimeout> | null;
  #cursorSelectionDirty: boolean;
  #lastCursorSelectionRefreshMs: number;
  #cursorSelectionRefreshTimer: ReturnType<typeof setTimeout> | null;

  constructor(
    state: DurableObjectStateLike,
    env: Env,
    options: {
      socketPairFactory?: SocketPairFactory;
      upgradeResponseFactory?: WebSocketUpgradeResponseFactory;
    } = {}
  ) {
    this.#state = state;
    this.#env = env;
    this.#shardName = null;
    this.#clients = new Map();
    this.#tileToClients = new Map();
    this.#socketPairFactory = options.socketPairFactory ?? createRuntimeSocketPairFactory();
    this.#upgradeResponseFactory =
      options.upgradeResponseFactory ?? createCloudflareUpgradeResponseFactory();
    this.#cursorByUid = new Map();
    this.#cursorTileIndex = new Map();
    this.#localCursorSeqByUid = new Map();
    this.#pendingCursorRelays = new Map();
    this.#cursorRelayFlushTimer = null;
    this.#cursorSelectionDirty = false;
    this.#lastCursorSelectionRefreshMs = 0;
    this.#cursorSelectionRefreshTimer = null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return this.#handleWebSocketConnect(request, url);
    }

    if (url.pathname === "/tile-batch" && request.method === "POST") {
      const batch = await readJson<Extract<ServerMessage, { t: "cellUpBatch" }>>(request);
      if (!batch || batch.t !== "cellUpBatch") {
        return new Response("Invalid tile batch payload", { status: 400 });
      }
      this.#receiveTileBatch(batch);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/cursor-batch" && request.method === "POST") {
      const batch = await readJson<CursorRelayBatch>(request);
      if (!batch || !isValidCursorRelayBatch(batch)) {
        return new Response("Invalid cursor batch payload", { status: 400 });
      }
      this.#receiveCursorBatch(batch);
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }

  #handleWebSocketConnect(request: Request, url: URL): Response {
    if (!isWebSocketUpgrade(request)) {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    const uid = url.searchParams.get("uid");
    const name = url.searchParams.get("name");
    const shardName = url.searchParams.get("shard");
    if (!uid || !name || !shardName) {
      return new Response("Missing uid/name", { status: 400 });
    }

    this.#shardName = shardName;

    const pair = this.#socketPairFactory.createPair();
    const clientSocket = pair.client;
    const serverSocket = pair.server;

    serverSocket.accept();

    const client: ConnectedClient = {
      uid,
      name,
      socket: serverSocket,
      subscribed: new Set(),
      lastCursorX: null,
      lastCursorY: null,
      cursorSubscriptions: new Set(),
    };

    this.#clients.set(uid, client);
    this.#sendServerMessage(client, { t: "hello", uid, name });
    this.#markCursorSelectionDirty();
    this.#refreshCursorSelections(true);
    const context = this.#operationsContext();

    serverSocket.addEventListener("message", (event: unknown) => {
      const payload = toBinaryPayload(readMessageEventData(event));
      if (!payload) {
        this.#sendError(client, "bad_message", "Expected binary message payload");
        return;
      }

      void this.#receiveClientPayload(uid, payload).catch(() => {
        this.#sendError(client, "internal", "Failed to process client payload");
      });
    });

    const onClose = () => {
      void this.#disconnectClient(context, uid);
    };

    serverSocket.addEventListener("close", onClose);
    serverSocket.addEventListener("error", onClose);

    return this.#upgradeResponseFactory.createResponse(clientSocket);
  }

  async #receiveClientPayload(uid: string, payload: Uint8Array): Promise<void> {
    const client = this.#clients.get(uid);
    if (!client) {
      return;
    }
    const context = this.#operationsContext();

    let message: ClientMessage;
    try {
      message = decodeClientMessageBinary(payload);
    } catch {
      this.#sendError(client, "bad_message", "Invalid message payload");
      return;
    }

    try {
      switch (message.t) {
        case "sub":
          await handleSubMessage(context, client, message.tiles);
          this.#markCursorSelectionDirty();
          this.#refreshCursorSelections(true);
          return;
        case "unsub":
          await handleUnsubMessage(context, client, message.tiles);
          this.#markCursorSelectionDirty();
          this.#refreshCursorSelections(true);
          return;
        case "setCell":
          await handleSetCellMessage(context, client, message);
          this.#refreshCursorSelections(false);
          return;
        case "resyncTile":
          await handleResyncMessage(context, client, message.tile);
          return;
        case "cur":
          this.#receiveLocalCursorUpdate(client, message.x, message.y);
          return;
        default:
          return;
      }
    } catch {
      this.#sendError(client, "internal", "Failed to process message");
    }
  }

  #receiveTileBatch(message: Extract<ServerMessage, { t: "cellUpBatch" }>): void {
    receiveTileBatchMessage(this.#operationsContext(), message);
    this.#refreshCursorSelections(false);
  }

  #sendServerMessage(client: ConnectedClient, message: ServerMessage): void {
    try {
      client.socket.send(encodeServerMessageBinary(message));
    } catch {
      // Ignore broken socket errors; close handler will clean up.
    }
  }

  #tileOwnerStub(tileKey: string) {
    return this.#env.TILE_OWNER.getByName(tileKey);
  }

  async #watchTile(tileKey: string, action: "sub" | "unsub"): Promise<void> {
    const shard = this.#currentShardName();
    const payload: TileWatchRequest = {
      tile: tileKey,
      shard,
      action,
    };

    await this.#tileOwnerStub(tileKey).fetch("https://tile-owner.internal/watch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  async #fetchTileSnapshot(tileKey: string): Promise<Extract<ServerMessage, { t: "tileSnap" }> | null> {
    const response = await this.#tileOwnerStub(tileKey).fetch(
      `https://tile-owner.internal/snapshot?tile=${encodeURIComponent(tileKey)}`
    );

    if (!response.ok) {
      return null;
    }

    return readJson<Extract<ServerMessage, { t: "tileSnap" }>>(response);
  }

  async #setTileCell(payload: TileSetCellRequest): Promise<TileSetCellResponse | null> {
    const response = await this.#tileOwnerStub(payload.tile).fetch("https://tile-owner.internal/setCell", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return null;
    }

    return readJson<TileSetCellResponse>(response);
  }

  async #sendSnapshotToClient(client: ConnectedClient, tileKey: string): Promise<void> {
    const snapshot = await this.#fetchTileSnapshot(tileKey);
    if (!snapshot) {
      return;
    }
    this.#sendServerMessage(client, snapshot);
  }

  #sendBadTile(client: ConnectedClient, tileKey: string): void {
    this.#sendError(client, "bad_tile", `Invalid tile key ${tileKey}`);
  }

  #sendError(client: ConnectedClient, code: string, msg: string): void {
    this.#sendServerMessage(client, {
      t: "err",
      code,
      msg,
    });
  }

  #currentShardName(): string {
    return this.#shardName ?? this.#state.id.toString();
  }

  async #disconnectClient(context: ConnectionShardDOOperationsContext, uid: string): Promise<void> {
    await disconnectClientFromShard(context, uid);
    this.#removeCursor(uid);
    this.#localCursorSeqByUid.delete(uid);
    this.#pendingCursorRelays.delete(uid);
    this.#markCursorSelectionDirty();
    this.#refreshCursorSelections(true);
  }

  #receiveLocalCursorUpdate(client: ConnectedClient, x: number, y: number): void {
    const nowMs = Date.now();
    client.lastCursorX = x;
    client.lastCursorY = y;

    const nextSeq = (this.#localCursorSeqByUid.get(client.uid) ?? 0) + 1;
    this.#localCursorSeqByUid.set(client.uid, nextSeq);

    const state: CursorState = {
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

    this.#pendingCursorRelays.set(state.uid, {
      uid: state.uid,
      name: state.name,
      x: state.x,
      y: state.y,
      seenAt: state.seenAt,
      seq: state.seq,
      tileKey: state.tileKey,
    });
    this.#scheduleCursorRelayFlush();
  }

  #receiveCursorBatch(batch: CursorRelayBatch): void {
    if (batch.from === this.#currentShardName()) {
      return;
    }

    let hadChanges = false;
    for (const update of batch.updates) {
      const existing = this.#cursorByUid.get(update.uid);
      if (existing && existing.seq >= update.seq) {
        continue;
      }

      const state: CursorState = {
        uid: update.uid,
        name: update.name,
        x: update.x,
        y: update.y,
        seenAt: update.seenAt,
        seq: update.seq,
        tileKey: update.tileKey,
      };
      this.#upsertCursor(state);
      this.#sendCursorToSubscribedClients(state);
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

    const currentShard = this.#currentShardName();
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
        const stub = this.#env.CONNECTION_SHARD.getByName(peerShard);
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

  #upsertCursor(state: CursorState): void {
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

  #sendCursorToSubscribedClients(cursor: CursorState): void {
    for (const client of this.#clients.values()) {
      if (!client.cursorSubscriptions?.has(cursor.uid)) {
        continue;
      }
      this.#sendCursorUpdate(client, cursor);
    }
  }

  #sendCursorUpdate(client: ConnectedClient, cursor: CursorState): void {
    this.#sendServerMessage(client, {
      t: "curUp",
      uid: cursor.uid,
      name: cursor.name,
      x: cursor.x,
      y: cursor.y,
    });
  }

  #operationsContext(): ConnectionShardDOOperationsContext {
    return {
      clients: this.#clients,
      tileToClients: this.#tileToClients,
      sendServerMessage: (client, message) => {
        this.#sendServerMessage(client, message);
      },
      sendError: (client, code, msg) => {
        this.#sendError(client, code, msg);
      },
      sendBadTile: (client, tileKey) => {
        this.#sendBadTile(client, tileKey);
      },
      watchTile: (tileKey, action) => this.#watchTile(tileKey, action),
      setTileCell: (payload) => this.#setTileCell(payload),
      sendSnapshotToClient: (client, tileKey) => this.#sendSnapshotToClient(client, tileKey),
    };
  }
}
