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
  handleCursorMessage,
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
      void disconnectClientFromShard(this.#operationsContext(), uid);
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
          await handleSubMessage(this.#operationsContext(), client, message.tiles);
          return;
        case "unsub":
          await handleUnsubMessage(this.#operationsContext(), client, message.tiles);
          return;
        case "setCell":
          await handleSetCellMessage(this.#operationsContext(), client, message);
          return;
        case "resyncTile":
          await handleResyncMessage(this.#operationsContext(), client, message.tile);
          return;
        case "cur":
          handleCursorMessage(this.#operationsContext(), client, message.x, message.y);
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
