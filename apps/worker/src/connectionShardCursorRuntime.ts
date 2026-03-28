import type { ServerMessage } from "@sea/protocol";

import {
  isValidCursorRelayBatch,
  type CursorRelayBatch,
} from "./cursorRelay";
import {
  CURSOR_TRACE_HOP_HEADER,
  CURSOR_TRACE_ID_HEADER,
  CURSOR_TRACE_ORIGIN_HEADER,
  ConnectionShardCursorTraceState,
  createCursorTraceId,
} from "./connectionShardCursorTrace";
import {
  ConnectionShardCursorPullOrchestrator,
  type CursorPullAlarmWake,
} from "./connectionShardCursorPullOrchestrator";
import type { CursorPullWakeReason } from "./connectionShardCursorPullScheduler";
import { ConnectionShardCursorHubController } from "./connectionShardCursorHubController";
import {
  buildCursorFirstLocalPublishLogFields,
  buildCursorLocalPublishLogFields,
} from "./connectionShardCursorLogFields";
import { CursorCoordinator } from "./cursorCoordinator";
import { ConnectionShardCursorHubActivity } from "./connectionShardCursorHubActivity";
import {
  CURSOR_HUB_WATCH_TIMING,
  CURSOR_PULL_TIMING,
  defaultCursorHubSettleRenewMs,
} from "./cursorTimingConfig";
import { peerShardNames } from "./sharding";
import { handleConnectionShardCursorBatchIngress } from "./connectionShardCursorBatchIngress";
import { jsonResponse, readJson } from "./doCommon";
import type { ConnectedClient } from "./connectionShardDOOperations";
import type { ConnectionShardCursorHubGateway } from "./cursorHubGateway";

const CURSOR_BATCH_TRACE_MAX_HOP = 1;
const CURSOR_BATCH_HUB_PUBLISH_SUPPRESSION_MS = 300;

function looksLikeIsoDatetime(raw: string): boolean {
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(trimmed)) {
    return false;
  }
  return Number.isFinite(Date.parse(trimmed));
}

function prefixedFields(prefix: string, fields: Record<string, unknown>): Record<string, unknown> {
  const prefixed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    prefixed[`${prefix}${key}`] = value;
  }
  return prefixed;
}

