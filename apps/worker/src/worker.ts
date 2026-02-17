import {
  TILE_CELL_COUNT,
  MAX_TILES_SUBSCRIBED,
  isTileCoordInBounds,
  parseTileKeyStrict,
} from "@sea/domain";
import {
  decodeClientMessageBinary,
  decodeRle64,
  encodeServerMessageBinary,
  type ClientMessage,
  type ServerMessage,
} from "@sea/protocol";

import { TileOwner } from "./local/tileOwner";

interface DurableObjectStubLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  getByName(name: string): DurableObjectStubLike;
}

interface DurableObjectStateLike {
  id: { toString(): string };
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface WebSocketPairLike {
  0: WebSocket & { accept: () => void };
  1: WebSocket & { accept: () => void };
}

interface Env {
  CONNECTION_SHARD: DurableObjectNamespaceLike;
  TILE_OWNER: DurableObjectNamespaceLike;
}

interface TileWatchRequest {
  tile: string;
  shard: string;
  action: "sub" | "unsub";
}

interface TileSetCellRequest {
  tile: string;
  i: number;
  v: 0 | 1;
  op: string;
}

interface TileSetCellResponse {
  accepted: boolean;
  changed: boolean;
  ver: number;
  reason?: string;
}

interface ConnectedClient {
  uid: string;
  name: string;
  socket: WebSocket;
  subscribed: Set<string>;
}

const SHARD_COUNT = 8;
const NAME_ADJECTIVES = ["Brisk", "Quiet", "Amber", "Mint", "Rust", "Blue"];
const NAME_NOUNS = ["Otter", "Falcon", "Badger", "Stoat", "Fox", "Heron"];

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function generateUid(): string {
  return `u_${crypto.randomUUID().slice(0, 8)}`;
}

function randomFrom<T>(values: T[]): T {
  const index = Math.floor(Math.random() * values.length);
  const value = values[index];
  if (value === undefined) {
    throw new Error("Unable to select random value");
  }
  return value;
}

function generateName(): string {
  const adjective = randomFrom(NAME_ADJECTIVES);
  const noun = randomFrom(NAME_NOUNS);
  const suffix = Math.floor(Math.random() * 1_000)
    .toString()
    .padStart(3, "0");
  return `${adjective}${noun}${suffix}`;
}

function shardNameForUid(uid: string): string {
  let hash = 2166136261;
  for (let index = 0; index < uid.length; index += 1) {
    hash ^= uid.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const shard = Math.abs(hash) % SHARD_COUNT;
  return `shard-${shard}`;
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
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

function isValidTileKey(tileKey: string): boolean {
  const parsed = parseTileKeyStrict(tileKey);
  return parsed !== null && isTileCoordInBounds(parsed.tx, parsed.ty);
}

async function readJson<T>(value: { json: () => Promise<unknown> }): Promise<T | null> {
  try {
    return (await value.json()) as T;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        ws: "/ws",
      });
    }

    if (url.pathname !== "/ws") {
      return new Response("Not found", { status: 404 });
    }

    if (!isWebSocketUpgrade(request)) {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    const uid = generateUid();
    const name = generateName();
    const shardName = shardNameForUid(uid);

    const shardUrl = new URL("https://connection-shard.internal/ws");
    shardUrl.searchParams.set("uid", uid);
    shardUrl.searchParams.set("name", name);
    shardUrl.searchParams.set("shard", shardName);

    const headers = new Headers(request.headers);
    const shardRequest = new Request(shardUrl.toString(), {
      method: "GET",
      headers,
    });

    const shardStub = env.CONNECTION_SHARD.getByName(shardName);
    return shardStub.fetch(shardRequest);
  },
};

export class ConnectionShardDO {
  #state: DurableObjectStateLike;
  #env: Env;
  #shardName: string | null;
  #clients: Map<string, ConnectedClient>;
  #tileToClients: Map<string, Set<string>>;

