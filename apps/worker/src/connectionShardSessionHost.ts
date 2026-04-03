import {
  CLIENT_BINARY_TAG,
  type ServerMessage,
} from "@sea/protocol";

import {
  isWebSocketUpgrade,
  type ClientDebugLogLevel,
  type ConnectionIdentity,
} from "./doCommon";
import {
  type ConnectedClient,
  type ConnectionShardDOOperationsContext,
} from "./connectionShardDOOperations";
import { ConnectionShardSetCellQueue } from "./connectionShardSetCellQueue";
import {
  type SocketLike,
  type SocketPairFactory,
  type WebSocketUpgradeResponseFactory,
} from "./socketPair";
import { readBinaryMessageEventPayload } from "./socketMessagePayload";

export type SetCellSuppressionReason =
  | "tile_batch_ingress_active"
  | "tile_batch_cooldown";

export interface SetCellSuppressionState {
  reason: SetCellSuppressionReason;
  delayMs: number;
}

interface ConnectionShardSessionHostOptions {
  clients: Map<string, ConnectedClient>;
  socketPairFactory: SocketPairFactory;
  upgradeResponseFactory: WebSocketUpgradeResponseFactory;
  setCellQueue: ConnectionShardSetCellQueue;
  nowMs: () => number;
  maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  logEvent: (event: string, fields: Record<string, unknown>) => void;
  createOperationsContext: () => ConnectionShardDOOperationsContext;
  resolveHelloSpawn: () => Promise<{ x: number; y: number } | null>;
  disconnectClientIfCurrent: (
    context: ConnectionShardDOOperationsContext,
    uid: string,
    socket: SocketLike
  ) => Promise<void>;
  sendServerMessage: (client: ConnectedClient, message: ServerMessage) => void;
  sendError: (
    client: ConnectedClient,
    code: string,
    msg: string,
    fields?: Record<string, unknown>
  ) => void;
  receiveClientPayload: (uid: string, socket: SocketLike, payload: Uint8Array) => Promise<void>;
  getSetCellSuppressionState: () => SetCellSuppressionState | null;
  suppressionLogFields: () => Record<string, unknown>;
  onClientConnected: (client: ConnectedClient) => void;
  onClientDisconnected: () => void;
}

