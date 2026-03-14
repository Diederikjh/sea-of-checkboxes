import {
  parseTileKeyStrict,
  worldFromTileCell,
} from "@sea/domain";
import {
  CLIENT_BINARY_TAG,
  decodeClientMessageBinary,
  encodeServerMessageBinary,
  type ClientMessage,
  type ServerMessage,
} from "@sea/protocol";

import {
  isWebSocketUpgrade,
  jsonResponse,
  readJson,
  type ConnectionIdentity,
  type DurableObjectStateLike,
  type Env,
  type TileSetCellRequest,
  type TileSetCellResponse,
} from "./doCommon";
import {
  disconnectClientFromShard,
  type ConnectedClient,
  type ConnectionShardDOOperationsContext,
} from "./connectionShardDOOperations";
import {
  CURSOR_HUB_SOURCE_HEADER,
  handleConnectionShardCursorBatchIngress,
} from "./connectionShardCursorBatchIngress";
import { handleConnectionShardClientMessage } from "./connectionShardClientMessageHandler";
import { ConnectionShardSetCellQueue } from "./connectionShardSetCellQueue";
import {
  buildCursorFirstLocalPublishLogFields,
  buildCursorLocalPublishLogFields,
} from "./connectionShardCursorLogFields";
import {
  cursorRelayBatchMaxSeq,
  type CursorRelayBatch,
  type CursorTraceContext,
  isValidCursorRelayBatch,
} from "./cursorRelay";
import { ConnectionShardTileBatchOrderTracker } from "./connectionShardTileBatchOrder";
import { CursorCoordinator } from "./cursorCoordinator";
import { ConnectionShardTileGateway } from "./connectionShardTileGateway";
import {
  createCursorTraceId,
  resolveCursorErrorTraceContext,
  CURSOR_TRACE_HOP_HEADER,
  CURSOR_TRACE_ID_HEADER,
  CURSOR_TRACE_ORIGIN_HEADER,
  ConnectionShardCursorTraceState,
} from "./connectionShardCursorTrace";
import {
  CURSOR_HUB_WATCH_TIMING,
  CURSOR_PULL_TIMING,
  defaultCursorHubSettleRenewMs,
} from "./cursorTimingConfig";
import {
  type CursorPullWakeReason,
} from "./connectionShardCursorPullScheduler";
import { ConnectionShardCursorPullOrchestrator } from "./connectionShardCursorPullOrchestrator";
import { ConnectionShardCursorHubGateway } from "./cursorHubGateway";
import { ConnectionShardCursorHubController } from "./connectionShardCursorHubController";
import { peerShardNames } from "./sharding";
import {
  createCloudflareUpgradeResponseFactory,
  createRuntimeSocketPairFactory,
  type SocketLike,
  type SocketPairFactory,
  type WebSocketUpgradeResponseFactory,
} from "./socketPair";
import { readBinaryMessageEventPayload } from "./socketMessagePayload";
import { fanoutTileBatchToSubscribers } from "./tileBatchFanout";
import {
  elapsedMs,
  logStructuredEvent,
} from "./observability";

const TILE_BATCH_TRACE_ID_HEADER = "x-sea-trace-id";
const TILE_BATCH_TRACE_HOP_HEADER = "x-sea-trace-hop";
const TILE_BATCH_TRACE_ORIGIN_HEADER = "x-sea-trace-origin";
const TILE_BATCH_SETCELL_SUPPRESSION_MS = 120;
const TILE_BATCH_SETCELL_RETRY_MS = 20;
const TILE_PULL_INTERVAL_MIN_MS = 200;
const TILE_PULL_INTERVAL_MAX_MS = 1000;
const TILE_PULL_INTERVAL_BACKOFF_STEP_MS = 200;
const TILE_PULL_INTERVAL_IDLE_MAX_MS = 10_000;
const TILE_PULL_INTERVAL_IDLE_BACKOFF_STEP_MS = 1_000;
const TILE_PULL_IDLE_STREAK_BEFORE_LONG_BACKOFF = 5;
const TILE_PULL_PAGE_LIMIT = 256;
const TILE_PULL_MAX_PAGES_PER_TICK = 4;
const CURSOR_HUB_NAME = "global";
const CURSOR_BATCH_HUB_PUBLISH_SUPPRESSION_MS = 300;
const CURSOR_BATCH_TRACE_MAX_HOP = 1;