  constructor(state: DurableObjectStateLike, env: Env) {
    this.#state = state;
    this.#env = env;
    this.#shardName = null;
    this.#clients = new Map();
    this.#tileToClients = new Map();
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

    const pair = new ((globalThis as unknown as { WebSocketPair: new () => WebSocketPairLike })
      .WebSocketPair)();
    const clientSocket = pair[0];
    const serverSocket = pair[1];

    serverSocket.accept();

    const client: ConnectedClient = {
      uid,
      name,
      socket: serverSocket,
      subscribed: new Set(),
    };

    this.#clients.set(uid, client);
    this.#sendServerMessage(client, { t: "hello", uid, name });

    serverSocket.addEventListener("message", (event: MessageEvent) => {
      const payload = toBinaryPayload(event.data);
      if (!payload) {
        this.#sendServerMessage(client, {
          t: "err",
          code: "bad_message",
          msg: "Expected binary message payload",
        });
        return;
      }

      void this.#receiveClientPayload(uid, payload).catch(() => {
        this.#sendServerMessage(client, {
          t: "err",
          code: "internal",
          msg: "Failed to process client payload",
        });
      });
    });

    const onClose = () => {
      void this.#disconnectClient(uid);
    };

    serverSocket.addEventListener("close", onClose);
    serverSocket.addEventListener("error", onClose);

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    } as ResponseInit);
  }

  async #receiveClientPayload(uid: string, payload: Uint8Array): Promise<void> {
    const client = this.#clients.get(uid);
    if (!client) {
      return;
    }

    let message: ClientMessage;
    try {
      message = decodeClientMessageBinary(payload);
    } catch {
      this.#sendServerMessage(client, {
        t: "err",
        code: "bad_message",
        msg: "Invalid message payload",
      });
      return;
    }

    try {
      switch (message.t) {
        case "sub":
          await this.#handleSub(client, message.tiles);
          return;
        case "unsub":
          await this.#handleUnsub(client, message.tiles);
          return;
        case "setCell":
          await this.#handleSetCell(client, message.tile, message.i, message.v, message.op);
          return;
        case "resyncTile":
          await this.#handleResync(client, message.tile);
          return;
        case "cur":
          this.#handleCursor(client, message.x, message.y);
          return;
        default:
          return;
      }
    } catch {
      this.#sendServerMessage(client, {
        t: "err",
        code: "internal",
        msg: "Failed to process message",
      });
    }
  }

  async #handleSub(client: ConnectedClient, tiles: string[]): Promise<void> {
    for (const tileKey of tiles) {
      if (client.subscribed.has(tileKey)) {
        continue;
      }

      if (client.subscribed.size >= MAX_TILES_SUBSCRIBED) {
        this.#sendServerMessage(client, {
          t: "err",
          code: "sub_limit",
          msg: `Max ${MAX_TILES_SUBSCRIBED} tiles subscribed`,
        });
        return;
      }

      if (!isValidTileKey(tileKey)) {
        this.#sendServerMessage(client, {
          t: "err",
          code: "bad_tile",
          msg: `Invalid tile key ${tileKey}`,
        });
        continue;
      }

      client.subscribed.add(tileKey);

      let subscribers = this.#tileToClients.get(tileKey);
      if (!subscribers) {
        subscribers = new Set();
        this.#tileToClients.set(tileKey, subscribers);
      }

      const wasEmpty = subscribers.size === 0;
      subscribers.add(client.uid);

      if (wasEmpty) {
        await this.#watchTile(tileKey, "sub");
      }

      const snapshot = await this.#fetchTileSnapshot(tileKey);
      if (snapshot) {
        this.#sendServerMessage(client, snapshot);
      }
    }
  }

  async #handleUnsub(client: ConnectedClient, tiles: string[]): Promise<void> {
    for (const tileKey of tiles) {
      if (!client.subscribed.has(tileKey)) {
        continue;
      }

      client.subscribed.delete(tileKey);
      const subscribers = this.#tileToClients.get(tileKey);
      if (!subscribers) {
        continue;
      }

      subscribers.delete(client.uid);
      if (subscribers.size !== 0) {
        continue;
      }

      this.#tileToClients.delete(tileKey);
      await this.#watchTile(tileKey, "unsub");
    }
  }

  async #handleSetCell(
    client: ConnectedClient,
    tileKey: string,
    i: number,
    v: 0 | 1,
    op: string
  ): Promise<void> {
    if (!isValidTileKey(tileKey)) {
      this.#sendServerMessage(client, {
        t: "err",
        code: "bad_tile",
        msg: `Invalid tile key ${tileKey}`,
      });
      return;
    }

    const isSubscribed = client.subscribed.has(tileKey);
    if (!isSubscribed) {
      this.#sendServerMessage(client, {
        t: "err",
        code: "not_subscribed",
        msg: `Tile ${tileKey} is not currently subscribed`,
      });

      const snapshot = await this.#fetchTileSnapshot(tileKey);
      if (snapshot) {
        this.#sendServerMessage(client, snapshot);
      }
      return;
    }

    // Re-assert watch before writes. This self-heals TileOwnerDO watcher sets
    // if the tile DO was recycled and forgot in-memory shard subscriptions.
    await this.#watchTile(tileKey, "sub");

    const result = await this.#setTileCell({
      tile: tileKey,
      i,
      v,
      op,
    });

    if (!result?.accepted) {
      this.#sendServerMessage(client, {
        t: "err",
        code: "setcell_rejected",
        msg: result?.reason ?? "Rejected",
      });
      return;
    }

    if (!result.changed) {
      // Client may be stale and repeatedly submit no-op writes.
      // Send a fresh snapshot so local cache can converge.
      const snapshot = await this.#fetchTileSnapshot(tileKey);
      if (snapshot) {
        this.#sendServerMessage(client, snapshot);
      }
    }
  }

  async #handleResync(client: ConnectedClient, tileKey: string): Promise<void> {
    if (!isValidTileKey(tileKey)) {
      this.#sendServerMessage(client, {
        t: "err",
        code: "bad_tile",
        msg: `Invalid tile key ${tileKey}`,
      });
      return;
    }

    const snapshot = await this.#fetchTileSnapshot(tileKey);
    if (snapshot) {
      this.#sendServerMessage(client, snapshot);
    }
  }

  #handleCursor(client: ConnectedClient, x: number, y: number): void {
    for (const target of this.#clients.values()) {
      if (target.uid === client.uid) {
        continue;
      }

      this.#sendServerMessage(target, {
        t: "curUp",
        uid: client.uid,
        name: client.name,
        x,
        y,
      });
    }
  }

  #receiveTileBatch(message: Extract<ServerMessage, { t: "cellUpBatch" }>): void {
    const subscribers = this.#tileToClients.get(message.tile);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    for (const uid of subscribers) {
      const client = this.#clients.get(uid);
      if (!client) {
        continue;
      }
      this.#sendServerMessage(client, message);
    }
  }

  async #disconnectClient(uid: string): Promise<void> {
    const client = this.#clients.get(uid);
    if (!client) {
      return;
    }

    this.#clients.delete(uid);

    for (const tileKey of client.subscribed) {
      const subscribers = this.#tileToClients.get(tileKey);
      if (!subscribers) {
        continue;
      }

      subscribers.delete(uid);
      if (subscribers.size !== 0) {
        continue;
      }

      this.#tileToClients.delete(tileKey);
      await this.#watchTile(tileKey, "unsub");
    }
  }

  #sendServerMessage(client: ConnectedClient, message: ServerMessage): void {
    try {
      client.socket.send(encodeServerMessageBinary(message));
    } catch {
      // Ignore broken socket errors; close handler will clean up.
    }
  }

  #tileOwnerStub(tileKey: string): DurableObjectStubLike {
    return this.#env.TILE_OWNER.getByName(tileKey);
  }

  async #watchTile(tileKey: string, action: "sub" | "unsub"): Promise<void> {
    const shard = this.#shardName ?? this.#state.id.toString();
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
}

