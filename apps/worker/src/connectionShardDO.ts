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
  ConnectionShardCursorPullScheduler,
  type CursorPullScheduleDecision,
  type CursorPullWakeReason,
} from "./connectionShardCursorPullScheduler";
import { ConnectionShardCursorPullIngressGate } from "./connectionShardCursorPullIngressGate";
import { ConnectionShardCursorPullPeerScopeTracker } from "./connectionShardCursorPullPeerScopeTracker";
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
const CURSOR_PULL_INTERVAL_MIN_MS = 75;
const CURSOR_PULL_INTERVAL_MAX_MS = 300;
const CURSOR_PULL_INTERVAL_BACKOFF_STEP_MS = 75;
const CURSOR_PULL_INTERVAL_IDLE_MAX_MS = 1_500;
const CURSOR_PULL_INTERVAL_IDLE_BACKOFF_STEP_MS = 300;
const CURSOR_PULL_IDLE_STREAK_BEFORE_LONG_BACKOFF = 4;
const CURSOR_PULL_ACTIVITY_WINDOW_MS = 500;
const CURSOR_PULL_INGRESS_SUPPRESSION_MS = 300;
const CURSOR_PULL_JITTER_MS = 25;
const CURSOR_PULL_CONCURRENCY = 2;
const CURSOR_HUB_NAME = "global";
const CURSOR_BATCH_HUB_PUBLISH_SUPPRESSION_MS = 300;
const CURSOR_BATCH_TRACE_MAX_HOP = 1;
const ENABLED_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);

type SetCellSuppressionReason =
  | "tile_batch_ingress_active"
  | "tile_batch_cooldown";

