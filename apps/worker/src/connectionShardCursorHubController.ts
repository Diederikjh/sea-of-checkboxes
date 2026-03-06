import type { CursorRelayBatch } from "./cursorRelay";

export interface ConnectionShardCursorHubGatewayLike {
  watchShard(shard: string, action: "sub" | "unsub"): Promise<CursorRelayBatch | null>;
}

interface ConnectionShardCursorHubControllerOptions {
  gateway: ConnectionShardCursorHubGatewayLike | null;
  hasClients: () => boolean;
  currentShardName: () => string;
  ingestBatch: (batch: CursorRelayBatch) => void;
  deferDetachedTask: (task: () => Promise<void>) => void;
  maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  watchRenewMs?: number;
}

export class ConnectionShardCursorHubController {
  #gateway: ConnectionShardCursorHubGatewayLike | null;
  #hasClients: () => boolean;
  #currentShardName: () => string;
  #ingestBatch: (batch: CursorRelayBatch) => void;
  #deferDetachedTask: (task: () => Promise<void>) => void;
  #maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  #watchRenewMs: number;

  #subscribed: boolean;
  #watchInFlight: boolean;
  #desiredWatchAction: "sub" | "unsub" | null;
  #watchRenewTimer: ReturnType<typeof setTimeout> | null;

  constructor(options: ConnectionShardCursorHubControllerOptions) {
    this.#gateway = options.gateway;
    this.#hasClients = options.hasClients;
    this.#currentShardName = options.currentShardName;
    this.#ingestBatch = options.ingestBatch;
    this.#deferDetachedTask = options.deferDetachedTask;
    this.#maybeUnrefTimer = options.maybeUnrefTimer;
    this.#watchRenewMs = options.watchRenewMs ?? 60_000;

    this.#subscribed = false;
    this.#watchInFlight = false;
    this.#desiredWatchAction = null;
    this.#watchRenewTimer = null;
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
}
