import type { CursorRelayBatch } from "./cursorRelay";
import type { CursorHubWatchResponse } from "./cursorHubGateway";

export interface ConnectionShardCursorHubGatewayLike {
  watchShard(shard: string, action: "sub" | "unsub"): Promise<CursorHubWatchResponse | null>;
}

interface ConnectionShardCursorHubControllerOptions {
  gateway: ConnectionShardCursorHubGatewayLike | null;
  hasClients: () => boolean;
  currentShardName: () => string;
  ingestBatch: (batch: CursorRelayBatch) => void;
  updateWatchedPeerShards: (peerShards: string[]) => void;
  deferDetachedTask: (task: () => Promise<void>) => void;
  maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  watchRenewMs?: number;
  watchProbeRenewMs?: number;
}

export class ConnectionShardCursorHubController {
  #gateway: ConnectionShardCursorHubGatewayLike | null;
  #hasClients: () => boolean;
  #currentShardName: () => string;
  #ingestBatch: (batch: CursorRelayBatch) => void;
  #updateWatchedPeerShards: (peerShards: string[]) => void;
  #deferDetachedTask: (task: () => Promise<void>) => void;
  #maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  #watchRenewMs: number;
  #watchProbeRenewMs: number;

  #subscribed: boolean;
  #watchInFlight: boolean;
  #desiredWatchAction: "sub" | "unsub" | null;
  #watchRenewTimer: ReturnType<typeof setTimeout> | null;
  #watchedPeerCount: number;

  constructor(options: ConnectionShardCursorHubControllerOptions) {
    this.#gateway = options.gateway;
    this.#hasClients = options.hasClients;
    this.#currentShardName = options.currentShardName;
    this.#ingestBatch = options.ingestBatch;
    this.#updateWatchedPeerShards = options.updateWatchedPeerShards;
    this.#deferDetachedTask = options.deferDetachedTask;
    this.#maybeUnrefTimer = options.maybeUnrefTimer;
    this.#watchRenewMs = options.watchRenewMs ?? 60_000;
    this.#watchProbeRenewMs = options.watchProbeRenewMs ?? 500;

    this.#subscribed = false;
    this.#watchInFlight = false;
    this.#desiredWatchAction = null;
    this.#watchRenewTimer = null;
    this.#watchedPeerCount = 0;
  }

  isEnabled(): boolean {
    return this.#gateway !== null;
  }

  refreshWatchState(): void {
    if (!this.#gateway) {
      return;
    }

    if (!this.#hasClients()) {
      this.#resetPeerScopeState();
      if (this.#subscribed) {
        this.#queueWatch("unsub");
      } else {
        this.#desiredWatchAction = null;
      }
      return;
    }

    this.#queueWatch("sub");
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
      const watchState = await this.#gateway.watchShard(this.#currentShardName(), action);
      if (action === "sub") {
        this.#subscribed = true;
        this.#applyWatchState(watchState);
      } else {
        this.#subscribed = false;
        this.#resetPeerScopeState();
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

  #applyWatchState(watchState: CursorHubWatchResponse | null): void {
    const peerShards = watchState?.peerShards ?? [];
    this.#watchedPeerCount = peerShards.length;
    this.#clearWatchRenewTimer();
    this.#scheduleWatchRenew(this.#currentRenewDelayMs());
    this.#updateWatchedPeerShards(peerShards);
    if (watchState?.snapshot && watchState.snapshot.updates.length > 0) {
      this.#ingestBatch(watchState.snapshot);
    }
  }

  #resetPeerScopeState(): void {
    this.#clearWatchRenewTimer();
    this.#watchedPeerCount = 0;
    this.#updateWatchedPeerShards([]);
  }

  #currentRenewDelayMs(): number {
    return this.#watchedPeerCount > 0 ? this.#watchRenewMs : this.#watchProbeRenewMs;
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