export class TileOwnerDO {
  #state: DurableObjectStateLike;
  #env: Env;
  #tileOwner: TileOwner;
  #tileKey: string | null;
  #subscriberShards: Set<string>;
  #loaded: boolean;

  constructor(state: DurableObjectStateLike, env: Env) {
    this.#state = state;
    this.#env = env;
    this.#tileOwner = new TileOwner("0:0");
    this.#tileKey = null;
    this.#subscriberShards = new Set();
    this.#loaded = false;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/watch" && request.method === "POST") {
      const payload = await readJson<TileWatchRequest>(request);
      if (!payload || !isValidTileKey(payload.tile)) {
        return new Response("Invalid watch payload", { status: 400 });
      }

      await this.#ensureLoaded(payload.tile);
      if (payload.action === "sub") {
        this.#subscriberShards.add(payload.shard);
      } else {
        this.#subscriberShards.delete(payload.shard);
      }

      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/snapshot") {
      const tileKey = url.searchParams.get("tile");
      if (!tileKey || !isValidTileKey(tileKey)) {
        return new Response("Invalid tile", { status: 400 });
      }

      await this.#ensureLoaded(tileKey);
      return jsonResponse(this.#tileOwner.getSnapshotMessage());
    }

    if (url.pathname === "/setCell" && request.method === "POST") {
      const payload = await readJson<TileSetCellRequest>(request);
      if (!payload || !isValidTileKey(payload.tile)) {
        return new Response("Invalid setCell payload", { status: 400 });
      }

      await this.#ensureLoaded(payload.tile);

      const result = this.#tileOwner.applySetCell({
        i: payload.i,
        v: payload.v,
        op: payload.op,
      });

