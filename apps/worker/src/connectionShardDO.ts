import {
  decodeClientMessageBinary,
  encodeServerMessageBinary,
  type ClientMessage,
  type ServerMessage,
} from "@sea/protocol";

import {
  isWebSocketUpgrade,
  readJson,
  type ConnectionIdentity,
  type DurableObjectStateLike,
  type Env,
  type TileSetCellRequest,
  type TileSetCellResponse,
} from "./doCommon";
import {
  disconnectClientFromShard,
  handleResyncMessage,
  handleSetCellMessage,
  handleSubMessage,
  handleUnsubMessage,
  type ConnectedClient,
  type ConnectionShardDOOperationsContext,
} from "./connectionShardDOOperations";
import { type CursorRelayBatch, isValidCursorRelayBatch } from "./cursorRelay";
import { CursorCoordinator } from "./cursorCoordinator";
import { ConnectionShardTileGateway } from "./connectionShardTileGateway";
import {
  createCloudflareUpgradeResponseFactory,
  createRuntimeSocketPairFactory,
  type SocketLike,
  type SocketPairFactory,
  type WebSocketUpgradeResponseFactory,
} from "./socketPair";
import { readBinaryMessageEventPayload } from "./socketMessagePayload";
import { fanoutTileBatchToSubscribers } from "./tileBatchFanout";
import { logStructuredEvent } from "./observability";

