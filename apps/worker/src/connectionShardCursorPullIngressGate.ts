import type { CursorPullWakeReason } from "./connectionShardCursorPullScheduler";

interface ConnectionShardCursorPullIngressGateOptions {
  deferDetachedTask: (task: () => Promise<void>) => void;
  onFlush: (wakeReason: CursorPullWakeReason) => void;
}

export interface CursorPullIngressGateStateSnapshot {
  pendingWakeReason: CursorPullWakeReason | null;
  flushQueued: boolean;
}

export class ConnectionShardCursorPullIngressGate {
  #deferDetachedTask: (task: () => Promise<void>) => void;
  #onFlush: (wakeReason: CursorPullWakeReason) => void;
  #pendingWakeReason: CursorPullWakeReason | null;
  #flushQueued: boolean;

  constructor(options: ConnectionShardCursorPullIngressGateOptions) {
    this.#deferDetachedTask = options.deferDetachedTask;
    this.#onFlush = options.onFlush;
    this.#pendingWakeReason = null;
    this.#flushQueued = false;
  }

  defer(wakeReason: CursorPullWakeReason): void {
    if (
      !this.#pendingWakeReason
      || this.#wakePriority(wakeReason) > this.#wakePriority(this.#pendingWakeReason)
    ) {
      this.#pendingWakeReason = wakeReason;
    }
  }

  flushAfterIngressExited(): void {
    if (this.#flushQueued || !this.#pendingWakeReason) {
      return;
    }

    this.#flushQueued = true;
    this.#deferDetachedTask(async () => {
      this.#flushQueued = false;
      const wakeReason = this.#pendingWakeReason;
      this.#pendingWakeReason = null;
      if (!wakeReason) {
        return;
      }
      this.#onFlush(wakeReason);
      if (this.#pendingWakeReason) {
        this.flushAfterIngressExited();
      }
    });
  }

  reset(): void {
    this.#pendingWakeReason = null;
    this.#flushQueued = false;
  }

  inspectState(): CursorPullIngressGateStateSnapshot {
    return {
      pendingWakeReason: this.#pendingWakeReason,
      flushQueued: this.#flushQueued,
    };
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