      if (result.changed) {
        await this.#persistSnapshot();

        const batch: Extract<ServerMessage, { t: "cellUpBatch" }> = {
          t: "cellUpBatch",
          tile: payload.tile,
          fromVer: result.ver,
          toVer: result.ver,
          ops: [[payload.i, payload.v]],
        };

        // Do not await fanout here to avoid circular waits:
        // shard -> tile owner -> shard (same shard may be in subscribers).
        void Promise.all(
          Array.from(this.#subscriberShards).map(async (shardId) => {
            const stub = this.#env.CONNECTION_SHARD.getByName(shardId);
            await stub.fetch("https://connection-shard.internal/tile-batch", {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify(batch),
            });
          })
        ).catch(() => {
          // Best-effort fanout; requester still gets a successful setCell response.
        });
      }

      const body: TileSetCellResponse = result.reason
        ? {
            accepted: result.accepted,
            changed: result.changed,
            ver: result.ver,
            reason: result.reason,
          }
        : {
            accepted: result.accepted,
            changed: result.changed,
            ver: result.ver,
          };

      return jsonResponse(body);
    }

    return new Response("Not found", { status: 404 });
  }

  #setTileKey(tileKey: string): void {
    if (this.#tileKey === tileKey) {
      return;
    }

    this.#tileKey = tileKey;
    this.#tileOwner = new TileOwner(tileKey);
    this.#loaded = false;
  }

  async #ensureLoaded(tileKey: string): Promise<void> {
    this.#setTileKey(tileKey);
    if (this.#loaded) {
      return;
    }

    const persisted = await this.#state.storage.get<{ bits: string; ver: number }>("snapshot");
    if (persisted) {
      const bits = decodeRle64(persisted.bits, TILE_CELL_COUNT);
      this.#tileOwner.loadSnapshot(bits, persisted.ver);
    }

    this.#loaded = true;
  }

  async #persistSnapshot(): Promise<void> {
    const snapshot = this.#tileOwner.getSnapshotMessage();
    await this.#state.storage.put("snapshot", {
      bits: snapshot.bits,
      ver: snapshot.ver,
    });
  }
}