function errorFields(
  error: unknown,
  options: { includeStack?: boolean } = {}
): {
    error_name?: string;
    error_message?: string;
    error_stack?: string;
    error_type?: string;
    error_datetime_like?: boolean;
  } {
  if (typeof error === "string") {
    return {
      error_type: "string",
      error_message: error.slice(0, 240),
      ...(looksLikeIsoDatetime(error) ? { error_datetime_like: true } : {}),
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
    ...(message && looksLikeIsoDatetime(message) ? { error_datetime_like: true } : {}),
    ...(stack ? { error_stack: stack } : {}),
  };
}

export interface ConnectionShardCursorRuntimeOptions {
  clients: Map<string, ConnectedClient>;
  currentShardName: () => string;
  nowMs: () => number;
  deferDetachedTask: (task: () => Promise<void>) => void;
  maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  canRelayCursorNow: () => boolean;
  tileBatchIngressDepth: () => number;
  setCellSuppressedUntilMs: () => number;
  sendServerMessage: (client: ConnectedClient, message: ServerMessage) => void;
  logEvent: (event: string, fields: Record<string, unknown>) => void;
  setAlarm?: (scheduledTime: number) => Promise<void>;
  deleteAlarm?: () => Promise<void>;
  cursorHubGateway?: ConnectionShardCursorHubGateway | null;
  getPeerShardStub: (peerShard: string) => {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  };
  relayEnabled?: boolean;
}

export class ConnectionShardCursorRuntime {
  #clients: Map<string, ConnectedClient>;
  #currentShardName: () => string;
  #nowMs: () => number;
  #deferDetachedTask: (task: () => Promise<void>) => void;
  #maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  #canRelayCursorNow: () => boolean;
  #tileBatchIngressDepth: () => number;
  #setCellSuppressedUntilMs: () => number;
  #sendServerMessage: (client: ConnectedClient, message: ServerMessage) => void;
  #logEvent: (event: string, fields: Record<string, unknown>) => void;
  #getPeerShardStub: (peerShard: string) => {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  };
  #relayEnabled: boolean;

  #cursorBatchIngressDepth: number;
  #cursorStateIngressDepth: number;
  #cursorHubPublishSuppressedUntilMs: number;

  #cursorTraceState: ConnectionShardCursorTraceState;
  #cursorHubGateway: ConnectionShardCursorHubGateway | null;
  #cursorHubActivity: ConnectionShardCursorHubActivity;
  #cursorPullOrchestrator: ConnectionShardCursorPullOrchestrator;
  #cursorHubController: ConnectionShardCursorHubController;
  #cursorCoordinator: CursorCoordinator;

  constructor(options: ConnectionShardCursorRuntimeOptions) {
    this.#clients = options.clients;
    this.#currentShardName = options.currentShardName;
    this.#nowMs = options.nowMs;
    this.#deferDetachedTask = options.deferDetachedTask;
    this.#maybeUnrefTimer = options.maybeUnrefTimer;
    this.#canRelayCursorNow = options.canRelayCursorNow;
    this.#tileBatchIngressDepth = options.tileBatchIngressDepth;
    this.#setCellSuppressedUntilMs = options.setCellSuppressedUntilMs;
    this.#sendServerMessage = options.sendServerMessage;
    this.#logEvent = options.logEvent;
    this.#getPeerShardStub = options.getPeerShardStub;
    this.#relayEnabled = options.relayEnabled ?? false;

    this.#cursorBatchIngressDepth = 0;
    this.#cursorStateIngressDepth = 0;
    this.#cursorHubPublishSuppressedUntilMs = 0;

    this.#cursorTraceState = new ConnectionShardCursorTraceState({
      nowMs: () => this.#nowMs(),
    });
    this.#cursorHubGateway = options.cursorHubGateway ?? null;
    this.#cursorHubActivity = new ConnectionShardCursorHubActivity({
      gateway: this.#cursorHubGateway,
      currentShardName: () => this.#currentShardName(),
      nowMs: () => this.#nowMs(),
      deferDetachedTask: (task) => this.#deferDetachedTask(task),
    });
    this.#cursorPullOrchestrator = new ConnectionShardCursorPullOrchestrator({
      nowMs: () => this.#nowMs(),
      hasClients: () => this.#clients.size > 0,
      ingressDepth: () => this.#cursorStateIngressDepth,
      deferDetachedTask: (task) => this.#deferDetachedTask(task),
      maybeUnrefTimer: (timer) => this.#maybeUnrefTimer(timer),
      setAlarm: options.setAlarm,
      deleteAlarm: options.deleteAlarm,
      runAlarmFallback: async () => {
        await this.alarm();
      },
      pollPeerCursorStates: async (wakeReason) => this.#pollPeerCursorStates(wakeReason),
      logEvent: (event, fields) => this.#logEvent(event, fields),
    });
    this.#cursorHubController = new ConnectionShardCursorHubController({
      gateway: this.#cursorHubGateway,
      hasClients: () => this.#clients.size > 0,
      currentShardName: () => this.#currentShardName(),
      ingestBatch: (batch) => this.#receiveCursorBatch(batch),
      updateWatchedPeerShards: (peerShards) => this.updateCursorPullPeerShards(peerShards),
      deferDetachedTask: (task) => this.#deferDetachedTask(task),
      maybeUnrefTimer: (timer) => this.#maybeUnrefTimer(timer),
      watchRenewMs: CURSOR_HUB_WATCH_TIMING.renewMs,
      watchProbeRenewMs: CURSOR_HUB_WATCH_TIMING.probeRenewMs,
      watchSettleRenewMs: defaultCursorHubSettleRenewMs(),
      watchSettleWindowMs: CURSOR_HUB_WATCH_TIMING.settleWindowMs,
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
      canRelayNow: () => this.#canRelayNow(),
      onRelaySuppressed: ({ droppedCount, reason }) => {
        this.#logEvent("cursor_relay_suppressed", {
          dropped_count: droppedCount,
          reason,
          cursor_batch_ingress_depth: this.#cursorBatchIngressDepth,
          tile_batch_ingress_depth: this.#tileBatchIngressDepth(),
          setcell_suppressed_remaining_ms: Math.max(
            0,
            this.#setCellSuppressedUntilMs() - this.#nowMs()
          ),
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
      sendServerMessage: (client, message) => this.#sendServerMessage(client, message),
      relayEnabled: this.#relayEnabled,
    });
  }

  get traceState(): ConnectionShardCursorTraceState {
    return this.#cursorTraceState;
  }

  get hubGateway(): ConnectionShardCursorHubGateway | null {
    return this.#cursorHubGateway;
  }

  canRelayCursorNow(): boolean {
    return this.#canRelayNow();
  }

  onClientConnected(client: ConnectedClient): void {
    this.#cursorCoordinator.onClientConnected(client);
    this.refreshCursorPullSchedule();
    this.refreshWatchState();
  }

  onClientDisconnected(uid: string): void {
    this.#cursorCoordinator.onClientDisconnected(uid);
    this.refreshCursorPullSchedule();
    this.refreshWatchState();
  }

  onSubscriptionsChanged(force: boolean): void {
    this.#cursorCoordinator.onSubscriptionsChanged(force);
  }

  onActivity(): void {
    this.#cursorCoordinator.onActivity();
  }

  onLocalCursor(client: ConnectedClient, x: number, y: number): void {
    this.#cursorCoordinator.onLocalCursor(client, x, y);
  }

  markCursorPullActive(): void {
    this.#cursorPullOrchestrator.noteLocalActivity();
  }

  refreshCursorPullSchedule(): void {
    this.#cursorPullOrchestrator.refreshSchedule();
  }

  refreshWatchState(): void {
    this.#cursorHubController.refreshWatchState();
  }

  updateCursorPullPeerShards(peerShards: string[]): void {
    const nextPeerShards = this.#sanitizeCursorPullPeerShards(peerShards);
    this.#cursorPullOrchestrator.updatePeerShards(nextPeerShards);
  }

  peerScopeFields(peerShard: string, nowMs: number = this.#nowMs()): Record<string, unknown> {
    return this.#cursorPullOrchestrator.peerScopeFields(peerShard, nowMs);
  }

  markFirstVisibility(
    peerShard: string,
    batchUpdateCount: number,
    deltaObserved: boolean
  ): boolean {
    return this.#cursorPullOrchestrator.markFirstVisibility(peerShard, batchUpdateCount, deltaObserved);
  }

  markPreVisibilityOutcome(peerShard: string, outcomeKey: string): boolean {
    return this.#cursorPullOrchestrator.markPreVisibilityOutcome(peerShard, outcomeKey);
  }

  resolveHelloSpawn(): Promise<{ x: number; y: number } | null> {
    return this.#cursorHubActivity.resolveHelloSpawn();
  }

  recordRecentEditActivity(tileKey: string, index: number): void {
    this.#cursorHubActivity.recordRecentEditActivity(tileKey, index);
  }

  async handleRequest(request: Request): Promise<Response | null> {
    const url = new URL(request.url);

    if (url.pathname === "/cursor-batch" && request.method === "POST") {
      return this.handleCursorBatchRequest(request);
    }

    if (url.pathname === "/cursor-state" && request.method === "GET") {
      return this.handleCursorStateRequest(request);
    }

    return null;
  }

  async handleCursorBatchRequest(request: Request): Promise<Response> {
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
      readBatch: async (incomingRequest) => readJson<CursorRelayBatch>(incomingRequest),
      receiveBatch: (batch) => {
        this.#receiveCursorBatch(batch);
      },
      logEvent: (event, fields) => {
        this.#logEvent(event, fields);
      },
    });
  }

  async handleCursorStateRequest(request: Request): Promise<Response> {
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

  async alarm(): Promise<void> {
    let wake: CursorPullAlarmWake | null = null;
    let failureStage = "consume_wake";
    const alarmStateBeforeConsume = this.#cursorPullOrchestrator.alarmStateFields();
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
        ...prefixedFields("pre_", alarmStateBeforeConsume),
        failure_stage: failureStage,
        ...errorFields(error, { includeStack: true }),
      });
      throw error;
    }
  }

  clearDetachedAlarm(): void {
    this.#cursorPullOrchestrator.clearDetachedAlarm();
  }

  suppressionRemainingMs(): number {
    return this.#cursorPullOrchestrator.suppressionRemainingMs();
  }

  alarmStateFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return this.#cursorPullOrchestrator.alarmStateFields(overrides);
  }

  #receiveCursorBatch(batch: CursorRelayBatch): boolean {
    return this.#cursorCoordinator.onCursorBatch(batch);
  }

  #canRelayNow(): boolean {
    if (this.#cursorHubPublishSuppressedUntilMs > this.#nowMs()) {
      return false;
    }
    return this.#canRelayCursorNow();
  }

  #peerShardNames(currentShard: string): string[] {
    if (this.#cursorHubController.isEnabled()) {
      return this.#cursorPullOrchestrator.peerShards;
    }
    return peerShardNames(currentShard);
  }

  #sanitizeCursorPullPeerShards(peerShards: string[]): string[] {
    const currentShard = this.#currentShardName();
    const allowedPeerShards = new Set(peerShardNames(currentShard));
    return Array.from(new Set(peerShards))
      .filter((peerShard) => allowedPeerShards.has(peerShard))
      .sort();
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

  async #pollPeerCursorStates(wakeReason: CursorPullWakeReason): Promise<boolean> {
    const startMs = this.#nowMs();
    const peers = this.#peerShardNames(this.#currentShardName());
    if (peers.length === 0) {
      this.#cursorCoordinator.onCursorPollTick();
      this.#logEvent("cursor_pull_cycle", {
        wake_reason: wakeReason,
        peer_count: 0,
        delta_observed: false,
        duration_ms: Math.max(0, this.#nowMs() - startMs),
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
      concurrency: CURSOR_PULL_TIMING.concurrency,
      delta_observed: deltaObserved,
      duration_ms: Math.max(0, this.#nowMs() - startMs),
    });
    return deltaObserved;
  }

  async #pollPeerCursorState(peerShard: string, wakeReason: CursorPullWakeReason): Promise<boolean> {
    const startMs = this.#nowMs();
    const pullTraceId = createCursorTraceId();
    const peerScopeFields = this.peerScopeFields(peerShard, startMs);
    try {
      const response = await this.#getPeerShardStub(peerShard).fetch("https://connection-shard.internal/cursor-state", {
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
          duration_ms: Math.max(0, this.#nowMs() - startMs),
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
          duration_ms: Math.max(0, this.#nowMs() - startMs),
        });
        return false;
      }

      const deltaObserved = this.#receiveCursorBatch(batch);
      const batchMaxSeq = this.#cursorSnapshotMaxSeq(batch.updates);
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
        duration_ms: Math.max(0, this.#nowMs() - startMs),
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
        duration_ms: Math.max(0, this.#nowMs() - startMs),
        error_message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
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
      duration_ms: Math.max(0, this.#nowMs() - startedAtMs),
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
      max_seq: this.#cursorSnapshotMaxSeq(batch.updates) || undefined,
      uid_sample: this.#cursorSnapshotUidSample(batch.updates),
      delta_observed: false,
      trace_id: pullTraceId,
      ...peerScopeFields,
      duration_ms: Math.max(0, this.#nowMs() - startedAtMs),
    });
  }
}