type SetCellSuppressionReason =
  | "tile_batch_ingress_active"
  | "tile_batch_cooldown";

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
  #tileBatchOrderTracker: ConnectionShardTileBatchOrderTracker;
  #setCellQueue: ConnectionShardSetCellQueue;
  #cursorBatchIngressDepth: number;
  #tileBatchIngressDepth: number;
  #setCellSuppressedUntilMs: number;
  #tileKnownVersionByTile: Map<string, number>;
  #tilePullInFlight: Set<string>;
  #tilePullTimer: ReturnType<typeof setTimeout> | null;
  #tilePullIntervalMs: number;
  #tilePullQuietStreak: number;
  #cursorPullOrchestrator: ConnectionShardCursorPullOrchestrator;
  #cursorStateIngressDepth: number;
  #cursorHubPublishSuppressedUntilMs: number;
  #cursorHubGateway: ConnectionShardCursorHubGateway | null;
  #cursorHubController: ConnectionShardCursorHubController;
  #cursorTraceState: ConnectionShardCursorTraceState;

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
    this.#cursorBatchIngressDepth = 0;
    this.#tileBatchIngressDepth = 0;
    this.#setCellSuppressedUntilMs = 0;
    this.#tileKnownVersionByTile = new Map();
    this.#tilePullInFlight = new Set();
    this.#tilePullTimer = null;
    this.#tilePullIntervalMs = TILE_PULL_INTERVAL_MAX_MS;
    this.#tilePullQuietStreak = 0;
    this.#cursorStateIngressDepth = 0;
    this.#cursorHubPublishSuppressedUntilMs = 0;
    this.#cursorTraceState = new ConnectionShardCursorTraceState({
      nowMs: () => this.#nowMs(),
    });
    const cursorHubGateway = this.#env.CURSOR_HUB
      ? new ConnectionShardCursorHubGateway({
          namespace: this.#env.CURSOR_HUB,
          hubName: CURSOR_HUB_NAME,
        })
      : null;
    this.#cursorHubGateway = cursorHubGateway;
    this.#socketPairFactory = options.socketPairFactory ?? createRuntimeSocketPairFactory();
    this.#upgradeResponseFactory =
      options.upgradeResponseFactory ?? createCloudflareUpgradeResponseFactory();
    this.#cursorPullOrchestrator = new ConnectionShardCursorPullOrchestrator({
      nowMs: () => this.#nowMs(),
      hasClients: () => this.#clients.size > 0,
      ingressDepth: () => this.#cursorStateIngressDepth,
      deferDetachedTask: (task) => this.#deferDetachedTask(task),
      maybeUnrefTimer: (timer) => this.#maybeUnrefTimer(timer),
      setAlarm: this.#state.storage.setAlarm?.bind(this.#state.storage),
      deleteAlarm: this.#state.storage.deleteAlarm?.bind(this.#state.storage),
      runAlarmFallback: async () => {
        await this.alarm();
      },
      pollPeerCursorStates: async (wakeReason) => this.#pollPeerCursorStates(wakeReason),
      logEvent: (event, fields) => this.#logEvent(event, fields),
    });
    this.#cursorCoordinator = new CursorCoordinator({
      clients: this.#clients,
      getCurrentShardName: () => this.#currentShardName(),
      defer: (task) => {
        void task().catch(() => {});
      },
      clock: {
        nowMs: () => this.#nowMs(),
      },
      shardTopology: {
        peerShardNames: (currentShard) => this.#peerShardNames(currentShard),
      },
      cursorRelayTransport: {
        relayCursorBatch: async () => {},
      },
      canRelayNow: () => this.#canRelayCursorNow(),
      onRelaySuppressed: ({ droppedCount, reason }) => {
        this.#logEvent("cursor_relay_suppressed", {
          dropped_count: droppedCount,
          reason,
          cursor_batch_ingress_depth: this.#cursorBatchIngressDepth,
          tile_batch_ingress_depth: this.#tileBatchIngressDepth,
          setcell_suppressed_remaining_ms: Math.max(0, this.#setCellSuppressedUntilMs - this.#nowMs()),
        });
      },
      onLocalCursorPublished: ({ cursor, fanoutCount }) => {
        const client = this.#clients.get(cursor.uid);
        const connectionAgeMs = typeof client?.connectedAtMs === "number"
          ? Math.max(0, this.#nowMs() - client.connectedAtMs)
          : undefined;
        if (cursor.seq === 1) {
          this.#logEvent(
            "cursor_first_local_publish",
            buildCursorFirstLocalPublishLogFields({
              client,
              connectionAgeMs,
              cursor,
              fanoutCount,
            })
          );
        }
        this.#logEvent(
          "cursor_local_publish",
          buildCursorLocalPublishLogFields({
            client,
            connectionAgeMs,
            cursor,
            fanoutCount,
          })
        );
      },
      onRemoteCursorIngested: ({ fromShard, cursor, previousSeq, fanoutCount, applied, ignoredReason }) => {
        this.#logEvent("cursor_remote_ingest", {
          from_shard: fromShard,
          uid: cursor.uid,
          previous_seq: previousSeq ?? undefined,
          next_seq: cursor.seq,
          tile: cursor.tileKey,
          fanout_count: fanoutCount,
          applied,
          ignored_reason: ignoredReason,
          ...this.#cursorTraceState.traceFields(this.#cursorTraceState.activeTraceContext()),
        });
      },
      sendServerMessage: (client, message) => {
        this.#sendServerMessage(client, message);
      },
      relayEnabled: false,
    });
    this.#tileGateway = new ConnectionShardTileGateway({
      tileOwnerNamespace: this.#env.TILE_OWNER,
      getCurrentShardName: () => this.#currentShardName(),
    });
    this.#tileBatchOrderTracker = new ConnectionShardTileBatchOrderTracker();
    this.#setCellQueue = new ConnectionShardSetCellQueue();
    this.#cursorHubController = new ConnectionShardCursorHubController({
      gateway: cursorHubGateway,
      hasClients: () => this.#clients.size > 0,
      currentShardName: () => this.#currentShardName(),
      ingestBatch: (batch) => this.#ingestCursorBatchWithIngress(batch),
      updateWatchedPeerShards: (peerShards) => this.#updateCursorPullPeerShards(peerShards),
      deferDetachedTask: (task) => this.#deferDetachedTask(task),
      maybeUnrefTimer: (timer) => this.#maybeUnrefTimer(timer),
      watchRenewMs: CURSOR_HUB_WATCH_TIMING.renewMs,
      watchProbeRenewMs: CURSOR_HUB_WATCH_TIMING.probeRenewMs,
      watchSettleRenewMs: defaultCursorHubSettleRenewMs(),
      watchSettleWindowMs: CURSOR_HUB_WATCH_TIMING.settleWindowMs,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return this.#handleWebSocketConnect(request, url);
    }

    if (url.pathname === "/tile-batch" && request.method === "POST") {
      const traceId = this.#tileBatchTraceIdFromRequest(request);
      const traceHop = this.#tileBatchTraceHopFromRequest(request);
      const traceOrigin = request.headers.get(TILE_BATCH_TRACE_ORIGIN_HEADER);

      if (traceHop !== null && traceHop > 1) {
        this.#logEvent("tile_batch_loop_guard_drop", {
          trace_id: traceId ?? undefined,
          trace_hop: traceHop,
          trace_origin: traceOrigin ?? undefined,
          path: "/tile-batch",
        });
        return new Response(null, { status: 204 });
      }

      if (traceId || traceHop !== null) {
        this.#logEvent("tile_batch_ingress", {
          trace_id: traceId ?? undefined,
          trace_hop: traceHop ?? undefined,
          trace_origin: traceOrigin ?? undefined,
          path: "/tile-batch",
        });
      }

      const batch = await readJson<Extract<ServerMessage, { t: "cellUpBatch" }>>(request);
      if (!batch || batch.t !== "cellUpBatch") {
        return new Response("Invalid tile batch payload", { status: 400 });
      }

      const localSubscriberCount = this.#localTileSubscriberCount(batch.tile);
      if (localSubscriberCount === 0) {
        this.#logEvent("tile_batch_no_local_subscribers", {
          tile: batch.tile,
          trace_id: traceId ?? undefined,
          trace_hop: traceHop ?? undefined,
          trace_origin: traceOrigin ?? undefined,
          path: "/tile-batch",
        });
        return new Response(null, { status: 410 });
      }

      this.#tileBatchIngressDepth += 1;
      try {
        this.#receiveTileBatch(batch);
      } finally {
        this.#tileBatchIngressDepth = Math.max(0, this.#tileBatchIngressDepth - 1);
        this.#setCellSuppressedUntilMs = Math.max(
          this.#setCellSuppressedUntilMs,
          this.#nowMs() + TILE_BATCH_SETCELL_SUPPRESSION_MS
        );
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/cursor-batch" && request.method === "POST") {
      return handleConnectionShardCursorBatchIngress({
        request,
        traceState: this.#cursorTraceState,
        currentIngressDepth: () => this.#cursorBatchIngressDepth,
        setIngressDepth: (depth) => {
          this.#cursorBatchIngressDepth = depth;
        },
        nowMs: () => this.#nowMs(),
        maxTraceHop: CURSOR_BATCH_TRACE_MAX_HOP,
        publishSuppressionMs: CURSOR_BATCH_HUB_PUBLISH_SUPPRESSION_MS,
        extendPublishSuppressedUntil: (untilMs) => {
          this.#cursorHubPublishSuppressedUntilMs = Math.max(
            this.#cursorHubPublishSuppressedUntilMs,
            untilMs
          );
        },
        readBatch: (incomingRequest) => readJson<CursorRelayBatch>(incomingRequest),
        receiveBatch: (batch) => {
          this.#receiveCursorBatch(batch);
        },
        logEvent: (event, fields) => {
          this.#logEvent(event, fields);
        },
      });
    }

    if (url.pathname === "/cursor-state" && request.method === "GET") {
      const isInboundCursorPull = request.headers.get("x-sea-cursor-pull") === "1";
      const pullTrace = this.#cursorTraceState.readFromRequest(request);
      const previousTrace = this.#cursorTraceState.pushActiveTrace(pullTrace);
      this.#cursorStateIngressDepth += 1;
      try {
        const updates = this.#cursorCoordinator.localCursorSnapshot();
        this.#logEvent("cursor_state_snapshot_served", {
          from_shard: this.#currentShardName(),
          update_count: updates.length,
          max_seq: this.#cursorSnapshotMaxSeq(updates) || undefined,
          uid_sample: this.#cursorSnapshotUidSample(updates),
          is_inbound_cursor_pull: isInboundCursorPull,
          ...this.#cursorTraceState.traceFields(pullTrace),
        });
        return jsonResponse({
          from: this.#currentShardName(),
          updates,
        } satisfies CursorRelayBatch);
      } finally {
        this.#cursorStateIngressDepth = Math.max(0, this.#cursorStateIngressDepth - 1);
        this.#cursorTraceState.restoreActiveTrace(previousTrace);
        if (this.#cursorStateIngressDepth === 0) {
          this.#cursorPullOrchestrator.flushAfterIngressExited();
        }
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    let wake:
      | {
        wakeReason: CursorPullWakeReason;
        scheduledAtMs: number | null;
      }
      | null = null;
    let failureStage = "consume_wake";
    try {
      wake = this.#cursorPullOrchestrator.consumeAlarmWake();
      if (!wake) {
        this.#logEvent("cursor_pull_alarm_stale", {
          ...this.#cursorPullOrchestrator.alarmStateFields(),
        });
        return;
      }
      if (wake.wakeReason === "watch_scope_change") {
        failureStage = "log_watch_scope_change";
        this.#logEvent("cursor_pull_alarm_fired", {
          ...this.#cursorPullOrchestrator.alarmStateFields({
            wake_reason: wake.wakeReason,
            scheduled_at_ms: wake.scheduledAtMs ?? undefined,
          }),
        });
      }
      failureStage = "run_tick";
      await this.#cursorPullOrchestrator.runTick(wake.wakeReason);
    } catch (error) {
      this.#logEvent("cursor_pull_alarm_failed", {
        ...this.#cursorPullOrchestrator.alarmStateFields({
          wake_reason: wake?.wakeReason ?? undefined,
          scheduled_at_ms: wake?.scheduledAtMs ?? undefined,
        }),
        failure_stage: failureStage,
        ...this.#errorFields(error, { includeStack: true }),
      });
      throw error;
    }
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
      ...(identity.clientSessionId ? { clientSessionId: identity.clientSessionId } : {}),
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
      ...(client.clientSessionId ? { client_session_id: client.clientSessionId } : {}),
      clients_connected: this.#clients.size,
    });
    const spawn = await this.#resolveHelloSpawn();
    this.#sendServerMessage(client, {
      t: "hello",
      ...identity,
      ...(spawn ? { spawn } : {}),
    });
    this.#cursorCoordinator.onClientConnected(client);
    this.#refreshCursorPullSchedule();
    this.#refreshCursorHubWatchState();

    serverSocket.addEventListener("message", (event: unknown) => {
      const payload = readBinaryMessageEventPayload(event);
      if (!payload) {
        this.#sendError(client, "bad_message", "Expected binary message payload");
        return;
      }

      this.#dispatchClientPayload(client.uid, serverSocket, payload, client);
    });

    let closed = false;
    const closeAndCleanup = (fields: Record<string, unknown>) => {
      if (closed) {
        return;
      }
      closed = true;
      this.#logEvent("ws_close", {
        uid: client.uid,
        ...(client.clientSessionId ? { client_session_id: client.clientSessionId } : {}),
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
          this.#recordTileVersion(tileKey, ver);
        },
        receiveTileBatch: (serverMessage) => {
          this.#receiveTileBatch(serverMessage);
        },
        recordRecentEditActivity: (tileKey, index) => {
          this.#recordRecentEditActivity(tileKey, index);
        },
        cursorOnActivity: () => {
          this.#cursorCoordinator.onActivity();
        },
        cursorOnSubscriptionsChanged: (force) => {
          this.#cursorCoordinator.onSubscriptionsChanged(force);
        },
        refreshTilePullSchedule: () => {
          this.#refreshTilePullSchedule();
        },
        markCursorPullActive: () => {
          this.#markCursorPullActive();
        },
        cursorOnLocalCursor: (connectedClient, x, y) => {
          this.#cursorCoordinator.onLocalCursor(connectedClient, x, y);
        },
        elapsedMs,
      });
    } catch (error) {
      const traceContext = resolveCursorErrorTraceContext({
        code: "internal",
        activeTrace: this.#cursorTraceState.activeTraceContext(),
        traceOrigin: this.#currentShardName(),
      });
      this.#logEvent("internal_error", {
        uid,
        ...(client.clientSessionId ? { client_session_id: client.clientSessionId } : {}),
        ...this.#cursorTraceState.traceFields(traceContext),
        ...this.#errorFields(error),
      });
      this.#sendError(
        client,
        "internal",
        "Failed to process message",
        this.#cursorTraceState.traceFields(traceContext)
      );
    }
  }

  async #enqueueSetCellPayload(
    uid: string,
    socket: SocketLike,
    payload: Uint8Array,
    client: ConnectedClient
  ): Promise<void> {
    await this.#setCellQueue.enqueue(uid, async () => {
      const suppressionReason = await this.#waitForSetCellSuppressionWindow(uid, socket);
      if (suppressionReason) {
        this.#logEvent("setcell_suppressed", {
          uid: client.uid,
          reason: suppressionReason,
          cursor_batch_ingress_depth: this.#cursorBatchIngressDepth,
          tile_batch_ingress_depth: this.#tileBatchIngressDepth,
        });
      }
      await this.#receiveClientPayload(uid, socket, payload);
    });
  }

  #dispatchClientPayload(
    uid: string,
    socket: SocketLike,
    payload: Uint8Array,
    client: ConnectedClient
  ): void {
    if (this.#isSetCellBinaryPayload(payload)) {
      this.#deferClientSetCellTask(async () => {
        try {
          await this.#enqueueSetCellPayload(uid, socket, payload, client);
        } catch {
          this.#sendError(client, "internal", "Failed to process client payload");
        }
      });
      return;
    }

    void this.#receiveClientPayload(uid, socket, payload).catch(() => {
      this.#sendError(client, "internal", "Failed to process client payload");
    });
  }

  #isSetCellBinaryPayload(payload: Uint8Array): boolean {
    return payload[0] === CLIENT_BINARY_TAG.setCell;
  }

  #canRelayCursorNow(): boolean {
    if (this.#cursorBatchIngressDepth > 0) {
      return false;
    }

    if (this.#tileBatchIngressDepth > 0) {
      return false;
    }

    if (this.#nowMs() < this.#cursorHubPublishSuppressedUntilMs) {
      return false;
    }

    return this.#nowMs() >= this.#setCellSuppressedUntilMs;
  }

  async #waitForSetCellSuppressionWindow(
    uid: string,
    socket: SocketLike
  ): Promise<SetCellSuppressionReason | null> {
    let suppressionReason: SetCellSuppressionReason | null = null;
    while (true) {
      const suppression = this.#setCellSuppressionState();
      if (!suppression) {
        return suppressionReason;
      }

      suppressionReason = suppression.reason;
      await this.#sleep(suppression.delayMs);

      const current = this.#clients.get(uid);
      if (!current || current.socket !== socket) {
        return suppressionReason;
      }
    }
  }

  #setCellSuppressionState(): { reason: SetCellSuppressionReason; delayMs: number } | null {
    if (this.#tileBatchIngressDepth > 0) {
      return {
        reason: "tile_batch_ingress_active",
        delayMs: TILE_BATCH_SETCELL_RETRY_MS,
      };
    }

    const remainingMs = this.#setCellSuppressedUntilMs - this.#nowMs();
    if (remainingMs > 0) {
      return {
        reason: "tile_batch_cooldown",
        delayMs: Math.max(1, Math.min(remainingMs, TILE_BATCH_SETCELL_RETRY_MS)),
      };
    }

    return null;
  }

  #sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), Math.max(1, delayMs));
      this.#maybeUnrefTimer(timer);
    });
  }

  #receiveTileBatch(message: Extract<ServerMessage, { t: "cellUpBatch" }>): void {
    this.#recordTileVersion(message.tile, message.toVer);
    this.#recordTileBatchOrdering(message);
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

  #recordTileBatchOrdering(message: Extract<ServerMessage, { t: "cellUpBatch" }>): void {
    const anomaly = this.#tileBatchOrderTracker.record(message);
    if (!anomaly) {
      return;
    }
    this.#logEvent("tile_batch_order_anomaly", {
      ...anomaly,
    });
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

  async #fetchTileOpsSince(
    tileKey: string,
    fromVer: number,
    limit: number
  ): Promise<{
    tile: string;
    fromVer: number;
    toVer: number;
    currentVer: number;
    gap: boolean;
    ops: Array<[number, 0 | 1]>;
  } | null> {
    return this.#tileGateway.fetchTileOpsSince(tileKey, fromVer, limit);
  }

  async #setTileCell(payload: TileSetCellRequest): Promise<TileSetCellResponse | null> {
    return this.#tileGateway.setTileCell(payload);
  }

  async #sendSnapshotToClient(client: ConnectedClient, tileKey: string): Promise<void> {
    const snapshot = await this.#fetchTileSnapshot(tileKey);
    if (!snapshot) {
      this.#logEvent("snapshot_send_failed", {
        uid: client.uid,
        tile: tileKey,
      });
      return;
    }
    this.#logEvent("snapshot_send", {
      uid: client.uid,
      tile: tileKey,
      ver: snapshot.ver,
    });
    this.#recordTileVersion(tileKey, snapshot.ver);
    this.#sendServerMessage(client, snapshot);
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
      activeTrace: this.#cursorTraceState.activeTraceContext(),
      traceOrigin: this.#currentShardName(),
    });
    this.#logEvent("server_error_sent", {
      uid: client.uid,
      ...(client.clientSessionId ? { client_session_id: client.clientSessionId } : {}),
      code,
      msg,
      ...this.#cursorTraceState.traceFields(activeTrace),
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

  #peerShardNames(currentShard: string): string[] {
    if (this.#cursorHubController.isEnabled()) {
      return this.#cursorPullOrchestrator.peerShards;
    }
    return peerShardNames(currentShard);
  }

  #deferClientSetCellTask(task: () => Promise<unknown>): void {
    this.#deferDetachedTask(task);
  }

  #deferDetachedTask(task: () => Promise<unknown>): void {
    // Best-effort work is intentionally detached from the current request chain
    // to avoid deep recursive service-binding ancestry.
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

  #tileBatchTraceIdFromRequest(request: Request): string | null {
    const traceId = request.headers.get(TILE_BATCH_TRACE_ID_HEADER)?.trim() ?? "";
    return traceId.length > 0 ? traceId : null;
  }

  #tileBatchTraceHopFromRequest(request: Request): number | null {
    const rawHop = request.headers.get(TILE_BATCH_TRACE_HOP_HEADER)?.trim() ?? "";
    if (rawHop.length === 0) {
      return null;
    }
    const hop = Number.parseInt(rawHop, 10);
    if (!Number.isFinite(hop) || hop < 0) {
      return null;
    }
    return hop;
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
    this.#setCellQueue.clear(uid);
    this.#cursorCoordinator.onClientDisconnected(uid);
    this.#refreshTilePullSchedule();
    this.#refreshCursorPullSchedule();
    this.#refreshCursorHubWatchState();
  }

  #receiveCursorBatch(batch: CursorRelayBatch): boolean {
    return this.#cursorCoordinator.onCursorBatch(batch);
  }

  #ingestCursorBatchWithIngress(batch: CursorRelayBatch): boolean {
    this.#cursorBatchIngressDepth += 1;
    try {
      return this.#receiveCursorBatch(batch);
    } finally {
      this.#cursorBatchIngressDepth = Math.max(0, this.#cursorBatchIngressDepth - 1);
      this.#cursorHubPublishSuppressedUntilMs = Math.max(
        this.#cursorHubPublishSuppressedUntilMs,
        this.#nowMs() + CURSOR_BATCH_HUB_PUBLISH_SUPPRESSION_MS
      );
    }
  }

  #localTileSubscriberCount(tileKey: string): number {
    return this.#tileToClients.get(tileKey)?.size ?? 0;
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

  async #resolveHelloSpawn(): Promise<{ x: number; y: number } | null> {
    if (!this.#cursorHubGateway) {
      return null;
    }

    try {
      const sample = await this.#cursorHubGateway.sampleSpawnPoint();
      if (!sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) {
        return null;
      }
      return {
        x: sample.x,
        y: sample.y,
      };
    } catch {
      return null;
    }
  }

  #recordRecentEditActivity(tileKey: string, index: number): void {
    if (!this.#cursorHubGateway) {
      return;
    }

    const parsed = parseTileKeyStrict(tileKey);
    if (!parsed) {
      return;
    }

    let world;
    try {
      world = worldFromTileCell(parsed.tx, parsed.ty, index);
    } catch {
      return;
    }

    const x = world.x + 0.5;
    const y = world.y + 0.5;
    this.#deferDetachedTask(async () => {
      try {
        await this.#cursorHubGateway?.publishRecentEdit({
          from: this.#currentShardName(),
          x,
          y,
          atMs: this.#nowMs(),
        });
      } catch {
        // Spawn activity publication is best-effort.
      }
    });
  }

  #operationsContext(): ConnectionShardDOOperationsContext {
    return {
      clients: this.#clients,
      tileToClients: this.#tileToClients,
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
      watchTile: (tileKey, action) => this.#watchTile(tileKey, action),
      setTileCell: (payload) => this.#setTileCell(payload),
      sendSnapshotToClient: (client, tileKey) => this.#sendSnapshotToClient(client, tileKey),
      nowMs: () => this.#nowMs(),
    };
  }

  #logEvent(event: string, fields: Record<string, unknown>): void {
    logStructuredEvent("connection_shard_do", event, {
      shard: this.#currentShardName(),
      ...fields,
    });
  }

  #recordTileVersion(tileKey: string, ver: number): void {
    const previous = this.#tileKnownVersionByTile.get(tileKey);
    this.#tileKnownVersionByTile.set(tileKey, previous === undefined ? ver : Math.max(previous, ver));
  }

  #refreshTilePullSchedule(): void {
    if (this.#tileToClients.size === 0) {
      this.#clearTilePullTimer();
      this.#tilePullInFlight.clear();
      this.#tileKnownVersionByTile.clear();
      this.#tilePullIntervalMs = TILE_PULL_INTERVAL_MAX_MS;
      this.#tilePullQuietStreak = 0;
      return;
    }

    this.#tilePullIntervalMs = TILE_PULL_INTERVAL_MAX_MS;
    this.#tilePullQuietStreak = 0;
    this.#scheduleTilePullTick(0);
  }

  #refreshCursorPullSchedule(): void {
    this.#cursorPullOrchestrator.refreshSchedule();
  }

  #refreshCursorHubWatchState(): void {
    this.#cursorHubController.refreshWatchState();
  }

  #scheduleTilePullTick(delayMs: number = this.#tilePullIntervalMs): void {
    if (this.#tilePullTimer || this.#tileToClients.size === 0) {
      return;
    }

    this.#tilePullTimer = setTimeout(() => {
      this.#tilePullTimer = null;
      void this.#runTilePullTick();
    }, Math.max(0, delayMs));
    this.#maybeUnrefTimer(this.#tilePullTimer);
  }

  #clearTilePullTimer(): void {
    if (!this.#tilePullTimer) {
      return;
    }

    clearTimeout(this.#tilePullTimer);
    this.#tilePullTimer = null;
  }

  async #runTilePullTick(): Promise<void> {
    const activeTiles = Array.from(this.#tileToClients.keys());
    if (activeTiles.length === 0) {
      return;
    }

    const deltaObserved = (
      await Promise.all(activeTiles.map((tileKey) => this.#pollTileIfNeeded(tileKey)))
    ).some(Boolean);
    this.#updateTilePullInterval(deltaObserved);
    this.#pruneStaleTilePullState();
    this.#scheduleTilePullTick(this.#tilePullIntervalMs);
  }

  #updateTilePullInterval(deltaObserved: boolean): void {
    if (deltaObserved) {
      this.#tilePullIntervalMs = TILE_PULL_INTERVAL_MIN_MS;
      this.#tilePullQuietStreak = 0;
      return;
    }

    if (this.#tilePullIntervalMs < TILE_PULL_INTERVAL_MAX_MS) {
      this.#tilePullIntervalMs = Math.min(
        TILE_PULL_INTERVAL_MAX_MS,
        this.#tilePullIntervalMs + TILE_PULL_INTERVAL_BACKOFF_STEP_MS
      );
      this.#tilePullQuietStreak = 0;
      return;
    }

    this.#tilePullQuietStreak += 1;
    if (this.#tilePullQuietStreak < TILE_PULL_IDLE_STREAK_BEFORE_LONG_BACKOFF) {
      return;
    }

    this.#tilePullIntervalMs = Math.min(
      TILE_PULL_INTERVAL_IDLE_MAX_MS,
      this.#tilePullIntervalMs + TILE_PULL_INTERVAL_IDLE_BACKOFF_STEP_MS
    );
  }

  #markCursorPullActive(): void {
    this.#cursorPullOrchestrator.noteLocalActivity();
  }

  #updateCursorPullPeerShards(peerShards: string[]): void {
    const nextPeerShards = this.#sanitizeCursorPullPeerShards(peerShards);
    this.#cursorPullOrchestrator.updatePeerShards(nextPeerShards);
  }

  #sanitizeCursorPullPeerShards(peerShards: string[]): string[] {
    const currentShard = this.#currentShardName();
    const allowedPeerShards = new Set(peerShardNames(currentShard));
    return Array.from(new Set(peerShards))
      .filter((peerShard) => allowedPeerShards.has(peerShard))
      .sort();
  }

  #pruneStaleTilePullState(): void {
    for (const tileKey of Array.from(this.#tileKnownVersionByTile.keys())) {
      if (this.#tileToClients.has(tileKey)) {
        continue;
      }
      this.#tileKnownVersionByTile.delete(tileKey);
      this.#tilePullInFlight.delete(tileKey);
    }
  }

  async #pollPeerCursorStates(wakeReason: CursorPullWakeReason): Promise<boolean> {
    const startMs = this.#nowMs();
    const peers = this.#peerShardNames(this.#currentShardName());
    if (peers.length === 0) {
      this.#cursorCoordinator.onCursorPollTick();
      this.#logEvent("cursor_pull_cycle", {
        wake_reason: wakeReason,
        peer_count: 0,
        delta_observed: false,
        duration_ms: elapsedMs(startMs),
      });
      return false;
    }

    let deltaObserved = false;
    for (let index = 0; index < peers.length; index += CURSOR_PULL_TIMING.concurrency) {
      const peerChunk = peers.slice(index, index + CURSOR_PULL_TIMING.concurrency);
      const chunkDeltaObserved = (
        await Promise.all(peerChunk.map((peerShard) => this.#pollPeerCursorState(peerShard, wakeReason)))
      ).some(Boolean);
      deltaObserved = deltaObserved || chunkDeltaObserved;
    }
    this.#cursorCoordinator.onCursorPollTick();
    this.#logEvent("cursor_pull_cycle", {
      wake_reason: wakeReason,
      peer_count: peers.length,
      delta_observed: deltaObserved,
      concurrency: CURSOR_PULL_TIMING.concurrency,
      duration_ms: elapsedMs(startMs),
    });
    return deltaObserved;
  }

  async #pollPeerCursorState(peerShard: string, wakeReason: CursorPullWakeReason): Promise<boolean> {
    const startMs = this.#nowMs();
    const pullTraceId = createCursorTraceId();
    const peerScopeFields = this.#cursorPullPeerScopeFields(peerShard, startMs);
    try {
      const stub = this.#env.CONNECTION_SHARD.getByName(peerShard);
      const response = await stub.fetch("https://connection-shard.internal/cursor-state", {
        method: "GET",
        headers: {
          "x-sea-cursor-pull": "1",
          [CURSOR_TRACE_ID_HEADER]: pullTraceId,
          [CURSOR_TRACE_HOP_HEADER]: "0",
          [CURSOR_TRACE_ORIGIN_HEADER]: this.#currentShardName(),
        },
      });
      if (!response.ok) {
        this.#logEvent("cursor_pull_peer", {
          target_shard: peerShard,
          wake_reason: wakeReason,
          ok: false,
          response_status: response.status,
          update_count: 0,
          trace_id: pullTraceId,
          ...peerScopeFields,
          duration_ms: elapsedMs(startMs),
        });
        return false;
      }

      const batch = await readJson<CursorRelayBatch>(response);
      if (!batch || !isValidCursorRelayBatch(batch)) {
        this.#logEvent("cursor_pull_peer", {
          target_shard: peerShard,
          wake_reason: wakeReason,
          ok: false,
          response_status: response.status,
          update_count: 0,
          trace_id: pullTraceId,
          ...peerScopeFields,
          error_message: "Invalid cursor-state payload",
          duration_ms: elapsedMs(startMs),
        });
        return false;
      }

      const deltaObserved = this.#ingestCursorBatchWithIngress(batch);
      const batchMaxSeq = cursorRelayBatchMaxSeq(batch);
      this.#logEvent("cursor_pull_peer", {
        target_shard: peerShard,
        wake_reason: wakeReason,
        ok: true,
        response_status: response.status,
        update_count: batch.updates.length,
        max_seq: batchMaxSeq || undefined,
        delta_observed: deltaObserved,
        trace_id: pullTraceId,
        ...peerScopeFields,
        duration_ms: elapsedMs(startMs),
      });
      this.#maybeLogCursorPullPreVisibilityObservation({
        peerShard,
        wakeReason,
        batch,
        deltaObserved,
        pullTraceId,
        startedAtMs: startMs,
        peerScopeFields: {
          ...peerScopeFields,
          max_seq: batchMaxSeq || undefined,
        },
      });
      this.#maybeLogCursorPullFirstPeerVisibility({
        peerShard,
        wakeReason,
        batchUpdateCount: batch.updates.length,
        deltaObserved,
        pullTraceId,
        startedAtMs: startMs,
        peerScopeFields: {
          ...peerScopeFields,
          max_seq: batchMaxSeq || undefined,
        },
      });
      return deltaObserved;
    } catch (error) {
      this.#logEvent("cursor_pull_peer", {
        target_shard: peerShard,
        wake_reason: wakeReason,
        ok: false,
        update_count: 0,
        trace_id: pullTraceId,
        ...peerScopeFields,
        duration_ms: elapsedMs(startMs),
        ...this.#errorFields(error),
      });
      // Cursor pull is best-effort and must not surface client-visible failures.
      return false;
    }
  }

  #cursorPullPeerScopeFields(
    peerShard: string,
    nowMs: number = this.#nowMs()
  ): Record<string, unknown> {
    return this.#cursorPullOrchestrator.peerScopeFields(peerShard, nowMs);
  }

  #maybeLogCursorPullFirstPeerVisibility({
    peerShard,
    wakeReason,
    batchUpdateCount,
    deltaObserved,
    pullTraceId,
    startedAtMs,
    peerScopeFields,
  }: {
    peerShard: string;
    wakeReason: CursorPullWakeReason;
    batchUpdateCount: number;
    deltaObserved: boolean;
    pullTraceId: string;
    startedAtMs: number;
    peerScopeFields: Record<string, unknown>;
  }): void {
    if (!this.#cursorPullOrchestrator.markFirstVisibility(peerShard, batchUpdateCount, deltaObserved)) {
      return;
    }
    this.#logEvent("cursor_pull_first_peer_visibility", {
      target_shard: peerShard,
      wake_reason: wakeReason,
      update_count: batchUpdateCount,
      delta_observed: deltaObserved,
      trace_id: pullTraceId,
      ...peerScopeFields,
      duration_ms: elapsedMs(startedAtMs),
    });
  }

  #maybeLogCursorPullPreVisibilityObservation({
    peerShard,
    wakeReason,
    batch,
    deltaObserved,
    pullTraceId,
    startedAtMs,
    peerScopeFields,
  }: {
    peerShard: string;
    wakeReason: CursorPullWakeReason;
    batch: CursorRelayBatch;
    deltaObserved: boolean;
    pullTraceId: string;
    startedAtMs: number;
    peerScopeFields: Record<string, unknown>;
  }): void {
    if (deltaObserved) {
      return;
    }
    const outcome = batch.updates.length === 0 ? "empty_snapshot" : "nonempty_without_delta";
    if (!this.#cursorPullOrchestrator.markPreVisibilityOutcome(peerShard, outcome)) {
      return;
    }
    this.#logEvent("cursor_pull_pre_visibility_observation", {
      target_shard: peerShard,
      wake_reason: wakeReason,
      outcome,
      update_count: batch.updates.length,
      max_seq: cursorRelayBatchMaxSeq(batch) || undefined,
      uid_sample: this.#cursorSnapshotUidSample(batch.updates),
      delta_observed: false,
      trace_id: pullTraceId,
      ...peerScopeFields,
      duration_ms: elapsedMs(startedAtMs),
    });
  }

  #cursorSnapshotMaxSeq(updates: Array<{ seq: number }>): number {
    let maxSeq = 0;
    for (const update of updates) {
      maxSeq = Math.max(maxSeq, update.seq);
    }
    return maxSeq;
  }

  #cursorSnapshotUidSample(
    updates: Array<{ uid: string }>,
    limit: number = 5
  ): string[] {
    return updates.slice(0, limit).map((update) => update.uid);
  }

  async #pollTileIfNeeded(tileKey: string): Promise<boolean> {
    if (!this.#tileToClients.has(tileKey) || this.#tilePullInFlight.has(tileKey)) {
      return false;
    }

    this.#tilePullInFlight.add(tileKey);
    try {
      return await this.#pollTileDeltas(tileKey);
    } finally {
      this.#tilePullInFlight.delete(tileKey);
    }
  }

  async #pollTileDeltas(tileKey: string): Promise<boolean> {
    let fromVer = this.#tileKnownVersionByTile.get(tileKey) ?? 0;
    let sawDelta = false;

    for (let page = 0; page < TILE_PULL_MAX_PAGES_PER_TICK; page += 1) {
      const response = await this.#fetchTileOpsSince(tileKey, fromVer, TILE_PULL_PAGE_LIMIT);
      if (!response || response.tile !== tileKey) {
        return sawDelta;
      }

      if (response.gap) {
        const resynced = await this.#resyncTileViaSnapshot(tileKey);
        return sawDelta || resynced;
      }

      if (response.ops.length === 0) {
        this.#recordTileVersion(tileKey, response.toVer);
        return sawDelta;
      }

      const expectedToVer = fromVer + response.ops.length;
      if (response.toVer !== expectedToVer) {
        const resynced = await this.#resyncTileViaSnapshot(tileKey);
        return sawDelta || resynced;
      }

      this.#receiveTileBatch({
        t: "cellUpBatch",
        tile: tileKey,
        fromVer: fromVer + 1,
        toVer: response.toVer,
        ops: response.ops,
      });
      sawDelta = true;
      fromVer = response.toVer;

      if (response.toVer >= response.currentVer) {
        return sawDelta;
      }
    }

    return sawDelta;
  }

  async #resyncTileViaSnapshot(tileKey: string): Promise<boolean> {
    const snapshot = await this.#fetchTileSnapshot(tileKey);
    if (!snapshot) {
      return false;
    }

    this.#recordTileVersion(tileKey, snapshot.ver);
    this.#fanoutSnapshotToSubscribers(snapshot);
    this.#logEvent("tile_pull_gap_resync", {
      tile: tileKey,
      ver: snapshot.ver,
    });
    return true;
  }

  #fanoutSnapshotToSubscribers(snapshot: Extract<ServerMessage, { t: "tileSnap" }>): void {
    const subscribers = this.#tileToClients.get(snapshot.tile);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    for (const uid of subscribers) {
      const client = this.#clients.get(uid);
      if (!client) {
        continue;
      }
      this.#sendServerMessage(client, snapshot);
    }
  }
}