interface CursorPullFirstPostScopeState {
  observedAtMs: number;
  peerCount: number;
  bypassEnabled: boolean;
}

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
  #cursorPullInFlight: boolean;
  #cursorPullScheduler: ConnectionShardCursorPullScheduler;
  #cursorPullIngressGate: ConnectionShardCursorPullIngressGate;
  #cursorPullIntervalMs: number;
  #cursorPullQuietStreak: number;
  #cursorPullActiveUntilMs: number;
  #cursorPullPeerScopeTracker: ConnectionShardCursorPullPeerScopeTracker;
  #cursorStateIngressDepth: number;
  #cursorPullSuppressedUntilMs: number;
  #cursorPullPendingWakeReason: CursorPullWakeReason | null;
  #cursorPullAlarmArmed: boolean;
  #cursorPullAlarmScheduledAtMs: number | null;
  #cursorPullFirstPostScopeState: CursorPullFirstPostScopeState | null;
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
    this.#cursorPullInFlight = false;
    this.#cursorPullIntervalMs = CURSOR_PULL_INTERVAL_MIN_MS;
    this.#cursorPullQuietStreak = 0;
    this.#cursorPullActiveUntilMs = 0;
    this.#cursorPullPeerScopeTracker = new ConnectionShardCursorPullPeerScopeTracker();
    this.#cursorStateIngressDepth = 0;
    this.#cursorPullSuppressedUntilMs = 0;
    this.#cursorPullPendingWakeReason = null;
    this.#cursorPullAlarmArmed = false;
    this.#cursorPullAlarmScheduledAtMs = null;
    this.#cursorPullFirstPostScopeState = null;
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
    this.#cursorPullScheduler = new ConnectionShardCursorPullScheduler({
      nowMs: () => this.#nowMs(),
      maybeUnrefTimer: (timer) => this.#maybeUnrefTimer(timer),
      onTick: (wakeReason) => {
        this.#queueDetachedCursorPullTick(wakeReason);
      },
      minIntervalMs: CURSOR_PULL_INTERVAL_MIN_MS,
      jitterMs: CURSOR_PULL_JITTER_MS,
    });
    this.#cursorPullIngressGate = new ConnectionShardCursorPullIngressGate({
      deferDetachedTask: (task) => this.#deferDetachedTask(task),
      onFlush: (wakeReason) => {
        this.#scheduleCursorPullTick(
          wakeReason === "timer" ? CURSOR_PULL_INTERVAL_MIN_MS : 0,
          wakeReason
        );
      },
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
          this.#logEvent("cursor_first_local_publish", {
            uid: cursor.uid,
            ...(client?.clientSessionId ? { client_session_id: client.clientSessionId } : {}),
            seq: cursor.seq,
            tile: cursor.tileKey,
            x: cursor.x,
            y: cursor.y,
            fanout_count: fanoutCount,
            ...(typeof connectionAgeMs === "number" ? { connection_age_ms: connectionAgeMs } : {}),
            subscribed_count: client?.subscribed.size ?? 0,
          });
        }
        this.#logEvent("cursor_local_publish", {
          uid: cursor.uid,
          seq: cursor.seq,
          tile: cursor.tileKey,
          x: cursor.x,
          y: cursor.y,
          fanout_count: fanoutCount,
          ...(typeof connectionAgeMs === "number" ? { connection_age_ms: connectionAgeMs } : {}),
        });
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
        if (isInboundCursorPull) {
          this.#cursorPullSuppressedUntilMs = Math.max(
            this.#cursorPullSuppressedUntilMs,
            this.#nowMs() + CURSOR_PULL_INGRESS_SUPPRESSION_MS
          );
        }
        if (this.#cursorStateIngressDepth === 0) {
          this.#cursorPullIngressGate.flushAfterIngressExited();
        }
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const wake = this.#consumeDetachedCursorPullWake();
    if (!wake) {
      this.#logEvent("cursor_pull_alarm_stale", {
        ...this.#cursorPullAlarmStateFields(),
      });
      return;
    }
    if (wake.wakeReason === "watch_scope_change") {
      this.#logEvent("cursor_pull_alarm_fired", {
        ...this.#cursorPullAlarmStateFields({
          wake_reason: wake.wakeReason,
          scheduled_at_ms: wake.scheduledAtMs ?? undefined,
        }),
      });
    }
    try {
      await this.#runCursorPullTick(wake.wakeReason);
    } catch (error) {
      this.#logEvent("cursor_pull_alarm_failed", {
        ...this.#cursorPullAlarmStateFields({
          wake_reason: wake.wakeReason,
          scheduled_at_ms: wake.scheduledAtMs ?? undefined,
        }),
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
      return this.#cursorPullPeerScopeTracker.peerShards;
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
  ): { error_name?: string; error_message?: string; error_stack?: string } {
    if (typeof error !== "object" || error === null) {
      return {};
    }

    const name = "name" in error && typeof error.name === "string" ? error.name : undefined;
    const message =
      "message" in error && typeof error.message === "string"
        ? error.message.slice(0, 240)
        : undefined;
    const stack = options.includeStack
      && "stack" in error
      && typeof error.stack === "string"
      && error.stack.length > 0
      ? error.stack.slice(0, 4000)
      : undefined;

    return {
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
    if (this.#clients.size === 0) {
      this.#cursorPullScheduler.reset();
      this.#cursorPullIngressGate.reset();
      this.#clearDetachedCursorPullAlarm();
      this.#cursorPullInFlight = false;
      this.#cursorPullIntervalMs = CURSOR_PULL_INTERVAL_MIN_MS;
      this.#cursorPullQuietStreak = 0;
      this.#cursorPullActiveUntilMs = 0;
      this.#cursorPullPeerScopeTracker.reset();
      this.#cursorPullSuppressedUntilMs = 0;
      this.#cursorPullFirstPostScopeState = null;
      return;
    }

    if (this.#peerShardNames(this.#currentShardName()).length === 0) {
      this.#cursorPullScheduler.reset();
      this.#cursorPullIngressGate.reset();
      this.#clearDetachedCursorPullAlarm();
      this.#cursorPullIntervalMs = CURSOR_PULL_INTERVAL_MIN_MS;
      this.#cursorPullQuietStreak = 0;
      this.#cursorPullActiveUntilMs = 0;
      this.#cursorPullPeerScopeTracker.reset();
      this.#cursorPullSuppressedUntilMs = 0;
      this.#cursorPullFirstPostScopeState = null;
      return;
    }

    this.#cursorPullIntervalMs = CURSOR_PULL_INTERVAL_MIN_MS;
    this.#cursorPullQuietStreak = 0;
    this.#cursorPullActiveUntilMs = this.#nowMs() + CURSOR_PULL_ACTIVITY_WINDOW_MS;
    this.#scheduleCursorPullTick(0, "schedule_refresh");
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

  #scheduleCursorPullTick(
    delayMs: number = this.#cursorPullIntervalMs,
    wakeReason: CursorPullWakeReason = "timer"
  ): void {
    if (this.#clients.size === 0) {
      return;
    }
    if (this.#cursorStateIngressDepth > 0) {
      const beforeState = this.#cursorPullIngressGate.inspectState();
      this.#cursorPullIngressGate.defer(wakeReason);
      if (wakeReason === "watch_scope_change" || wakeReason === "local_activity") {
        const afterState = this.#cursorPullIngressGate.inspectState();
        this.#logCursorPullWakeDecision({
          eventName: this.#cursorPullWakeEventName(wakeReason),
          decision: {
            action: "deferred_for_ingress",
            wakeReason,
            requestedDelayMs: delayMs,
            floorDelayMs: delayMs,
            effectiveDelayMs: delayMs,
            scheduledAtMs: 0,
            existingScheduledAtMs: null,
            existingWakeReason: beforeState.pendingWakeReason ?? null,
          },
          requestedDelayMs: delayMs,
          adjustedDelayMs: delayMs,
          suppressionRemainingMs: 0,
          schedulerBeforeState: this.#cursorPullScheduler.inspectState(),
          extraFields: {
            ingress_depth: this.#cursorStateIngressDepth,
            gate_pending_wake_reason_before: beforeState.pendingWakeReason ?? undefined,
            gate_pending_wake_reason_after: afterState.pendingWakeReason ?? undefined,
            gate_flush_queued: afterState.flushQueued,
          },
        });
      }
      return;
    }
    const suppressionRemainingMs = this.#cursorPullSuppressionRemainingMs();
    const adjustedDelayMs = this.#applyCursorPullSuppressionDelay(delayMs);
    const schedulerBeforeState = this.#cursorPullScheduler.inspectState();
    const decision = this.#cursorPullScheduler.schedule(adjustedDelayMs, wakeReason);
    if (wakeReason === "watch_scope_change" || wakeReason === "local_activity") {
      this.#logCursorPullWakeDecision({
        eventName: this.#cursorPullWakeEventName(wakeReason),
        decision,
        requestedDelayMs: delayMs,
        adjustedDelayMs,
        suppressionRemainingMs,
        schedulerBeforeState,
      });
    }
  }

  #clearTilePullTimer(): void {
    if (!this.#tilePullTimer) {
      return;
    }

    clearTimeout(this.#tilePullTimer);
    this.#tilePullTimer = null;
  }

  #clearCursorPullTimer(): void {
    this.#cursorPullScheduler.clear();
  }

  #queueDetachedCursorPullTick(wakeReason: CursorPullWakeReason): void {
    if (this.#clients.size === 0) {
      return;
    }
    if (this.#peerShardNames(this.#currentShardName()).length === 0) {
      return;
    }
    if (
      !this.#cursorPullPendingWakeReason
      || this.#cursorPullWakePriority(wakeReason) > this.#cursorPullWakePriority(this.#cursorPullPendingWakeReason)
    ) {
      this.#cursorPullPendingWakeReason = wakeReason;
    }

    if (this.#cursorPullAlarmArmed) {
      if (wakeReason === "watch_scope_change" || this.#cursorPullPendingWakeReason === "watch_scope_change") {
        this.#logEvent("cursor_pull_alarm_armed", {
          ...this.#cursorPullAlarmStateFields({
            action: "kept_existing",
            wake_reason: wakeReason,
          }),
        });
      }
      return;
    }

    this.#cursorPullAlarmArmed = true;
    this.#cursorPullAlarmScheduledAtMs = this.#nowMs();
    if (wakeReason === "watch_scope_change" || this.#cursorPullPendingWakeReason === "watch_scope_change") {
      this.#logEvent("cursor_pull_alarm_armed", {
        ...this.#cursorPullAlarmStateFields({
          action: "armed",
          wake_reason: wakeReason,
        }),
      });
    }
    const setAlarm = this.#state.storage.setAlarm?.bind(this.#state.storage);
    if (setAlarm) {
      void setAlarm(this.#nowMs()).catch(() => {
        if (!this.#cursorPullAlarmArmed) {
          return;
        }
        this.#deferDetachedTask(async () => {
          await this.alarm();
        });
      });
      return;
    }

    this.#deferDetachedTask(async () => {
      await this.alarm();
    });
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

  async #runCursorPullTick(wakeReason: CursorPullWakeReason): Promise<void> {
    if (this.#clients.size === 0) {
      this.#logFirstPostScopeDecisionIfPending("aborted_no_clients", wakeReason, {
        suppressionRemainingMs: this.#cursorPullSuppressionRemainingMs(),
      });
      this.#cursorPullFirstPostScopeState = null;
      return;
    }

    if (this.#cursorStateIngressDepth > 0) {
      this.#logFirstPostScopeDecisionIfPending("delayed_for_ingress", wakeReason, {
        suppressionRemainingMs: this.#cursorPullSuppressionRemainingMs(),
      });
      this.#cursorPullIngressGate.defer(wakeReason);
      return;
    }

    const firstPostScopeState = this.#cursorPullFirstPostScopeState;
    const suppressedDelayMs = this.#cursorPullSuppressionRemainingMs();
    const bypassSuppressionOnce = firstPostScopeState?.bypassEnabled === true && suppressedDelayMs > 0;
    if (suppressedDelayMs > 0 && !bypassSuppressionOnce) {
      this.#logFirstPostScopeDecisionIfPending("delayed_for_suppression", wakeReason, {
        suppressionRemainingMs: suppressedDelayMs,
      });
      this.#scheduleCursorPullTick(suppressedDelayMs, wakeReason);
      return;
    }
    if (bypassSuppressionOnce) {
      this.#logFirstPostScopeDecisionIfPending("started_with_suppression_bypass", wakeReason, {
        suppressionRemainingMs: suppressedDelayMs,
      });
    }

    if (this.#cursorPullInFlight) {
      this.#logFirstPostScopeDecisionIfPending("delayed_for_in_flight", wakeReason, {
        suppressionRemainingMs: suppressedDelayMs,
      });
      this.#scheduleCursorPullTick(CURSOR_PULL_INTERVAL_MIN_MS, "timer");
      return;
    }

    if (!bypassSuppressionOnce) {
      this.#logFirstPostScopeDecisionIfPending("started", wakeReason, {
        suppressionRemainingMs: suppressedDelayMs,
      });
    }
    this.#cursorPullFirstPostScopeState = null;
    this.#cursorPullInFlight = true;
    this.#cursorPullScheduler.markRunStarted();
    try {
      const deltaObserved = await this.#pollPeerCursorStates(wakeReason);
      this.#updateCursorPullInterval(deltaObserved);
    } finally {
      this.#cursorPullInFlight = false;
      this.#cursorPullScheduler.markRunCompleted();
      this.#scheduleCursorPullTick(this.#cursorPullIntervalMs, "timer");
    }
  }

  #consumeDetachedCursorPullWake(): { wakeReason: CursorPullWakeReason; scheduledAtMs: number | null } | null {
    this.#cursorPullAlarmArmed = false;
    const scheduledAtMs = this.#cursorPullAlarmScheduledAtMs;
    this.#cursorPullAlarmScheduledAtMs = null;
    const wakeReason = this.#cursorPullPendingWakeReason;
    this.#cursorPullPendingWakeReason = null;
    if (!wakeReason) {
      return null;
    }
    return { wakeReason, scheduledAtMs };
  }

  #updateCursorPullInterval(deltaObserved: boolean): void {
    if (deltaObserved || this.#nowMs() < this.#cursorPullActiveUntilMs) {
      this.#cursorPullIntervalMs = CURSOR_PULL_INTERVAL_MIN_MS;
      this.#cursorPullQuietStreak = 0;
      return;
    }

    if (this.#cursorPullIntervalMs < CURSOR_PULL_INTERVAL_MAX_MS) {
      this.#cursorPullIntervalMs = Math.min(
        CURSOR_PULL_INTERVAL_MAX_MS,
        this.#cursorPullIntervalMs + CURSOR_PULL_INTERVAL_BACKOFF_STEP_MS
      );
      this.#cursorPullQuietStreak = 0;
      return;
    }

    this.#cursorPullQuietStreak += 1;
    if (this.#cursorPullQuietStreak < CURSOR_PULL_IDLE_STREAK_BEFORE_LONG_BACKOFF) {
      return;
    }

    this.#cursorPullIntervalMs = Math.min(
      CURSOR_PULL_INTERVAL_IDLE_MAX_MS,
      this.#cursorPullIntervalMs + CURSOR_PULL_INTERVAL_IDLE_BACKOFF_STEP_MS
    );
  }

  #markCursorPullActive(): void {
    if (this.#clients.size === 0) {
      return;
    }

    if (this.#peerShardNames(this.#currentShardName()).length === 0) {
      return;
    }

    this.#cursorPullIntervalMs = CURSOR_PULL_INTERVAL_MIN_MS;
    this.#cursorPullQuietStreak = 0;

    if (!this.#cursorPullInFlight) {
      this.#scheduleCursorPullTick(0, "local_activity");
    }
  }

  #cursorPullSuppressionRemainingMs(): number {
    return Math.max(0, this.#cursorPullSuppressedUntilMs - this.#nowMs());
  }

  #cursorPullWakePriority(wakeReason: CursorPullWakeReason): number {
    switch (wakeReason) {
      case "local_activity":
        return 3;
      case "watch_scope_change":
        return 2;
      case "schedule_refresh":
        return 1;
      case "timer":
      default:
        return 0;
    }
  }

  #applyCursorPullSuppressionDelay(delayMs: number): number {
    return Math.max(delayMs, this.#cursorPullSuppressionRemainingMs());
  }

  #updateCursorPullPeerShards(peerShards: string[]): void {
    const nextPeerShards = this.#sanitizeCursorPullPeerShards(peerShards);
    const nowMs = this.#nowMs();
    const change = this.#cursorPullPeerScopeTracker.replacePeerShards(nextPeerShards, nowMs);
    if (!change.changed) {
      if (this.#clients.size > 0 && nextPeerShards.length > 0) {
        this.#logEvent("cursor_pull_scope_unchanged", {
          peer_count: nextPeerShards.length,
          peers: nextPeerShards,
          oldest_scope_age_ms: change.oldestScopeAgeMs,
        });
      }
      return;
    }

    this.#logEvent("cursor_pull_scope", {
      previous_peer_count: change.previousPeerShards.length,
      previous_peers: change.previousPeerShards,
      peer_count: nextPeerShards.length,
      peers: nextPeerShards,
    });

    if (this.#clients.size === 0) {
      return;
    }

    if (nextPeerShards.length === 0) {
      this.#cursorPullFirstPostScopeState = null;
      this.#clearCursorPullTimer();
      this.#clearDetachedCursorPullAlarm();
      this.#cursorPullActiveUntilMs = 0;
      return;
    }

    if (change.previousPeerShards.length === 0) {
      this.#cursorPullFirstPostScopeState = {
        observedAtMs: nowMs,
        peerCount: nextPeerShards.length,
        bypassEnabled: this.#isCursorPullFirstPostScopeBypassEnabled(),
      };
    }

    this.#cursorPullActiveUntilMs = this.#nowMs() + CURSOR_PULL_ACTIVITY_WINDOW_MS;
    if (!this.#cursorPullInFlight) {
      this.#clearCursorPullTimer();
      this.#scheduleCursorPullTick(0, "watch_scope_change");
    }
  }

  #sanitizeCursorPullPeerShards(peerShards: string[]): string[] {
    const currentShard = this.#currentShardName();
    const allowedPeerShards = new Set(peerShardNames(currentShard));
    return Array.from(new Set(peerShards))
      .filter((peerShard) => allowedPeerShards.has(peerShard))
      .sort();
  }

  #clearDetachedCursorPullAlarm(): void {
    this.#cursorPullPendingWakeReason = null;
    this.#cursorPullAlarmArmed = false;
    this.#cursorPullAlarmScheduledAtMs = null;
    const deleteAlarm = this.#state.storage.deleteAlarm?.bind(this.#state.storage);
    if (deleteAlarm) {
      void deleteAlarm().catch(() => {});
    }
  }

  #cursorPullAlarmStateFields(
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const nowMs = this.#nowMs();
    const currentShard = this.#currentShardName();
    return {
      peer_count: this.#peerShardNames(currentShard).length,
      in_flight: this.#cursorPullInFlight,
      interval_ms: this.#cursorPullIntervalMs,
      quiet_streak: this.#cursorPullQuietStreak,
      active_remaining_ms: Math.max(0, this.#cursorPullActiveUntilMs - nowMs),
      suppression_remaining_ms: this.#cursorPullSuppressionRemainingMs(),
      ingress_depth: this.#cursorStateIngressDepth,
      alarm_armed: this.#cursorPullAlarmArmed,
      pending_wake_reason: this.#cursorPullPendingWakeReason ?? undefined,
      scheduled_at_ms: this.#cursorPullAlarmScheduledAtMs ?? undefined,
      ...overrides,
    };
  }

  #cursorPullWakeEventName(wakeReason: CursorPullWakeReason): string {
    switch (wakeReason) {
      case "local_activity":
        return "cursor_pull_local_activity_wake";
      case "watch_scope_change":
      default:
        return "cursor_pull_watch_scope_wake";
    }
  }

  #isCursorPullFirstPostScopeBypassEnabled(): boolean {
    const raw = typeof this.#env.CURSOR_PULL_FIRST_POST_SCOPE_BYPASS === "string"
      ? this.#env.CURSOR_PULL_FIRST_POST_SCOPE_BYPASS.trim().toLowerCase()
      : "";
    return ENABLED_FLAG_VALUES.has(raw);
  }

  #logFirstPostScopeDecisionIfPending(
    action:
      | "aborted_no_clients"
      | "delayed_for_ingress"
      | "delayed_for_in_flight"
      | "delayed_for_suppression"
      | "started"
      | "started_with_suppression_bypass",
    wakeReason: CursorPullWakeReason,
    {
      suppressionRemainingMs,
    }: {
      suppressionRemainingMs: number;
    }
  ): void {
    const pending = this.#cursorPullFirstPostScopeState;
    if (!pending) {
      return;
    }
    const nowMs = this.#nowMs();
    const schedulerState = this.#cursorPullScheduler.inspectState();
    this.#logEvent("cursor_pull_first_post_scope_decision", {
      action,
      wake_reason: wakeReason,
      first_post_scope_observed_at_ms: pending.observedAtMs,
      first_post_scope_age_ms: Math.max(0, nowMs - pending.observedAtMs),
      peer_count: pending.peerCount,
      bypass_enabled: pending.bypassEnabled,
      suppression_remaining_ms: suppressionRemainingMs,
      ingress_depth: this.#cursorStateIngressDepth,
      in_flight: this.#cursorPullInFlight,
      scheduler_pending_wake_reason: schedulerState.wakeReason ?? undefined,
      scheduler_scheduled_at_ms: schedulerState.scheduledAtMs ?? undefined,
      scheduler_last_started_at_ms: schedulerState.lastStartedAtMs || undefined,
      scheduler_last_completed_at_ms: schedulerState.lastCompletedAtMs || undefined,
      alarm_armed: this.#cursorPullAlarmArmed,
      alarm_pending_wake_reason: this.#cursorPullPendingWakeReason ?? undefined,
      alarm_scheduled_at_ms: this.#cursorPullAlarmScheduledAtMs ?? undefined,
    });
  }

  #logCursorPullWakeDecision({
    eventName,
    decision,
    requestedDelayMs,
    adjustedDelayMs,
    suppressionRemainingMs,
    schedulerBeforeState,
    extraFields = {},
  }: {
    eventName: string;
    decision: Pick<
      CursorPullScheduleDecision,
      | "wakeReason"
      | "requestedDelayMs"
      | "floorDelayMs"
      | "effectiveDelayMs"
      | "scheduledAtMs"
      | "existingScheduledAtMs"
      | "existingWakeReason"
    > & {
      action: CursorPullScheduleDecision["action"] | "deferred_for_ingress";
    };
    requestedDelayMs: number;
    adjustedDelayMs: number;
    suppressionRemainingMs: number;
    schedulerBeforeState: ReturnType<ConnectionShardCursorPullScheduler["inspectState"]>;
    extraFields?: Record<string, unknown>;
  }): void {
    const schedulerAfterState = this.#cursorPullScheduler.inspectState();
    this.#logEvent(eventName, {
      action: decision.action,
      wake_reason: decision.wakeReason,
      requested_delay_ms: requestedDelayMs,
      adjusted_delay_ms: adjustedDelayMs,
      floor_delay_ms: decision.floorDelayMs,
      effective_delay_ms: decision.effectiveDelayMs,
      suppression_remaining_ms: suppressionRemainingMs,
      ingress_depth: this.#cursorStateIngressDepth,
      previous_wake_reason: schedulerBeforeState.wakeReason ?? undefined,
      previous_scheduled_at_ms: schedulerBeforeState.scheduledAtMs ?? undefined,
      scheduled_at_ms: schedulerAfterState.scheduledAtMs ?? undefined,
      armed_wake_reason: schedulerAfterState.wakeReason ?? undefined,
      last_started_at_ms: schedulerAfterState.lastStartedAtMs || undefined,
      last_completed_at_ms: schedulerAfterState.lastCompletedAtMs || undefined,
      ...extraFields,
    });
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
    for (let index = 0; index < peers.length; index += CURSOR_PULL_CONCURRENCY) {
      const peerChunk = peers.slice(index, index + CURSOR_PULL_CONCURRENCY);
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
      concurrency: CURSOR_PULL_CONCURRENCY,
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
    return this.#cursorPullPeerScopeTracker.scopeFields(peerShard, nowMs);
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
    if (!this.#cursorPullPeerScopeTracker.markFirstVisibility(peerShard, batchUpdateCount, deltaObserved)) {
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
    if (!this.#cursorPullPeerScopeTracker.markPreVisibilityOutcome(peerShard, outcome)) {
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
