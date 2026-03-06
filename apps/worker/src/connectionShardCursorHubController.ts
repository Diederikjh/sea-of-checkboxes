import type { CursorPresence, CursorRelayBatch, CursorTraceContext } from "./cursorRelay";

export interface ConnectionShardCursorHubGatewayLike {
  watchShard(shard: string, action: "sub" | "unsub"): Promise<CursorRelayBatch | null>;
  publishLocalCursors(
    from: string,
    updates: CursorPresence[],
    trace?: CursorTraceContext | null
  ): Promise<void>;
}

interface ConnectionShardCursorHubControllerOptions {
  gateway: ConnectionShardCursorHubGatewayLike | null;
  hasClients: () => boolean;
  currentShardName: () => string;
  canRelayNow: () => boolean;
  activeTraceContext?: () => CursorTraceContext | null;
  localCursorSnapshot: () => CursorPresence[];
  ingestBatch: (batch: CursorRelayBatch) => void;
  deferDetachedTask: (task: () => Promise<void>) => void;
  maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  publishFlushMs?: number;
  watchRenewMs?: number;
}

export class ConnectionShardCursorHubController {
  #gateway: ConnectionShardCursorHubGatewayLike | null;
  #hasClients: () => boolean;
  #currentShardName: () => string;
  #canRelayNow: () => boolean;
  #activeTraceContext: () => CursorTraceContext | null;
  #localCursorSnapshot: () => CursorPresence[];
  #ingestBatch: (batch: CursorRelayBatch) => void;
  #deferDetachedTask: (task: () => Promise<void>) => void;
  #maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  #publishFlushMs: number;
  #watchRenewMs: number;

  #subscribed: boolean;
  #watchInFlight: boolean;
  #desiredWatchAction: "sub" | "unsub" | null;
  #watchRenewTimer: ReturnType<typeof setTimeout> | null;
  #publishTimer: ReturnType<typeof setTimeout> | null;
  #publishInFlight: boolean;
  #publishPending: boolean;
  #pendingPublishTrace: CursorTraceContext | null;

  constructor(options: ConnectionShardCursorHubControllerOptions) {
    this.#gateway = options.gateway;
    this.#hasClients = options.hasClients;
    this.#currentShardName = options.currentShardName;
    this.#canRelayNow = options.canRelayNow;
    this.#activeTraceContext = options.activeTraceContext ?? (() => null);
    this.#localCursorSnapshot = options.localCursorSnapshot;
    this.#ingestBatch = options.ingestBatch;
    this.#deferDetachedTask = options.deferDetachedTask;
    this.#maybeUnrefTimer = options.maybeUnrefTimer;
    this.#publishFlushMs = options.publishFlushMs ?? 50;
    this.#watchRenewMs = options.watchRenewMs ?? 60_000;

    this.#subscribed = false;
    this.#watchInFlight = false;
    this.#desiredWatchAction = null;
    this.#watchRenewTimer = null;
    this.#publishTimer = null;
    this.#publishInFlight = false;
    this.#publishPending = false;
    this.#pendingPublishTrace = null;
  }

  isEnabled(): boolean {
    return this.#gateway !== null;
  }

  refreshWatchState(): void {
    if (!this.#gateway) {
      return;
    }

    if (!this.#hasClients()) {
      this.#clearWatchRenewTimer();
      this.#clearPublishTimer();
      this.#publishPending = false;
      this.#pendingPublishTrace = null;
      if (this.#subscribed) {
        this.#queueWatch("unsub");
      } else {
        this.#desiredWatchAction = null;
      }
      return;
    }

    this.#queueWatch("sub");
    this.#scheduleWatchRenew(this.#watchRenewMs);
  }

  markLocalCursorDirty(): void {
    this.#publishPending = true;
    this.#pendingPublishTrace ??= this.#activeTraceContext();
    this.#schedulePublish();
  }

  #queueWatch(action: "sub" | "unsub"): void {
    if (!this.#gateway) {
      return;
    }

    this.#desiredWatchAction = action;
    void this.#runWatchLoop();
  }

  async #runWatchLoop(): Promise<void> {
    if (!this.#gateway || this.#watchInFlight) {
      return;
    }

    const action = this.#desiredWatchAction;
    if (!action) {
      return;
    }
    this.#desiredWatchAction = null;
    this.#watchInFlight = true;

    try {
      const snapshot = await this.#gateway.watchShard(this.#currentShardName(), action);
      if (action === "sub") {
        this.#subscribed = true;
        this.#scheduleWatchRenew(this.#watchRenewMs);
        if (snapshot && snapshot.updates.length > 0) {
          this.#ingestBatch(snapshot);
        }
        if (this.#publishPending) {
          this.#schedulePublish(0);
        }
      } else {
        this.#subscribed = false;
      }
    } catch {
      // Hub watch registration is best-effort.
    } finally {
      this.#watchInFlight = false;
      if (this.#desiredWatchAction) {
        this.#deferDetachedTask(async () => {
          await this.#runWatchLoop();
        });
      }
    }
  }

  #scheduleWatchRenew(delayMs: number): void {
    if (!this.#gateway || !this.#hasClients()) {
      return;
    }
    if (this.#watchRenewTimer) {
      return;
    }

    this.#watchRenewTimer = setTimeout(() => {
      this.#watchRenewTimer = null;
      if (!this.#hasClients()) {
        return;
      }
      this.#queueWatch("sub");
    }, Math.max(1, delayMs));
    this.#maybeUnrefTimer(this.#watchRenewTimer);
  }

  #clearWatchRenewTimer(): void {
    if (!this.#watchRenewTimer) {
      return;
    }
    clearTimeout(this.#watchRenewTimer);
    this.#watchRenewTimer = null;
  }

  #schedulePublish(delayMs: number = this.#publishFlushMs): void {
    if (!this.#gateway || !this.#hasClients()) {
      return;
    }

    if (!this.#subscribed) {
      this.#queueWatch("sub");
      return;
    }

    if (this.#publishTimer) {
      return;
    }

    this.#publishTimer = setTimeout(() => {
      this.#publishTimer = null;
      void this.#flushPublish();
    }, Math.max(0, delayMs));
    this.#maybeUnrefTimer(this.#publishTimer);
  }

  #clearPublishTimer(): void {
    if (!this.#publishTimer) {
      return;
    }

    clearTimeout(this.#publishTimer);
    this.#publishTimer = null;
  }

  async #flushPublish(): Promise<void> {
    if (!this.#gateway || !this.#hasClients() || !this.#subscribed) {
      return;
    }

    if (this.#publishInFlight) {
      this.#publishPending = true;
      return;
    }

    if (!this.#canRelayNow()) {
      this.#schedulePublish(this.#publishFlushMs);
      return;
    }

    const updates = this.#localCursorSnapshot();
    if (updates.length === 0) {
      this.#publishPending = false;
      this.#pendingPublishTrace = null;
      return;
    }

    this.#publishInFlight = true;
    try {
      await this.#gateway.publishLocalCursors(
        this.#currentShardName(),
        updates,
        this.#pendingPublishTrace ?? this.#activeTraceContext()
      );
      this.#publishPending = false;
      this.#pendingPublishTrace = null;
    } catch {
      // Hub publish is best-effort.
    } finally {
      this.#publishInFlight = false;
      if (this.#publishPending) {
        this.#schedulePublish(0);
      }
    }
  }
}
