export type CursorPullWakeReason =
  | "local_activity"
  | "schedule_refresh"
  | "timer"
  | "watch_scope_change";

export interface CursorPullSchedulerStateSnapshot {
  scheduledAtMs: number | null;
  wakeReason: CursorPullWakeReason | null;
  lastStartedAtMs: number;
  lastCompletedAtMs: number;
}

export interface CursorPullScheduleDecision {
  action: "scheduled_new" | "rescheduled_earlier" | "upgraded_existing" | "kept_existing";
  wakeReason: CursorPullWakeReason;
  requestedDelayMs: number;
  floorDelayMs: number;
  effectiveDelayMs: number;
  scheduledAtMs: number;
  existingScheduledAtMs: number | null;
  existingWakeReason: CursorPullWakeReason | null;
}

interface ConnectionShardCursorPullSchedulerOptions {
  nowMs: () => number;
  maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  onTick: (wakeReason: CursorPullWakeReason) => void;
  minIntervalMs: number;
  jitterMs: number;
}

export class ConnectionShardCursorPullScheduler {
  #nowMs: () => number;
  #maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  #onTick: (wakeReason: CursorPullWakeReason) => void;
  #minIntervalMs: number;
  #jitterMs: number;
  #timer: ReturnType<typeof setTimeout> | null;
  #scheduledAtMs: number | null;
  #wakeReason: CursorPullWakeReason | null;
  #lastStartedAtMs: number;
  #lastCompletedAtMs: number;

  constructor(options: ConnectionShardCursorPullSchedulerOptions) {
    this.#nowMs = options.nowMs;
    this.#maybeUnrefTimer = options.maybeUnrefTimer;
    this.#onTick = options.onTick;
    this.#minIntervalMs = options.minIntervalMs;
    this.#jitterMs = options.jitterMs;
    this.#timer = null;
    this.#scheduledAtMs = null;
    this.#wakeReason = null;
    this.#lastStartedAtMs = 0;
    this.#lastCompletedAtMs = 0;
  }

  schedule(delayMs: number, wakeReason: CursorPullWakeReason): CursorPullScheduleDecision {
    const nowMs = this.#nowMs();
    const floorDelayMs = Math.max(0, this.#earliestRunAtMs(delayMs, wakeReason) - nowMs);
    const effectiveDelayMs = wakeReason === "timer"
      ? this.#delayMsWithJitter(floorDelayMs)
      : floorDelayMs;
    const scheduledAtMs = nowMs + effectiveDelayMs;
    const existingScheduledAtMs = this.#scheduledAtMs;
    const existingWakeReason = this.#wakeReason;

    if (this.#timer) {
      const existingScheduledAtMsOrInfinity = existingScheduledAtMs ?? Number.POSITIVE_INFINITY;
      const existingWakeReasonOrTimer = existingWakeReason ?? "timer";
      if (scheduledAtMs >= existingScheduledAtMsOrInfinity) {
        if (this.#wakePriority(wakeReason) > this.#wakePriority(existingWakeReasonOrTimer)) {
          this.#wakeReason = wakeReason;
          return {
            action: "upgraded_existing",
            wakeReason,
            requestedDelayMs: delayMs,
            floorDelayMs,
            effectiveDelayMs,
            scheduledAtMs: existingScheduledAtMsOrInfinity,
            existingScheduledAtMs,
            existingWakeReason,
          };
        }
        return {
          action: "kept_existing",
          wakeReason,
          requestedDelayMs: delayMs,
          floorDelayMs,
          effectiveDelayMs,
          scheduledAtMs: existingScheduledAtMsOrInfinity,
          existingScheduledAtMs,
          existingWakeReason,
        };
      }

      clearTimeout(this.#timer);
      this.#timer = null;
      this.#scheduledAtMs = null;
    }

    this.#wakeReason = wakeReason;
    this.#scheduledAtMs = scheduledAtMs;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#scheduledAtMs = null;
      const scheduledWakeReason = this.#wakeReason ?? "timer";
      this.#wakeReason = null;
      this.#onTick(scheduledWakeReason);
    }, effectiveDelayMs);
    this.#maybeUnrefTimer(this.#timer);
    return {
      action: existingScheduledAtMs === null ? "scheduled_new" : "rescheduled_earlier",
      wakeReason,
      requestedDelayMs: delayMs,
      floorDelayMs,
      effectiveDelayMs,
      scheduledAtMs,
      existingScheduledAtMs,
      existingWakeReason,
    };
  }

  clear(): void {
    if (!this.#timer) {
      return;
    }
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#scheduledAtMs = null;
    this.#wakeReason = null;
  }

  reset(): void {
    this.clear();
    this.#lastStartedAtMs = 0;
    this.#lastCompletedAtMs = 0;
  }

  markRunStarted(): void {
    this.#lastStartedAtMs = this.#nowMs();
  }

  markRunCompleted(): void {
    this.#lastCompletedAtMs = this.#nowMs();
  }

  inspectState(): CursorPullSchedulerStateSnapshot {
    return {
      scheduledAtMs: this.#scheduledAtMs,
      wakeReason: this.#wakeReason,
      lastStartedAtMs: this.#lastStartedAtMs,
      lastCompletedAtMs: this.#lastCompletedAtMs,
    };
  }

  #delayMsWithJitter(delayMs: number): number {
    const baseDelayMs = Math.max(0, delayMs);
    if (baseDelayMs === 0) {
      return 0;
    }
    return baseDelayMs + Math.floor(Math.random() * (this.#jitterMs + 1));
  }

  #earliestRunAtMs(delayMs: number, wakeReason: CursorPullWakeReason): number {
    const nowMs = this.#nowMs();
    const requestedAtMs = nowMs + Math.max(0, delayMs);
    if (wakeReason === "timer") {
      return requestedAtMs;
    }

    const lastRunAtMs = Math.max(this.#lastStartedAtMs, this.#lastCompletedAtMs);
    if (lastRunAtMs <= 0) {
      return requestedAtMs;
    }

    return Math.max(requestedAtMs, lastRunAtMs + this.#minIntervalMs);
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
}
