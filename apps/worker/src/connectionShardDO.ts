import {
  decodeClientMessageBinary,
  encodeServerMessageBinary,
  type ClientMessage,
  type ServerMessage,
} from "@sea/protocol";

import {
  type DurableObjectStateLike,
  type Env,
} from "./doCommon";
import {
  disconnectClientFromShard,
  type ConnectedClient,
  type ConnectionShardDOOperationsContext,
} from "./connectionShardDOOperations";
import { handleConnectionShardClientMessage } from "./connectionShardClientMessageHandler";
import { ConnectionShardSetCellQueue } from "./connectionShardSetCellQueue";
import { resolveCursorErrorTraceContext } from "./connectionShardCursorTrace";
import { ConnectionShardCursorHubGateway } from "./cursorHubGateway";
import { ConnectionShardCursorRuntime } from "./connectionShardCursorRuntime";
import { ConnectionShardSessionHost } from "./connectionShardSessionHost";
import { ConnectionShardTileRuntime } from "./connectionShardTileRuntime";
import { ConnectionShardTileGateway } from "./connectionShardTileGateway";
import {
  createCloudflareUpgradeResponseFactory,
  createRuntimeSocketPairFactory,
  type SocketLike,
  type SocketPairFactory,
  type WebSocketUpgradeResponseFactory,
} from "./socketPair";
import { elapsedMs, logStructuredEvent } from "./observability";
import { resolveWorkerRuntimeControls } from "./runtimeControls";

const CURSOR_HUB_NAME = "global";

export class ConnectionShardDO {
  #state: DurableObjectStateLike;
  #env: Env;
  #shardName: string | null;
  #clients: Map<string, ConnectedClient>;
  #tileToClients: Map<string, Set<string>>;
  #sessionHost: ConnectionShardSessionHost;
  #tileRuntime: ConnectionShardTileRuntime;
  #cursorRuntime: ConnectionShardCursorRuntime;

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

    const cursorHubGateway = this.#env.CURSOR_HUB
      ? new ConnectionShardCursorHubGateway({
          namespace: this.#env.CURSOR_HUB,
          hubName: CURSOR_HUB_NAME,
        })
      : null;
    const socketPairFactory = options.socketPairFactory ?? createRuntimeSocketPairFactory();
    const upgradeResponseFactory =
      options.upgradeResponseFactory ?? createCloudflareUpgradeResponseFactory();
    const setCellQueue = new ConnectionShardSetCellQueue();

