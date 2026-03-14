import {
  ConnectionShardCursorPullScheduler,
  type CursorPullScheduleDecision,
  type CursorPullWakeReason,
} from "./connectionShardCursorPullScheduler";
import { ConnectionShardCursorPullIngressGate } from "./connectionShardCursorPullIngressGate";
import { ConnectionShardCursorPullPeerScopeTracker } from "./connectionShardCursorPullPeerScopeTracker";
import { CURSOR_PULL_TIMING } from "./cursorTimingConfig";

interface CursorPullFirstPostScopeState {
  observedAtMs: number;
  peerCount: number;
}

export interface CursorPullAlarmWake {
  wakeReason: CursorPullWakeReason;
  scheduledAtMs: number | null;
}

interface CursorPullOrchestratorOptions {
  nowMs: () => number;
  hasClients: () => boolean;
  ingressDepth: () => number;
  deferDetachedTask: (task: () => Promise<void>) => void;
  maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  setAlarm?: ((scheduledTime: number) => Promise<void>) | undefined;
  deleteAlarm?: (() => Promise<void>) | undefined;
  runAlarmFallback: () => Promise<void>;
  pollPeerCursorStates: (wakeReason: CursorPullWakeReason) => Promise<boolean>;
  logEvent: (event: string, fields: Record<string, unknown>) => void;
}

export class ConnectionShardCursorPullOrchestrator {
  #nowMs: () => number;
  #hasClients: () => boolean;
  #ingressDepth: () => number;
  #deferDetachedTask: (task: () => Promise<void>) => void;
  #setAlarm: ((scheduledTime: number) => Promise<void>) | undefined;
  #deleteAlarm: (() => Promise<void>) | undefined;
  #runAlarmFallback: () => Promise<void>;
  #pollPeerCursorStates: (wakeReason: CursorPullWakeReason) => Promise<boolean>;
  #logEvent: (event: string, fields: Record<string, unknown>) => void;

  #inFlight: boolean;
  #intervalMs: number;
  #quietStreak: number;
  #activeUntilMs: number;
  #peerScopeTracker: ConnectionShardCursorPullPeerScopeTracker;
  #suppressedUntilMs: number;
  #pendingWakeReason: CursorPullWakeReason | null;
  #alarmArmed: boolean;
  #alarmScheduledAtMs: number | null;
  #firstPostScopeState: CursorPullFirstPostScopeState | null;
  #scheduler: ConnectionShardCursorPullScheduler;
  #ingressGate: ConnectionShardCursorPullIngressGate;