export class ConnectionShardDO {
  #state: DurableObjectStateLike;
  #env: Env;
  #shardName: string | null;
  #clients: Map<string, ConnectedClient>;
  #tileToClients: Map<string, Set<string>>;
  #socketPairFactory: SocketPairFactory;
  #upgradeResponseFactory: WebSocketUpgradeResponseFactory;
  #cursorCoordinator: CursorCoordinator;
  #tileGateway: ConnectionShardTileGateway;

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
    this.#cursorCoordinator = new CursorCoordinator({
      clients: this.#clients,
      connectionShardNamespace: this.#env.CONNECTION_SHARD,
      getCurrentShardName: () => this.#currentShardName(),
      sendServerMessage: (client, message) => {
        this.#sendServerMessage(client, message);
      },
    });
    this.#tileGateway = new ConnectionShardTileGateway({
      tileOwnerNamespace: this.#env.TILE_OWNER,
      getCurrentShardName: () => this.#currentShardName(),
    });
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

  #parseConnectParams(url: URL): { identity: ConnectionIdentity; shardName: string } | null {
    const uid = url.searchParams.get("uid");
    const name = url.searchParams.get("name");
    const token = url.searchParams.get("token");
    const shardName = url.searchParams.get("shard");
    if (!uid || !name || !token || !shardName) {
      return null;
    }

    return {
      identity: { uid, name, token },
      shardName,
    };
  }

  async #replaceExistingClient(identity: ConnectionIdentity, context: ConnectionShardDOOperationsContext): Promise<void> {
    const existingClient = this.#clients.get(identity.uid);
    if (!existingClient) {
      return;
    }

    try {
      const maybeClose = (existingClient.socket as unknown as { close?: () => void }).close;
      if (typeof maybeClose === "function") {
        maybeClose.call(existingClient.socket);
      }
    } catch {
      // Ignore close errors from stale sockets.
    }
    await this.#disconnectClientIfCurrent(context, identity.uid, existingClient.socket);
  }

  async #handleWebSocketConnect(request: Request, url: URL): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    const connectParams = this.#parseConnectParams(url);
    if (!connectParams) {
      return new Response("Missing uid/name/token", { status: 400 });
    }
    const { identity, shardName } = connectParams;

    this.#shardName = shardName;

    const pair = this.#socketPairFactory.createPair();
    const clientSocket = pair.client;
    const serverSocket = pair.server;

    serverSocket.accept();
    const context = this.#operationsContext();
    await this.#replaceExistingClient(identity, context);

    const client: ConnectedClient = {
      uid: identity.uid,
      name: identity.name,
      socket: serverSocket,
      subscribed: new Set(),
      lastCursorX: null,
      lastCursorY: null,
      cursorSubscriptions: new Set(),
    };

    this.#clients.set(identity.uid, client);
    this.#logEvent("ws_connect", {
      uid: identity.uid,
      shard: this.#currentShardName(),
      clients_connected: this.#clients.size,
    });
    this.#sendServerMessage(client, { t: "hello", ...identity });
    this.#cursorCoordinator.onClientConnected(client);

    serverSocket.addEventListener("message", (event: unknown) => {
      const payload = readBinaryMessageEventPayload(event);
      if (!payload) {
        this.#sendError(client, "bad_message", "Expected binary message payload");
        return;
      }

      const currentUid = client.uid;
      void this.#receiveClientPayload(currentUid, serverSocket, payload).catch(() => {
        this.#sendError(client, "internal", "Failed to process client payload");
      });
    });

    let closed = false;
    const closeAndCleanup = (fields: Record<string, unknown>) => {
      if (closed) {
        return;
      }
      closed = true;
      this.#logEvent("ws_close", {
        uid: client.uid,
        shard: this.#currentShardName(),
        clients_connected: Math.max(0, this.#clients.size - 1),
        ...fields,
      });
      void this.#disconnectClientIfCurrent(context, client.uid, serverSocket);
    };

    serverSocket.addEventListener("close", (event: unknown) => {
      const closeCode =
        typeof event === "object" && event !== null && "code" in event
          ? (event as { code?: unknown }).code
          : undefined;
      closeAndCleanup({
        code: typeof closeCode === "number" ? closeCode : undefined,
      });
    });
    serverSocket.addEventListener("error", () => {
      closeAndCleanup({
        code: "socket_error",
      });
    });

    return this.#upgradeResponseFactory.createResponse(clientSocket);
  }

  async #receiveClientPayload(uid: string, socket: SocketLike, payload: Uint8Array): Promise<void> {
    const client = this.#clients.get(uid);
    if (!client || client.socket !== socket) {
      return;
    }
    const context = this.#operationsContext();

    let message: ClientMessage;
    try {
      message = decodeClientMessageBinary(payload);
    } catch {
      this.#sendError(client, "bad_message", "Invalid message payload");
      this.#logEvent("bad_message", {
        uid,
      });
      return;
    }

    try {
      switch (message.t) {
        case "sub": {
          const subResult = await handleSubMessage(context, client, message.tiles);
          this.#logEvent("sub", {
            uid,
            requested_count: subResult.requestedCount,
            changed_count: subResult.changedCount,
            invalid_count: subResult.invalidCount,
            rejected_count: subResult.rejectedCount,
            subscribed_count: subResult.subscribedCount,
            clamped: subResult.clamped,
          });
          this.#cursorCoordinator.onSubscriptionsChanged(true);
          return;
        }
        case "unsub": {
          const unsubResult = await handleUnsubMessage(context, client, message.tiles);
          this.#logEvent("unsub", {
            uid,
            requested_count: unsubResult.requestedCount,
            changed_count: unsubResult.changedCount,
            subscribed_count: unsubResult.subscribedCount,
          });
          this.#cursorCoordinator.onSubscriptionsChanged(true);
          return;
        }
        case "setCell": {
          const startMs = Date.now();
          const setCellResult = await handleSetCellMessage(context, client, message);
          this.#logEvent("setCell", {
            uid,
            tile: message.tile,
            i: message.i,
            v: message.v,
            accepted: setCellResult.accepted,
            changed: setCellResult.changed,
            ...(setCellResult.reason ? { reason: setCellResult.reason } : {}),
            duration_ms: Date.now() - startMs,
          });
          this.#cursorCoordinator.onActivity();
          return;
        }
        case "resyncTile":
          await handleResyncMessage(context, client, message.tile);
          this.#logEvent("resyncTile", {
            uid,
            tile: message.tile,
          });
          return;
        case "cur":
          this.#cursorCoordinator.onLocalCursor(client, message.x, message.y);
          return;
        default:
          return;
      }
    } catch {
      this.#logEvent("internal_error", {
        uid,
      });
      this.#sendError(client, "internal", "Failed to process message");
    }
  }

  #receiveTileBatch(message: Extract<ServerMessage, { t: "cellUpBatch" }>): void {
    fanoutTileBatchToSubscribers({
      message,
      tileToClients: this.#tileToClients,
      clients: this.#clients,
      sendServerMessage: (client, batch) => {
        this.#sendServerMessage(client, batch);
      },
    });
    this.#cursorCoordinator.onActivity();
  }

  #sendServerMessage(client: ConnectedClient, message: ServerMessage): void {
    try {
      client.socket.send(encodeServerMessageBinary(message));
    } catch {
      // Ignore broken socket errors; close handler will clean up.
    }
  }

  async #watchTile(
    tileKey: string,
    action: "sub" | "unsub"
  ): Promise<{ ok: boolean; code?: string; msg?: string }> {
    const result = await this.#tileGateway.watchTile(tileKey, action);
    if (!result) {
      // Compatibility path for older gateway implementations that return void.
      return { ok: true };
    }
    return result;
  }

  async #fetchTileSnapshot(tileKey: string): Promise<Extract<ServerMessage, { t: "tileSnap" }> | null> {
    return this.#tileGateway.fetchSnapshot(tileKey);
  }

  async #setTileCell(payload: TileSetCellRequest): Promise<TileSetCellResponse | null> {
    return this.#tileGateway.setTileCell(payload);
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

  async #disconnectClientIfCurrent(
    context: ConnectionShardDOOperationsContext,
    uid: string,
    socket: SocketLike
  ): Promise<void> {
    const current = this.#clients.get(uid);
    if (!current || current.socket !== socket) {
      return;
    }

    await disconnectClientFromShard(context, uid);
    this.#cursorCoordinator.onClientDisconnected(uid);
  }

  #receiveCursorBatch(batch: CursorRelayBatch): void {
    this.#cursorCoordinator.onCursorBatch(batch);
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

  #logEvent(event: string, fields: Record<string, unknown>): void {
    logStructuredEvent("connection_shard_do", event, {
      shard: this.#currentShardName(),
      ...fields,
    });
  }
}