export class ConnectionShardSessionHost {
  #clients: Map<string, ConnectedClient>;
  #socketPairFactory: SocketPairFactory;
  #upgradeResponseFactory: WebSocketUpgradeResponseFactory;
  #setCellQueue: ConnectionShardSetCellQueue;
  #nowMs: () => number;
  #maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  #logEvent: (event: string, fields: Record<string, unknown>) => void;
  #createOperationsContext: () => ConnectionShardDOOperationsContext;
  #resolveHelloSpawn: () => Promise<{ x: number; y: number } | null>;
  #disconnectClientIfCurrent: (
    context: ConnectionShardDOOperationsContext,
    uid: string,
    socket: SocketLike
  ) => Promise<void>;
  #sendServerMessage: (client: ConnectedClient, message: ServerMessage) => void;
  #sendError: (
    client: ConnectedClient,
    code: string,
    msg: string,
    fields?: Record<string, unknown>
  ) => void;
  #receiveClientPayload: (uid: string, socket: SocketLike, payload: Uint8Array) => Promise<void>;
  #getSetCellSuppressionState: () => SetCellSuppressionState | null;
  #suppressionLogFields: () => Record<string, unknown>;
  #onClientConnected: (client: ConnectedClient) => void;
  #onClientDisconnected: () => void;

  constructor(options: ConnectionShardSessionHostOptions) {
    this.#clients = options.clients;
    this.#socketPairFactory = options.socketPairFactory;
    this.#upgradeResponseFactory = options.upgradeResponseFactory;
    this.#setCellQueue = options.setCellQueue;
    this.#nowMs = options.nowMs;
    this.#maybeUnrefTimer = options.maybeUnrefTimer;
    this.#logEvent = options.logEvent;
    this.#createOperationsContext = options.createOperationsContext;
    this.#resolveHelloSpawn = options.resolveHelloSpawn;
    this.#disconnectClientIfCurrent = options.disconnectClientIfCurrent;
    this.#sendServerMessage = options.sendServerMessage;
    this.#sendError = options.sendError;
    this.#receiveClientPayload = options.receiveClientPayload;
    this.#getSetCellSuppressionState = options.getSetCellSuppressionState;
    this.#suppressionLogFields = options.suppressionLogFields;
    this.#onClientConnected = options.onClientConnected;
    this.#onClientDisconnected = options.onClientDisconnected;
  }

  parseConnectParams(url: URL): { identity: ConnectionIdentity; shardName: string } | null {
    const uid = url.searchParams.get("uid");
    const name = url.searchParams.get("name");
    const token = url.searchParams.get("token");
    const shardName = url.searchParams.get("shard");
    if (!uid || !name || !token || !shardName) {
      return null;
    }

    const clientSessionId = this.#resolveClientSessionId(url);

    return {
      identity: {
        uid,
        name,
        token,
        ...(clientSessionId ? { clientSessionId } : {}),
        ...this.#resolveClientDebugLog(url),
      },
      shardName,
    };
  }

  #resolveClientSessionId(url: URL): string | undefined {
    const clientSessionId = url.searchParams.get("clientSessionId")?.trim() ?? "";
    return clientSessionId.length > 0 ? clientSessionId : undefined;
  }

  #resolveClientDebugLog(
    url: URL
  ): { clientDebugLogLevel?: ClientDebugLogLevel; clientDebugLogExpiresAtMs?: number } {
    const levelRaw = url.searchParams.get("debugLogs")?.trim().toLowerCase() ?? "";
    const level =
      levelRaw === "reduced" || levelRaw === "verbose"
        ? (levelRaw as ClientDebugLogLevel)
        : undefined;
    const rawExpiresAtMs = url.searchParams.get("debugLogsExpiresAtMs")?.trim() ?? "";
    const expiresAtMs = Number.parseInt(rawExpiresAtMs, 10);
    if (!level || !Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
      return {};
    }
    return {
      clientDebugLogLevel: level,
      clientDebugLogExpiresAtMs: expiresAtMs,
    };
  }

  async replaceExistingClient(
    identity: ConnectionIdentity,
    context: ConnectionShardDOOperationsContext
  ): Promise<void> {
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

  async handleWebSocketConnect(
    request: Request,
    url: URL,
    setShardName: (shardName: string) => void
  ): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    const connectParams = this.parseConnectParams(url);
    if (!connectParams) {
      return new Response("Missing uid/name/token", { status: 400 });
    }
    const { identity, shardName } = connectParams;

    setShardName(shardName);

    const pair = this.#socketPairFactory.createPair();
    const clientSocket = pair.client;
    const serverSocket = pair.server;

    serverSocket.accept();
    const context = this.#createOperationsContext();
    await this.replaceExistingClient(identity, context);

    const client: ConnectedClient = {
      uid: identity.uid,
      name: identity.name,
      ...(identity.clientSessionId ? { clientSessionId: identity.clientSessionId } : {}),
      ...(identity.clientDebugLogLevel ? { clientDebugLogLevel: identity.clientDebugLogLevel } : {}),
      ...(typeof identity.clientDebugLogExpiresAtMs === "number"
        ? { clientDebugLogExpiresAtMs: identity.clientDebugLogExpiresAtMs }
        : {}),
      socket: serverSocket,
      connectedAtMs: this.#nowMs(),
      subscribed: new Set(),
      churnTimestamps: [],
      setCellBurstTimestamps: [],
      setCellSustainedTimestamps: [],
      lastCursorX: null,
      lastCursorY: null,
      cursorSubscriptions: new Set(),
    };

    this.#clients.set(identity.uid, client);
    this.#logEvent("ws_connect", {
      uid: identity.uid,
      ...this.#clientLogFields(client),
      clients_connected: this.#clients.size,
    });
    const spawn = await this.#resolveHelloSpawn();
    this.#sendServerMessage(client, {
      t: "hello",
      ...identity,
      ...(spawn ? { spawn } : {}),
    });
    this.#onClientConnected(client);

    serverSocket.addEventListener("message", (event: unknown) => {
      const payload = readBinaryMessageEventPayload(event);
      if (!payload) {
        this.#sendError(client, "bad_message", "Expected binary message payload");
        return;
      }

      this.dispatchClientPayload(client.uid, serverSocket, payload, client);
    });

    let closed = false;
    const closeAndCleanup = (fields: Record<string, unknown>) => {
      if (closed) {
        return;
      }
      closed = true;
      this.#logEvent("ws_close", {
        uid: client.uid,
        ...this.#clientLogFields(client),
        clients_connected: Math.max(0, this.#clients.size - 1),
        ...fields,
      });
      void this.#disconnectClientIfCurrent(context, client.uid, serverSocket)
        .finally(() => this.#onClientDisconnected());
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

  async receiveClientPayload(uid: string, socket: SocketLike, payload: Uint8Array): Promise<void> {
    const current = this.#clients.get(uid);
    if (!current || current.socket !== socket) {
      return;
    }

    await this.#receiveClientPayload(uid, socket, payload);
  }

  async enqueueSetCellPayload(
    uid: string,
    socket: SocketLike,
    payload: Uint8Array,
    client: ConnectedClient
  ): Promise<void> {
    await this.#setCellQueue.enqueue(uid, async () => {
      const suppressionReason = await this.waitForSetCellSuppressionWindow(uid, socket);
      if (suppressionReason) {
        this.#logEvent("setcell_suppressed", {
          uid: client.uid,
          ...this.#clientLogFields(client),
          reason: suppressionReason,
          ...this.#suppressionLogFields(),
        });
      }
      await this.#receiveClientPayload(uid, socket, payload);
    });
  }

  dispatchClientPayload(
    uid: string,
    socket: SocketLike,
    payload: Uint8Array,
    client: ConnectedClient
  ): void {
    if (payload[0] === CLIENT_BINARY_TAG.setCell) {
      this.#deferClientSetCellTask(async () => {
        try {
          await this.enqueueSetCellPayload(uid, socket, payload, client);
        } catch {
          this.#sendError(client, "internal", "Failed to process client payload");
        }
      });
      return;
    }

    void this.receiveClientPayload(uid, socket, payload).catch(() => {
      this.#sendError(client, "internal", "Failed to process client payload");
    });
  }

  isSetCellBinaryPayload(payload: Uint8Array): boolean {
    return payload[0] === CLIENT_BINARY_TAG.setCell;
  }

  canRelayCursorNow(): boolean {
    return this.#getSetCellSuppressionState() === null;
  }

  async waitForSetCellSuppressionWindow(
    uid: string,
    socket: SocketLike
  ): Promise<SetCellSuppressionReason | null> {
    let suppressionReason: SetCellSuppressionReason | null = null;
    while (true) {
      const suppression = this.#getSetCellSuppressionState();
      if (!suppression) {
        return suppressionReason;
      }

      suppressionReason = suppression.reason;
      await this.sleep(suppression.delayMs);

      const current = this.#clients.get(uid);
      if (!current || current.socket !== socket) {
        return suppressionReason;
      }
    }
  }

  setCellSuppressionState(): SetCellSuppressionState | null {
    return this.#getSetCellSuppressionState();
  }

  clearQueuedSetCellPayloads(uid: string): void {
    this.#setCellQueue.clear(uid);
  }

  async sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), Math.max(1, delayMs));
      this.#maybeUnrefTimer(timer);
    });
  }

  sendServerMessage(client: ConnectedClient, message: ServerMessage): void {
    try {
      client.socket.send(message as unknown as Uint8Array);
    } catch {
      // Ignore broken socket errors; close handler will clean up.
    }
  }

  #deferClientSetCellTask(task: () => Promise<unknown>): void {
    const timer = setTimeout(() => {
      void task().catch(() => {});
    }, 0);
    this.#maybeUnrefTimer(timer);
  }

  #clientLogFields(client: ConnectedClient): Record<string, unknown> {
    this.#maybeLogExpiredDebugOverride(client);
    return this.#buildClientLogFields(client, true);
  }

  #buildClientLogFields(client: ConnectedClient, includeActiveOverride: boolean): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      ...(client.clientSessionId ? { client_session_id: client.clientSessionId } : {}),
    };
    if (
      includeActiveOverride
      && client.clientDebugLogLevel
      && typeof client.clientDebugLogExpiresAtMs === "number"
      && client.clientDebugLogExpiresAtMs > this.#nowMs()
    ) {
      fields.client_debug_log_level = client.clientDebugLogLevel;
      fields.client_debug_log_expires_at_ms = client.clientDebugLogExpiresAtMs;
    }
    return fields;
  }

  #maybeLogExpiredDebugOverride(client: ConnectedClient): void {
    if (
      !client.clientDebugLogLevel
      || typeof client.clientDebugLogExpiresAtMs !== "number"
      || client.clientDebugLogExpiresAtMs > this.#nowMs()
      || client.clientDebugLogExpiryLogged
    ) {
      return;
    }

    client.clientDebugLogExpiryLogged = true;
    this.#logEvent("log_override_expired", {
      uid: client.uid,
      ...this.#buildClientLogFields(client, false),
      expired_level: client.clientDebugLogLevel,
      expired_at_ms: client.clientDebugLogExpiresAtMs,
    });
  }
}
