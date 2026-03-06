import type { CursorTraceContext } from "./cursorRelay";

export const CURSOR_TRACE_ID_HEADER = "x-sea-cursor-trace-id";
export const CURSOR_TRACE_HOP_HEADER = "x-sea-cursor-trace-hop";
export const CURSOR_TRACE_ORIGIN_HEADER = "x-sea-cursor-trace-origin";

const DEFAULT_TRACE_CACHE_TTL_MS = 30_000;
const DEFAULT_TRACE_CACHE_MAX = 2_048;

export class ConnectionShardCursorTraceState {
  #nowMs: () => number;
  #traceCacheTtlMs: number;
  #traceCacheMax: number;
  #activeTrace: CursorTraceContext | null;
  #recentTraceSeenAt: Map<string, number>;
  #recentPublishTrace: CursorTraceContext | null;
  #recentPublishTraceUntilMs: number;

  constructor(options: {
    nowMs: () => number;
    traceCacheTtlMs?: number;
    traceCacheMax?: number;
  }) {
    this.#nowMs = options.nowMs;
    this.#traceCacheTtlMs = options.traceCacheTtlMs ?? DEFAULT_TRACE_CACHE_TTL_MS;
    this.#traceCacheMax = options.traceCacheMax ?? DEFAULT_TRACE_CACHE_MAX;
    this.#activeTrace = null;
    this.#recentTraceSeenAt = new Map();
    this.#recentPublishTrace = null;
    this.#recentPublishTraceUntilMs = 0;
  }

  readFromRequest(request: Request): CursorTraceContext | null {
    const traceId = request.headers.get(CURSOR_TRACE_ID_HEADER)?.trim() ?? "";
    const traceOrigin = request.headers.get(CURSOR_TRACE_ORIGIN_HEADER)?.trim() ?? "";
    const rawHop = request.headers.get(CURSOR_TRACE_HOP_HEADER)?.trim() ?? "";
    const traceHop = Number.parseInt(rawHop, 10);

    if (traceId.length === 0 || traceOrigin.length === 0 || !Number.isFinite(traceHop) || traceHop < 0) {
      return null;
    }

    return {
      traceId,
      traceHop,
      traceOrigin,
    };
  }

  traceFields(trace: CursorTraceContext | null): Record<string, unknown> {
    if (!trace) {
      return {};
    }

    return {
      trace_id: trace.traceId,
      trace_hop: trace.traceHop,
      trace_origin: trace.traceOrigin,
    };
  }

  hasSeenRecentTrace(traceId: string): boolean {
    this.#pruneRecentTraces();
    return this.#recentTraceSeenAt.has(traceId);
  }

  rememberTrace(traceId: string): void {
    this.#pruneRecentTraces();
    this.#recentTraceSeenAt.set(traceId, this.#nowMs());
    if (this.#recentTraceSeenAt.size <= this.#traceCacheMax) {
      return;
    }

    const overflow = this.#recentTraceSeenAt.size - this.#traceCacheMax;
    let removed = 0;
    for (const key of this.#recentTraceSeenAt.keys()) {
      this.#recentTraceSeenAt.delete(key);
      removed += 1;
      if (removed >= overflow) {
        break;
      }
    }
  }

  pushActiveTrace(trace: CursorTraceContext | null): CursorTraceContext | null {
    const previous = this.#activeTrace;
    this.#activeTrace = trace;
    return previous;
  }

  restoreActiveTrace(previous: CursorTraceContext | null): void {
    this.#activeTrace = previous;
  }

  rememberIngressTraceForPublish(trace: CursorTraceContext | null, publishWindowMs: number): void {
    if (!trace) {
      return;
    }

    this.#recentPublishTrace = trace;
    this.#recentPublishTraceUntilMs = Math.max(
      this.#recentPublishTraceUntilMs,
      this.#nowMs() + publishWindowMs
    );
  }

  activeTraceContext(): CursorTraceContext | null {
    if (this.#activeTrace) {
      return this.#activeTrace;
    }

    if (this.#recentPublishTrace && this.#nowMs() < this.#recentPublishTraceUntilMs) {
      return this.#recentPublishTrace;
    }

    this.#recentPublishTrace = null;
    this.#recentPublishTraceUntilMs = 0;
    return null;
  }

  clear(): void {
    this.#activeTrace = null;
    this.#recentTraceSeenAt.clear();
    this.#recentPublishTrace = null;
    this.#recentPublishTraceUntilMs = 0;
  }

  #pruneRecentTraces(): void {
    const cutoff = this.#nowMs() - this.#traceCacheTtlMs;
    for (const [traceId, seenAt] of this.#recentTraceSeenAt) {
      if (seenAt >= cutoff) {
        continue;
      }
      this.#recentTraceSeenAt.delete(traceId);
    }
  }
}