    this.#tileRuntime = new ConnectionShardTileRuntime({
      clients: this.#clients,
      tileToClients: this.#tileToClients,
      gateway: new ConnectionShardTileGateway({
        tileOwnerNamespace: this.#env.TILE_OWNER,
        getCurrentShardName: () => this.#currentShardName(),
      }),
      sendServerMessage: (client, message) => {
        this.#sendServerMessage(client, message);
      },
      logEvent: (event, fields) => this.#logEvent(event, fields),
      nowMs: () => this.#nowMs(),
      maybeUnrefTimer: (timer) => this.#maybeUnrefTimer(timer),
      onTileActivity: () => {
        this.#cursorRuntime.onActivity();
      },
    });

    this.#cursorRuntime = new ConnectionShardCursorRuntime({
      clients: this.#clients,
      currentShardName: () => this.#currentShardName(),
      nowMs: () => this.#nowMs(),
      deferDetachedTask: (task) => this.#deferDetachedTask(task),
      maybeUnrefTimer: (timer) => this.#maybeUnrefTimer(timer),
      canRelayCursorNow: () => this.#canRelayCursorNow(),
      tileBatchIngressDepth: () => this.#tileRuntime.tileBatchIngressDepth(),
      setCellSuppressedUntilMs: () => this.#tileRuntime.setCellSuppressedUntilMs(),
      sendServerMessage: (client, message) => this.#sendServerMessage(client, message),
      logEvent: (event, fields) => this.#logEvent(event, fields),
      ...(this.#state.storage.setAlarm
        ? { setAlarm: (scheduledTime: number) => this.#state.storage.setAlarm!(scheduledTime) }
        : {}),
      ...(this.#state.storage.deleteAlarm
        ? { deleteAlarm: () => this.#state.storage.deleteAlarm!() }
        : {}),
      cursorHubGateway,
      getPeerShardStub: (peerShard) => this.#env.CONNECTION_SHARD.getByName(peerShard),
      relayEnabled: false,
    });

    this.#sessionHost = new ConnectionShardSessionHost({
      clients: this.#clients,
      socketPairFactory,
      upgradeResponseFactory,
      setCellQueue,
      nowMs: () => this.#nowMs(),
      maybeUnrefTimer: (timer) => this.#maybeUnrefTimer(timer),
      logEvent: (event, fields) => this.#logEvent(event, fields),
      createOperationsContext: () => this.#operationsContext(),
      resolveHelloSpawn: async () => this.#cursorRuntime.resolveHelloSpawn(),
      disconnectClientIfCurrent: async (context, uid, socket) => {
        await this.#disconnectClientIfCurrent(context, uid, socket);
      },
      sendServerMessage: (client, message) => {
        this.#sendServerMessage(client, message);
      },
      sendError: (client, code, msg, fields = {}) => {
        this.#sendError(client, code, msg, fields);
      },
      receiveClientPayload: async (uid, socket, payload) => {
        await this.#receiveClientPayload(uid, socket, payload);
      },
      getSetCellSuppressionState: () => this.#tileRuntime.setCellSuppressionState(),
      suppressionLogFields: () => ({
        tile_batch_ingress_depth: this.#tileRuntime.tileBatchIngressDepth(),
      }),
      onClientConnected: (client) => {
        this.#cursorRuntime.onClientConnected(client);
      },
      onClientDisconnected: () => {
        this.#cursorRuntime.refreshCursorPullSchedule();
        this.#cursorRuntime.refreshWatchState();
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const runtime = resolveWorkerRuntimeControls(this.#env);

    if (runtime.unavailableReason) {
      return new Response("Service unavailable", { status: 503 });
    }

    if (url.pathname === "/ws") {
      return this.#sessionHost.handleWebSocketConnect(request, url, (shardName) => {
        this.#shardName = shardName;
      });
    }

    if (url.pathname === "/tile-batch" && request.method === "POST") {
      return this.#tileRuntime.handleTileBatchRequest(request);
    }

    const cursorResponse = await this.#cursorRuntime.handleRequest(request);
    if (cursorResponse) {
      return cursorResponse;
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.#cursorRuntime.alarm();
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
        ...(client.clientSessionId ? { client_session_id: client.clientSessionId } : {}),
      });
      return;
    }

    try {
      await handleConnectionShardClientMessage({
        context,
        client,
        uid,
        message,
        logEvent: (event, fields) => {
          this.#logEvent(event, {
            ...(client.clientSessionId ? { client_session_id: client.clientSessionId } : {}),
            ...fields,
          });
        },
        recordTileVersion: (tileKey, ver) => {
          this.#tileRuntime.recordTileVersion(tileKey, ver);
        },
        receiveTileBatch: (serverMessage) => {
          this.#tileRuntime.receiveTileBatch(serverMessage);
        },
        recordRecentEditActivity: (tileKey, index) => {
          this.#cursorRuntime.recordRecentEditActivity(tileKey, index);
        },
        cursorOnActivity: () => {
          this.#cursorRuntime.onActivity();
        },
        cursorOnSubscriptionsChanged: (force) => {
          this.#cursorRuntime.onSubscriptionsChanged(force);
        },
        refreshTilePullSchedule: () => {
          this.#tileRuntime.refreshTilePullSchedule();
        },
        markCursorPullActive: () => {
          this.#cursorRuntime.markCursorPullActive();
        },
        cursorOnLocalCursor: (connectedClient, x, y) => {
          this.#cursorRuntime.onLocalCursor(connectedClient, x, y);
        },
        elapsedMs,
      });
    } catch (error) {
      const traceContext = resolveCursorErrorTraceContext({
        code: "internal",
        activeTrace: this.#cursorRuntime.traceState.activeTraceContext(),
        traceOrigin: this.#currentShardName(),
      });
      this.#logEvent("internal_error", {
        uid,
        ...(client.clientSessionId ? { client_session_id: client.clientSessionId } : {}),
        ...this.#cursorRuntime.traceState.traceFields(traceContext),
        ...this.#errorFields(error),
      });
      this.#sendError(
        client,
        "internal",
        "Failed to process message",
        this.#cursorRuntime.traceState.traceFields(traceContext)
      );
    }
  }

  #canRelayCursorNow(): boolean {
    return this.#tileRuntime.tileBatchIngressDepth() === 0
      && this.#nowMs() >= this.#tileRuntime.setCellSuppressedUntilMs();
  }

  #sendServerMessage(client: ConnectedClient, message: ServerMessage): void {
    try {
      client.socket.send(encodeServerMessageBinary(message));
    } catch {
      // Ignore broken socket errors; close handler will clean up.
    }
  }

  #sendBadTile(client: ConnectedClient, tileKey: string, fields: Record<string, unknown> = {}): void {
    this.#sendError(client, "bad_tile", `Invalid tile key ${tileKey}`, {
      tile: tileKey,
      ...fields,
    });
  }

  #sendError(
    client: ConnectedClient,
    code: string,
    msg: string,
    fields: Record<string, unknown> = {}
  ): void {
    const activeTrace = resolveCursorErrorTraceContext({
      code,
      fields,
      activeTrace: this.#cursorRuntime.traceState.activeTraceContext(),
      traceOrigin: this.#currentShardName(),
    });
    this.#logEvent("server_error_sent", {
      uid: client.uid,
      ...(client.clientSessionId ? { client_session_id: client.clientSessionId } : {}),
      code,
      msg,
      ...this.#cursorRuntime.traceState.traceFields(activeTrace),
      ...fields,
    });
    this.#sendServerMessage(client, {
      t: "err",
      code,
      msg,
      ...(activeTrace ? { trace: activeTrace.traceId } : {}),
    });
  }

  #currentShardName(): string {
    return this.#shardName ?? this.#state.id.toString();
  }

  #nowMs(): number {
    return Date.now();
  }

  #deferDetachedTask(task: () => Promise<unknown>): void {
    const timer = setTimeout(() => {
      void task().catch(() => {});
    }, 0);
    this.#maybeUnrefTimer(timer);
  }

  #maybeUnrefTimer(timer: ReturnType<typeof setTimeout>): void {
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") {
      unref.call(timer);
    }
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
    this.#sessionHost.clearQueuedSetCellPayloads(uid);
    this.#cursorRuntime.onClientDisconnected(uid);
    this.#tileRuntime.refreshTilePullSchedule();
  }

  #operationsContext(): ConnectionShardDOOperationsContext {
    const runtime = resolveWorkerRuntimeControls(this.#env);
    return {
      clients: this.#clients,
      tileToClients: this.#tileToClients,
      ...(runtime.readOnlyMode ? { readOnlyMode: true } : {}),
      shardName: () => this.#currentShardName(),
      sendServerMessage: (client, message) => {
        this.#sendServerMessage(client, message);
      },
      sendError: (client, code, msg, fields) => {
        this.#sendError(client, code, msg, fields);
      },
      sendBadTile: (client, tileKey, fields) => {
        this.#sendBadTile(client, tileKey, fields);
      },
      watchTile: (tileKey, action) => this.#tileRuntime.watchTile(tileKey, action),
      setTileCell: (payload) => this.#tileRuntime.setTileCell(payload),
      sendSnapshotToClient: (client, tileKey) => this.#tileRuntime.sendSnapshotToClient(client, tileKey),
      nowMs: () => this.#nowMs(),
    };
  }

  #logEvent(event: string, fields: Record<string, unknown>): void {
    logStructuredEvent("connection_shard_do", event, {
      shard: this.#currentShardName(),
      ...fields,
    }, {
      mode: this.#env.WORKER_LOG_MODE,
    });
  }

  #errorFields(
    error: unknown,
    options: { includeStack?: boolean } = {}
  ): { error_name?: string; error_message?: string; error_stack?: string; error_type?: string } {
    if (typeof error === "string") {
      return {
        error_type: "string",
        error_message: error.slice(0, 240),
      };
    }

    if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
      return {
        error_type: typeof error,
        error_message: String(error).slice(0, 240),
      };
    }

    if (typeof error === "undefined") {
      return {
        error_type: "undefined",
      };
    }

    if (typeof error !== "object" || error === null) {
      return {
        error_type: typeof error,
      };
    }

    const name = "name" in error && typeof error.name === "string" ? error.name : undefined;
    const message =
      "message" in error && typeof error.message === "string"
        ? error.message.slice(0, 240)
        : String(error).slice(0, 240);
    const stack = options.includeStack
      && "stack" in error
      && typeof error.stack === "string"
      && error.stack.length > 0
      ? error.stack.slice(0, 4000)
      : undefined;

    return {
      error_type: Array.isArray(error) ? "array" : "object",
      ...(name ? { error_name: name } : {}),
      ...(message ? { error_message: message } : {}),
      ...(stack ? { error_stack: stack } : {}),
    };
  }
}
