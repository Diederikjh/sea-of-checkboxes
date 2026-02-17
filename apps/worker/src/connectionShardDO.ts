import { MAX_TILES_SUBSCRIBED } from "@sea/domain";
import {
  decodeClientMessageBinary,
  encodeServerMessageBinary,
  type ClientMessage,
  type ServerMessage,
} from "@sea/protocol";

import {
  isValidTileKey,
  isWebSocketUpgrade,
  readJson,
  type DurableObjectStateLike,
  type Env,
  type TileSetCellRequest,
  type TileSetCellResponse,
  type TileWatchRequest,
} from "./doCommon";
import {
  createCloudflareUpgradeResponseFactory,
  createRuntimeSocketPairFactory,
  type SocketLike,
  type SocketPairFactory,
  type WebSocketUpgradeResponseFactory,
} from "./socketPair";

interface ConnectedClient {
  uid: string;
  name: string;
  socket: SocketLike;
  subscribed: Set<string>;
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

export class ConnectionShardDO {
  #state: DurableObjectStateLike;
  #env: Env;
  #shardName: string | null;
  #clients: Map<string, ConnectedClient>;
  #tileToClients: Map<string, Set<string>>;
  #socketPairFactory: SocketPairFactory;
  #upgradeResponseFactory: WebSocketUpgradeResponseFactory;

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

    const pair = this.#socketPairFactory.createPair();
    const clientSocket = pair.client;
    const serverSocket = pair.server;

    serverSocket.accept();

    const client: ConnectedClient = {
      uid,
      name,
      socket: serverSocket,
      subscribed: new Set(),
    };

    this.#clients.set(uid, client);
    this.#sendServerMessage(client, { t: "hello", uid, name });

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
      void this.#disconnectClient(uid);
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
      this.#sendError(client, "internal", "Failed to process message");
    }
  }

  async #handleSub(client: ConnectedClient, tiles: string[]): Promise<void> {
    for (const tileKey of tiles) {
      if (client.subscribed.has(tileKey)) {
        continue;
      }

      if (client.subscribed.size >= MAX_TILES_SUBSCRIBED) {
        this.#sendError(client, "sub_limit", `Max ${MAX_TILES_SUBSCRIBED} tiles subscribed`);
        return;
      }

      if (!isValidTileKey(tileKey)) {
        this.#sendBadTile(client, tileKey);
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

      await this.#sendSnapshotToClient(client, tileKey);
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
      this.#sendBadTile(client, tileKey);
      return;
    }

    const isSubscribed = client.subscribed.has(tileKey);
    if (!isSubscribed) {
      this.#sendError(client, "not_subscribed", `Tile ${tileKey} is not currently subscribed`);
      await this.#sendSnapshotToClient(client, tileKey);
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
      this.#sendError(client, "setcell_rejected", result?.reason ?? "Rejected");
      return;
    }

    if (!result.changed) {
      // Client may be stale and repeatedly submit no-op writes.
      // Send a fresh snapshot so local cache can converge.
      await this.#sendSnapshotToClient(client, tileKey);
    }
  }

  async #handleResync(client: ConnectedClient, tileKey: string): Promise<void> {
    if (!isValidTileKey(tileKey)) {
      this.#sendBadTile(client, tileKey);
      return;
    }

    await this.#sendSnapshotToClient(client, tileKey);
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
}
