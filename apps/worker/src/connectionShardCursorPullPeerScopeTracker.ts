export interface CursorPullPeerScopeChange {
  previousPeerShards: string[];
  nextPeerShards: string[];
  changed: boolean;
  oldestScopeAgeMs?: number;
}

export class ConnectionShardCursorPullPeerScopeTracker {
  #peerShards: string[];
  #scopeObservedAtMs: Map<string, number>;
  #firstVisibilityScopeObservedAtMs: Map<string, number>;

  constructor() {
    this.#peerShards = [];
    this.#scopeObservedAtMs = new Map();
    this.#firstVisibilityScopeObservedAtMs = new Map();
  }

  get peerShards(): string[] {
    return this.#peerShards;
  }

  reset(): void {
    this.#peerShards = [];
    this.#scopeObservedAtMs.clear();
    this.#firstVisibilityScopeObservedAtMs.clear();
  }

  replacePeerShards(nextPeerShards: string[], nowMs: number): CursorPullPeerScopeChange {
    const previousPeerShards = this.#peerShards;
    if (
      nextPeerShards.length === previousPeerShards.length
      && nextPeerShards.every((peerShard, index) => peerShard === previousPeerShards[index])
    ) {
      const oldestScopeAgeMs = this.oldestScopeAgeMs(nextPeerShards, nowMs);
      return {
        previousPeerShards,
        nextPeerShards,
        changed: false,
        ...(typeof oldestScopeAgeMs === "number" ? { oldestScopeAgeMs } : {}),
      };
    }

    this.#peerShards = nextPeerShards;
    if (nextPeerShards.length === 0) {
      this.#scopeObservedAtMs.clear();
      this.#firstVisibilityScopeObservedAtMs.clear();
      return {
        previousPeerShards,
        nextPeerShards,
        changed: true,
      };
    }

    const previousPeerShardSet = new Set(previousPeerShards);
    const nextPeerShardSet = new Set(nextPeerShards);

    for (const peerShard of Array.from(this.#scopeObservedAtMs.keys())) {
      if (nextPeerShardSet.has(peerShard)) {
        continue;
      }
      this.#scopeObservedAtMs.delete(peerShard);
      this.#firstVisibilityScopeObservedAtMs.delete(peerShard);
    }

    for (const peerShard of nextPeerShards) {
      if (previousPeerShardSet.has(peerShard)) {
        continue;
      }
      this.#scopeObservedAtMs.set(peerShard, nowMs);
      this.#firstVisibilityScopeObservedAtMs.delete(peerShard);
    }

    return {
      previousPeerShards,
      nextPeerShards,
      changed: true,
    };
  }

  scopeFields(peerShard: string, nowMs: number): Record<string, unknown> {
    const scopeObservedAtMs = this.#scopeObservedAtMs.get(peerShard);
    if (typeof scopeObservedAtMs !== "number") {
      return {};
    }
    return {
      scope_observed_at_ms: scopeObservedAtMs,
      scope_age_ms: Math.max(0, nowMs - scopeObservedAtMs),
    };
  }

  markFirstVisibility(peerShard: string, batchUpdateCount: number): boolean {
    const scopeObservedAtMs = this.#scopeObservedAtMs.get(peerShard);
    if (typeof scopeObservedAtMs !== "number" || batchUpdateCount <= 0) {
      return false;
    }
    const loggedScopeObservedAtMs = this.#firstVisibilityScopeObservedAtMs.get(peerShard);
    if (loggedScopeObservedAtMs === scopeObservedAtMs) {
      return false;
    }
    this.#firstVisibilityScopeObservedAtMs.set(peerShard, scopeObservedAtMs);
    return true;
  }

  oldestScopeAgeMs(peerShards: string[], nowMs: number): number | undefined {
    let oldestObservedAtMs = Number.POSITIVE_INFINITY;
    for (const peerShard of peerShards) {
      const observedAtMs = this.#scopeObservedAtMs.get(peerShard);
      if (typeof observedAtMs !== "number") {
        continue;
      }
      oldestObservedAtMs = Math.min(oldestObservedAtMs, observedAtMs);
    }
    if (!Number.isFinite(oldestObservedAtMs)) {
      return undefined;
    }
    return Math.max(0, nowMs - oldestObservedAtMs);
  }
}