  constructor(options: CursorPullOrchestratorOptions) {
    this.#nowMs = options.nowMs;
    this.#hasClients = options.hasClients;
    this.#ingressDepth = options.ingressDepth;
    this.#deferDetachedTask = options.deferDetachedTask;
    this.#setAlarm = options.setAlarm;
    this.#deleteAlarm = options.deleteAlarm;
    this.#runAlarmFallback = options.runAlarmFallback;
    this.#pollPeerCursorStates = options.pollPeerCursorStates;
    this.#logEvent = options.logEvent;

    this.#inFlight = false;
    this.#intervalMs = CURSOR_PULL_TIMING.intervalMinMs;
    this.#quietStreak = 0;
    this.#activeUntilMs = 0;
    this.#peerScopeTracker = new ConnectionShardCursorPullPeerScopeTracker();
    this.#suppressedUntilMs = 0;
    this.#pendingWakeReason = null;
    this.#alarmArmed = false;
    this.#alarmScheduledAtMs = null;
    this.#firstPostScopeState = null;
    this.#scheduler = new ConnectionShardCursorPullScheduler({
      nowMs: this.#nowMs,
      maybeUnrefTimer: options.maybeUnrefTimer,
      onTick: (wakeReason) => {
        this.queueDetachedTick(wakeReason);
      },
      minIntervalMs: CURSOR_PULL_TIMING.intervalMinMs,
      jitterMs: CURSOR_PULL_TIMING.jitterMs,
    });
    this.#ingressGate = new ConnectionShardCursorPullIngressGate({
      deferDetachedTask: this.#deferDetachedTask,
      onFlush: (wakeReason) => {
        this.scheduleTick(
          wakeReason === "timer" ? CURSOR_PULL_TIMING.intervalMinMs : 0,
          wakeReason
        );
      },
    });
  }

  get peerShards(): string[] {
    return this.#peerScopeTracker.peerShards;
  }

  peerScopeFields(peerShard: string, nowMs: number = this.#nowMs()): Record<string, unknown> {
    return this.#peerScopeTracker.scopeFields(peerShard, nowMs);
  }

  markFirstVisibility(
    peerShard: string,
    batchUpdateCount: number,
    deltaObserved: boolean
  ): boolean {
    return this.#peerScopeTracker.markFirstVisibility(peerShard, batchUpdateCount, deltaObserved);
  }

  markPreVisibilityOutcome(peerShard: string, outcomeKey: string): boolean {
    return this.#peerScopeTracker.markPreVisibilityOutcome(peerShard, outcomeKey);
  }

  refreshSchedule(): void {
    if (!this.#hasClients()) {
      this.#reset();
      return;
    }

    if (this.#peerScopeTracker.peerShards.length === 0) {
      this.#scheduler.reset();
      this.#ingressGate.reset();
      this.clearDetachedAlarm();
      this.#intervalMs = CURSOR_PULL_TIMING.intervalMinMs;
      this.#quietStreak = 0;
      this.#activeUntilMs = 0;
      this.#peerScopeTracker.reset();
      this.#suppressedUntilMs = 0;
      this.#firstPostScopeState = null;
      return;
    }

    this.#intervalMs = CURSOR_PULL_TIMING.intervalMinMs;
    this.#quietStreak = 0;
    this.#activeUntilMs = this.#nowMs() + CURSOR_PULL_TIMING.activityWindowMs;
    this.scheduleTick(0, "schedule_refresh");
  }

  noteLocalActivity(): void {
    if (!this.#hasClients()) {
      return;
    }
    if (this.#peerScopeTracker.peerShards.length === 0) {
      return;
    }

    this.#intervalMs = CURSOR_PULL_TIMING.intervalMinMs;
    this.#quietStreak = 0;

    if (!this.#inFlight) {
      this.scheduleTick(0, "local_activity");
    }
  }

  updatePeerShards(nextPeerShards: string[]): void {
    const nowMs = this.#nowMs();
    const change = this.#peerScopeTracker.replacePeerShards(nextPeerShards, nowMs);
    if (!change.changed) {
      if (this.#hasClients() && nextPeerShards.length > 0) {
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

    if (!this.#hasClients()) {
      return;
    }

    if (nextPeerShards.length === 0) {
      this.#firstPostScopeState = null;
      this.clearTimer();
      this.clearDetachedAlarm();
      this.#activeUntilMs = 0;
      return;
    }

    if (change.previousPeerShards.length === 0) {
      this.#firstPostScopeState = {
        observedAtMs: nowMs,
        peerCount: nextPeerShards.length,
      };
    }

    this.#activeUntilMs = this.#nowMs() + CURSOR_PULL_TIMING.activityWindowMs;
    if (!this.#inFlight) {
      this.clearTimer();
      this.scheduleTick(0, "watch_scope_change");
    }
  }

  flushAfterIngressExited(): void {
    this.#ingressGate.flushAfterIngressExited();
  }

  consumeAlarmWake(): CursorPullAlarmWake | null {
    this.#alarmArmed = false;
    const scheduledAtMs = this.#alarmScheduledAtMs;
    this.#alarmScheduledAtMs = null;
    const wakeReason = this.#pendingWakeReason;
    this.#pendingWakeReason = null;
    if (!wakeReason) {
      return null;
    }
    return { wakeReason, scheduledAtMs };
  }

  async runTick(wakeReason: CursorPullWakeReason): Promise<void> {
    if (!this.#hasClients()) {
      this.#logFirstPostScopeDecisionIfPending("aborted_no_clients", wakeReason, {
        suppressionRemainingMs: this.suppressionRemainingMs(),
      });
      this.#firstPostScopeState = null;
      return;
    }

    if (this.#ingressDepth() > 0) {
      this.#logFirstPostScopeDecisionIfPending("delayed_for_ingress", wakeReason, {
        suppressionRemainingMs: this.suppressionRemainingMs(),
      });
      this.#ingressGate.defer(wakeReason);
      return;
    }

    const firstPostScopeState = this.#firstPostScopeState;
    const suppressedDelayMs = this.suppressionRemainingMs();
    const bypassSuppressionOnce = firstPostScopeState !== null && suppressedDelayMs > 0;
    if (suppressedDelayMs > 0 && !bypassSuppressionOnce) {
      this.#logFirstPostScopeDecisionIfPending("delayed_for_suppression", wakeReason, {
        suppressionRemainingMs: suppressedDelayMs,
      });
      this.scheduleTick(suppressedDelayMs, wakeReason);
      return;
    }
    if (bypassSuppressionOnce) {
      this.#logFirstPostScopeDecisionIfPending("started_with_suppression_bypass", wakeReason, {
        suppressionRemainingMs: suppressedDelayMs,
      });
    }

    if (this.#inFlight) {
      this.#logFirstPostScopeDecisionIfPending("delayed_for_in_flight", wakeReason, {
        suppressionRemainingMs: suppressedDelayMs,
      });
      this.scheduleTick(CURSOR_PULL_TIMING.intervalMinMs, "timer");
      return;
    }

    if (!bypassSuppressionOnce) {
      this.#logFirstPostScopeDecisionIfPending("started", wakeReason, {
        suppressionRemainingMs: suppressedDelayMs,
      });
    }

    this.#firstPostScopeState = null;
    this.#inFlight = true;
    this.#scheduler.markRunStarted();
    try {
      const deltaObserved = await this.#pollPeerCursorStates(wakeReason);
      this.#updateInterval(deltaObserved);
    } finally {
      this.#inFlight = false;
      this.#scheduler.markRunCompleted();
      this.scheduleTick(this.#intervalMs, "timer");
    }
  }

  alarmStateFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const nowMs = this.#nowMs();
    return {
      peer_count: this.#peerScopeTracker.peerShards.length,
      in_flight: this.#inFlight,
      interval_ms: this.#intervalMs,
      quiet_streak: this.#quietStreak,
      active_remaining_ms: Math.max(0, this.#activeUntilMs - nowMs),
      suppression_remaining_ms: this.suppressionRemainingMs(),
      ingress_depth: this.#ingressDepth(),
      alarm_armed: this.#alarmArmed,
      pending_wake_reason: this.#pendingWakeReason ?? undefined,
      scheduled_at_ms: this.#alarmScheduledAtMs ?? undefined,
      ...overrides,
    };
  }

  clearDetachedAlarm(): void {
    this.#pendingWakeReason = null;
    this.#alarmArmed = false;
    this.#alarmScheduledAtMs = null;
    if (this.#deleteAlarm) {
      void this.#deleteAlarm().catch(() => {});
    }
  }

  clearTimer(): void {
    this.#scheduler.clear();
  }

  scheduleTick(
    delayMs: number = this.#intervalMs,
    wakeReason: CursorPullWakeReason = "timer"
  ): void {
    if (!this.#hasClients()) {
      return;
    }
    if (this.#ingressDepth() > 0) {
      const beforeState = this.#ingressGate.inspectState();
      this.#ingressGate.defer(wakeReason);
      if (wakeReason === "watch_scope_change" || wakeReason === "local_activity") {
        const afterState = this.#ingressGate.inspectState();
        this.#logCursorPullWakeDecision({
          eventName: this.#wakeEventName(wakeReason),
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
          schedulerBeforeState: this.#scheduler.inspectState(),
          extraFields: {
            ingress_depth: this.#ingressDepth(),
            gate_pending_wake_reason_before: beforeState.pendingWakeReason ?? undefined,
            gate_pending_wake_reason_after: afterState.pendingWakeReason ?? undefined,
            gate_flush_queued: afterState.flushQueued,
          },
        });
      }
      return;
    }

    const suppressionRemainingMs = this.suppressionRemainingMs();
    const adjustedDelayMs = Math.max(delayMs, suppressionRemainingMs);
    const schedulerBeforeState = this.#scheduler.inspectState();
    const decision = this.#scheduler.schedule(adjustedDelayMs, wakeReason);
    if (wakeReason === "watch_scope_change" || wakeReason === "local_activity") {
      this.#logCursorPullWakeDecision({
        eventName: this.#wakeEventName(wakeReason),
        decision,
        requestedDelayMs: delayMs,
        adjustedDelayMs,
        suppressionRemainingMs,
        schedulerBeforeState,
      });
    }
  }

  queueDetachedTick(wakeReason: CursorPullWakeReason): void {
    if (!this.#hasClients()) {
      return;
    }
    if (this.#peerScopeTracker.peerShards.length === 0) {
      return;
    }
    if (
      !this.#pendingWakeReason
      || this.#wakePriority(wakeReason) > this.#wakePriority(this.#pendingWakeReason)
    ) {
      this.#pendingWakeReason = wakeReason;
    }

    if (this.#alarmArmed) {
      if (wakeReason === "watch_scope_change" || this.#pendingWakeReason === "watch_scope_change") {
        this.#logEvent("cursor_pull_alarm_armed", {
          ...this.alarmStateFields({
            action: "kept_existing",
            wake_reason: wakeReason,
          }),
        });
      }
      return;
    }

    this.#alarmArmed = true;
    this.#alarmScheduledAtMs = this.#nowMs();
    if (wakeReason === "watch_scope_change" || this.#pendingWakeReason === "watch_scope_change") {
      this.#logEvent("cursor_pull_alarm_armed", {
        ...this.alarmStateFields({
          action: "armed",
          wake_reason: wakeReason,
        }),
      });
    }

    if (this.#setAlarm) {
      void this.#setAlarm(this.#nowMs()).catch(() => {
        if (!this.#alarmArmed) {
          return;
        }
        this.#deferDetachedTask(async () => {
          await this.#runAlarmFallback();
        });
      });
      return;
    }

    this.#deferDetachedTask(async () => {
      await this.#runAlarmFallback();
    });
  }

  suppressionRemainingMs(): number {
    return Math.max(0, this.#suppressedUntilMs - this.#nowMs());
  }

  #reset(): void {
    this.#scheduler.reset();
    this.#ingressGate.reset();
    this.clearDetachedAlarm();
    this.#inFlight = false;
    this.#intervalMs = CURSOR_PULL_TIMING.intervalMinMs;
    this.#quietStreak = 0;
    this.#activeUntilMs = 0;
    this.#peerScopeTracker.reset();
    this.#suppressedUntilMs = 0;
    this.#firstPostScopeState = null;
  }

  #updateInterval(deltaObserved: boolean): void {
    if (deltaObserved || this.#nowMs() < this.#activeUntilMs) {
      this.#intervalMs = CURSOR_PULL_TIMING.intervalMinMs;
      this.#quietStreak = 0;
      return;
    }

    if (this.#intervalMs < CURSOR_PULL_TIMING.intervalMaxMs) {
      this.#intervalMs = Math.min(
        CURSOR_PULL_TIMING.intervalMaxMs,
        this.#intervalMs + CURSOR_PULL_TIMING.intervalBackoffStepMs
      );
      this.#quietStreak = 0;
      return;
    }

    this.#quietStreak += 1;
    if (this.#quietStreak < CURSOR_PULL_TIMING.idleStreakBeforeLongBackoff) {
      return;
    }

    this.#intervalMs = Math.min(
      CURSOR_PULL_TIMING.intervalIdleMaxMs,
      this.#intervalMs + CURSOR_PULL_TIMING.intervalIdleBackoffStepMs
    );
  }

  #wakePriority(wakeReason: CursorPullWakeReason): number {
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

  #wakeEventName(wakeReason: CursorPullWakeReason): string {
    switch (wakeReason) {
      case "local_activity":
        return "cursor_pull_local_activity_wake";
      case "watch_scope_change":
      default:
        return "cursor_pull_watch_scope_wake";
    }
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
    const pending = this.#firstPostScopeState;
    if (!pending) {
      return;
    }
    const nowMs = this.#nowMs();
    const schedulerState = this.#scheduler.inspectState();
    this.#logEvent("cursor_pull_first_post_scope_decision", {
      action,
      wake_reason: wakeReason,
      first_post_scope_observed_at_ms: pending.observedAtMs,
      first_post_scope_age_ms: Math.max(0, nowMs - pending.observedAtMs),
      peer_count: pending.peerCount,
      suppression_remaining_ms: suppressionRemainingMs,
      ingress_depth: this.#ingressDepth(),
      in_flight: this.#inFlight,
      scheduler_pending_wake_reason: schedulerState.wakeReason ?? undefined,
      scheduler_scheduled_at_ms: schedulerState.scheduledAtMs ?? undefined,
      scheduler_last_started_at_ms: schedulerState.lastStartedAtMs || undefined,
      scheduler_last_completed_at_ms: schedulerState.lastCompletedAtMs || undefined,
      alarm_armed: this.#alarmArmed,
      alarm_pending_wake_reason: this.#pendingWakeReason ?? undefined,
      alarm_scheduled_at_ms: this.#alarmScheduledAtMs ?? undefined,
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
    const schedulerAfterState = this.#scheduler.inspectState();
    this.#logEvent(eventName, {
      action: decision.action,
      wake_reason: decision.wakeReason,
      requested_delay_ms: requestedDelayMs,
      adjusted_delay_ms: adjustedDelayMs,
      floor_delay_ms: decision.floorDelayMs,
      effective_delay_ms: decision.effectiveDelayMs,
      suppression_remaining_ms: suppressionRemainingMs,
      ingress_depth: this.#ingressDepth(),
      previous_wake_reason: schedulerBeforeState.wakeReason ?? undefined,
      previous_scheduled_at_ms: schedulerBeforeState.scheduledAtMs ?? undefined,
      scheduled_at_ms: schedulerAfterState.scheduledAtMs ?? undefined,
      armed_wake_reason: schedulerAfterState.wakeReason ?? undefined,
      last_started_at_ms: schedulerAfterState.lastStartedAtMs || undefined,
      last_completed_at_ms: schedulerAfterState.lastCompletedAtMs || undefined,
      ...extraFields,
    });
  }
}
