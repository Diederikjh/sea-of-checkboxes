import { WORLD_MAX } from "@sea/domain";

import {
  jsonResponse,
  readJson,
  type DurableObjectStateLike,
  type Env,
} from "./doCommon";
import {
  isValidCursorPresence,
  type CursorTraceContext,
  type CursorPresence,
  type CursorRelayBatch,
} from "./cursorRelay";
import { createCursorTraceId } from "./connectionShardCursorTrace";
import {
  elapsedMs,
  logStructuredEvent,
} from "./observability";

const CURSOR_TTL_MS = 5_000;
const CURSOR_HUB_INTERNAL_SHARD = "cursor-hub";
const CURSOR_HUB_SHARD_HEADER = "x-sea-cursor-hub";
const CURSOR_TRACE_ID_HEADER = "x-sea-cursor-trace-id";
const CURSOR_TRACE_HOP_HEADER = "x-sea-cursor-trace-hop";
const CURSOR_TRACE_ORIGIN_HEADER = "x-sea-cursor-trace-origin";
const CURSOR_HUB_FANOUT_FLUSH_MS = 25;
const RECENT_EDIT_ACTIVITY_TTL_MS = 10 * 60_000;
const RECENT_EDIT_ACTIVITY_LIMIT = 2_048;
const SPAWN_SAMPLE_RECENT_EDIT_WINDOW = 128;
const SPAWN_SAMPLE_CURSOR_WINDOW = 128;
const SPAWN_JITTER_EDIT_MIN_CELLS = 2;
const SPAWN_JITTER_EDIT_MAX_CELLS = 20;
const SPAWN_JITTER_CURSOR_MIN_CELLS = 6;
const SPAWN_JITTER_CURSOR_MAX_CELLS = 40;

interface CursorHubWatchRequest {
  shard: string;
  action: "sub" | "unsub";
}

interface CursorHubWatchResponse {
  snapshot: CursorRelayBatch;
  peerShards: string[];
}

interface CursorHubPublishRequest {
  from: string;
  updates: CursorPresence[];
}

interface CursorHubActivityRequest {
  from: string;
  x: number;
  y: number;
  atMs: number;
}

interface StoredCursor {
  shard: string;
  presence: CursorPresence;
}

interface StoredEditActivity {
  x: number;
  y: number;
  atMs: number;
}

interface PendingFanout {
  originShard: string;
  trace: CursorTraceContext;
  updatesByUid: Map<string, CursorPresence>;
}

interface SpawnBase {
  x: number;
  y: number;
  source: "edit" | "cursor";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidWatchRequest(value: unknown): value is CursorHubWatchRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const request = value as Partial<CursorHubWatchRequest>;
  if (typeof request.shard !== "string" || request.shard.length === 0) {
    return false;
  }
  return request.action === "sub" || request.action === "unsub";
}

function isValidPublishRequest(value: unknown): value is CursorHubPublishRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const request = value as Partial<CursorHubPublishRequest>;
  if (typeof request.from !== "string" || request.from.length === 0) {
    return false;
  }
  if (!Array.isArray(request.updates)) {
    return false;
  }
  return request.updates.every((update) => isValidCursorPresence(update));
}

function isValidActivityRequest(value: unknown): value is CursorHubActivityRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const request = value as Partial<CursorHubActivityRequest>;
  if (typeof request.from !== "string" || request.from.length === 0) {
    return false;
  }
  if (!isFiniteNumber(request.x) || !isFiniteNumber(request.y)) {
    return false;
  }
  if (!isFiniteNumber(request.atMs) || request.atMs < 0) {
    return false;
  }

  return true;
}

export class CursorHubDO {
  #env: Env;
  #doId: string;
  #subscribers: Set<string>;
  #cursorByUid: Map<string, StoredCursor>;
  #recentEditActivity: StoredEditActivity[];
  #pendingFanoutByOrigin: Map<string, PendingFanout>;
  #fanoutFlushTimer: ReturnType<typeof setTimeout> | null;
  #fanoutInFlight: boolean;

  constructor(state: DurableObjectStateLike, env: Env) {
    this.#env = env;
    this.#doId = state.id.toString();
    this.#subscribers = new Set();
    this.#cursorByUid = new Map();
    this.#recentEditActivity = [];
    this.#pendingFanoutByOrigin = new Map();
    this.#fanoutFlushTimer = null;
    this.#fanoutInFlight = false;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/watch" && request.method === "POST") {
      return this.#handleWatch(request);
    }

    if (url.pathname === "/publish" && request.method === "POST") {
      return this.#handlePublish(request);
    }

    if (url.pathname === "/activity" && request.method === "POST") {
      return this.#handleActivity(request);
    }

    if (url.pathname === "/spawn-sample" && request.method === "GET") {
      return this.#handleSpawnSample();
    }

    return new Response("Not found", { status: 404 });
  }

  async #handleWatch(request: Request): Promise<Response> {
    const startMs = Date.now();
    const payload = await readJson<CursorHubWatchRequest>(request);
    if (!payload || !isValidWatchRequest(payload)) {
      return new Response("Invalid watch payload", { status: 400 });
    }

    this.#pruneStaleCursors();
    if (payload.action === "sub") {
      this.#subscribers.add(payload.shard);
      this.#logEvent("watch_sub", {
        shard: payload.shard,
        subscriber_count: this.#subscribers.size,
        duration_ms: elapsedMs(startMs),
      });
      return jsonResponse(this.#watchResponseForShard(payload.shard));
    }

    this.#subscribers.delete(payload.shard);
    this.#logEvent("watch_unsub", {
      shard: payload.shard,
      subscriber_count: this.#subscribers.size,
      duration_ms: elapsedMs(startMs),
    });
    return new Response(null, { status: 204 });
  }

  async #handlePublish(request: Request): Promise<Response> {
    const startMs = Date.now();
    const payload = await readJson<CursorHubPublishRequest>(request);
    if (!payload || !isValidPublishRequest(payload)) {
      return new Response("Invalid publish payload", { status: 400 });
    }
    const incomingTrace = this.#readTraceContext(request);
    const outgoingTrace: CursorTraceContext = {
      traceId: incomingTrace?.traceId ?? createCursorTraceId(),
      traceHop: (incomingTrace?.traceHop ?? 0) + 1,
      traceOrigin: incomingTrace?.traceOrigin ?? payload.from,
    };

    this.#subscribers.add(payload.from);
    this.#pruneStaleCursors();

    const acceptedUpdates: CursorPresence[] = [];
    for (const update of payload.updates) {
      const existing = this.#cursorByUid.get(update.uid);
      if (existing && existing.presence.seq >= update.seq) {
        continue;
      }
      this.#cursorByUid.set(update.uid, {
        shard: payload.from,
        presence: update,
      });
      acceptedUpdates.push(update);
    }

    if (acceptedUpdates.length > 0) {
      this.#enqueueFanout(
        payload.from,
        acceptedUpdates,
        outgoingTrace,
        incomingTrace ? `${payload.from}|${incomingTrace.traceId}` : `${payload.from}|generated`
      );
    }

    this.#logEvent("publish", {
      from: payload.from,
      incoming_count: payload.updates.length,
      accepted_count: acceptedUpdates.length,
      subscriber_count: this.#subscribers.size,
      cursor_count: this.#cursorByUid.size,
      trace_id: outgoingTrace.traceId,
      trace_hop: outgoingTrace.traceHop,
      trace_origin: outgoingTrace.traceOrigin,
      duration_ms: elapsedMs(startMs),
    });
    return new Response(null, { status: 204 });
  }

  async #handleActivity(request: Request): Promise<Response> {
    const startMs = Date.now();
    const payload = await readJson<CursorHubActivityRequest>(request);
    if (!payload || !isValidActivityRequest(payload)) {
      return new Response("Invalid activity payload", { status: 400 });
    }

    this.#subscribers.add(payload.from);
    this.#pruneStaleEditActivity();
    this.#recentEditActivity.push({
      x: clamp(payload.x, -WORLD_MAX, WORLD_MAX),
      y: clamp(payload.y, -WORLD_MAX, WORLD_MAX),
      atMs: payload.atMs,
    });

    if (this.#recentEditActivity.length > RECENT_EDIT_ACTIVITY_LIMIT) {
      const overflow = this.#recentEditActivity.length - RECENT_EDIT_ACTIVITY_LIMIT;
      this.#recentEditActivity.splice(0, overflow);
    }

    this.#logEvent("activity", {
      from: payload.from,
      edits_recent: this.#recentEditActivity.length,
      duration_ms: elapsedMs(startMs),
    });
    return new Response(null, { status: 204 });
  }

  #handleSpawnSample(): Response {
    this.#pruneStaleCursors();
    this.#pruneStaleEditActivity();

    const base = this.#sampleSpawnBase();
    if (!base) {
      return new Response(null, { status: 204 });
    }

    const jittered = this.#jitterSpawn(base);
    return jsonResponse({
      x: jittered.x,
      y: jittered.y,
      source: base.source,
    });
  }

  #watchResponseForShard(shard: string): CursorHubWatchResponse {
    const updates = Array.from(this.#cursorByUid.values())
      .filter((entry) => entry.shard !== shard)
      .map((entry) => entry.presence);
    const peerShards = Array.from(this.#subscribers)
      .filter((peerShard) => peerShard !== shard)
      .sort();
    return {
      snapshot: {
        from: CURSOR_HUB_INTERNAL_SHARD,
        updates,
      },
      peerShards,
    };
  }

  #pruneStaleCursors(): void {
    const cutoffMs = Date.now() - CURSOR_TTL_MS;
    for (const [uid, entry] of this.#cursorByUid) {
      if (entry.presence.seenAt >= cutoffMs) {
        continue;
      }
      this.#cursorByUid.delete(uid);
    }
  }

  #pruneStaleEditActivity(): void {
    const cutoffMs = Date.now() - RECENT_EDIT_ACTIVITY_TTL_MS;
    let writeIndex = 0;
    for (const activity of this.#recentEditActivity) {
      if (activity.atMs < cutoffMs) {
        continue;
      }
      this.#recentEditActivity[writeIndex] = activity;
      writeIndex += 1;
    }
    this.#recentEditActivity.length = writeIndex;
  }

  #sampleSpawnBase(): SpawnBase | null {
    if (this.#recentEditActivity.length > 0) {
      const start = Math.max(0, this.#recentEditActivity.length - SPAWN_SAMPLE_RECENT_EDIT_WINDOW);
      const candidates = this.#recentEditActivity.slice(start);
      const selected = candidates[Math.floor(Math.random() * candidates.length)];
      if (selected) {
        return {
          x: selected.x,
          y: selected.y,
          source: "edit",
        };
      }
    }

    if (this.#cursorByUid.size > 0) {
      const candidates = Array.from(this.#cursorByUid.values())
        .map((entry) => entry.presence)
        .sort((left, right) => right.seenAt - left.seenAt)
        .slice(0, SPAWN_SAMPLE_CURSOR_WINDOW);
      const selected = candidates[Math.floor(Math.random() * candidates.length)];
      if (selected) {
        return {
          x: selected.x,
          y: selected.y,
          source: "cursor",
        };
      }
    }

    return null;
  }

  #jitterSpawn(base: SpawnBase): { x: number; y: number } {
    const minRadius =
      base.source === "edit" ? SPAWN_JITTER_EDIT_MIN_CELLS : SPAWN_JITTER_CURSOR_MIN_CELLS;
    const maxRadius =
      base.source === "edit" ? SPAWN_JITTER_EDIT_MAX_CELLS : SPAWN_JITTER_CURSOR_MAX_CELLS;
    const angle = Math.random() * Math.PI * 2;
    const distance = minRadius + Math.sqrt(Math.random()) * (maxRadius - minRadius);
    const jitteredX = base.x + Math.cos(angle) * distance;
    const jitteredY = base.y + Math.sin(angle) * distance;
    return {
      x: clamp(jitteredX, -WORLD_MAX, WORLD_MAX),
      y: clamp(jitteredY, -WORLD_MAX, WORLD_MAX),
    };
  }

  #enqueueFanout(
    originShard: string,
    updates: CursorPresence[],
    trace: CursorTraceContext,
    pendingKey: string
  ): void {
    if (updates.length === 0) {
      return;
    }

    let pending = this.#pendingFanoutByOrigin.get(pendingKey);
    if (!pending) {
      pending = {
        originShard,
        trace,
        updatesByUid: new Map(),
      };
      this.#pendingFanoutByOrigin.set(pendingKey, pending);
    }

    for (const update of updates) {
      const existing = pending.updatesByUid.get(update.uid);
      if (existing && existing.seq >= update.seq) {
        continue;
      }
      pending.updatesByUid.set(update.uid, update);
    }

    this.#scheduleFanoutFlush();
  }

  #scheduleFanoutFlush(delayMs: number = CURSOR_HUB_FANOUT_FLUSH_MS): void {
    if (this.#fanoutFlushTimer) {
      return;
    }

    this.#fanoutFlushTimer = setTimeout(() => {
      this.#fanoutFlushTimer = null;
      void this.#flushFanoutQueue();
    }, Math.max(0, delayMs));
    this.#maybeUnrefTimer(this.#fanoutFlushTimer);
  }

  async #flushFanoutQueue(): Promise<void> {
    if (this.#fanoutInFlight || this.#pendingFanoutByOrigin.size === 0) {
      return;
    }

    this.#fanoutInFlight = true;
    const pending = Array.from(this.#pendingFanoutByOrigin.values()).map((entry) => ({
      originShard: entry.originShard,
      trace: entry.trace,
      updates: Array.from(entry.updatesByUid.values()),
    }));
    this.#pendingFanoutByOrigin.clear();

    try {
      await Promise.all(
        pending.map(async ({ originShard, trace, updates }) => {
          await this.#fanoutCursorUpdates(originShard, trace, updates);
        })
      );
    } finally {
      this.#fanoutInFlight = false;
      if (this.#pendingFanoutByOrigin.size > 0) {
        this.#scheduleFanoutFlush(0);
      }
    }
  }

  async #fanoutCursorUpdates(
    originShard: string,
    trace: CursorTraceContext,
    updates: CursorPresence[]
  ): Promise<void> {
    const targetShards = Array.from(this.#subscribers).filter((shard) => shard !== originShard);
    if (targetShards.length === 0 || updates.length === 0) {
      return;
    }

    const body = JSON.stringify({
      from: originShard,
      updates,
    } satisfies CursorRelayBatch);
    await Promise.all(
      targetShards.map(async (targetShard) => {
        try {
          await this.#env.CONNECTION_SHARD
            .getByName(targetShard)
            .fetch("https://connection-shard.internal/cursor-batch", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                [CURSOR_HUB_SHARD_HEADER]: "1",
                [CURSOR_TRACE_ID_HEADER]: trace.traceId,
                [CURSOR_TRACE_HOP_HEADER]: String(trace.traceHop),
                [CURSOR_TRACE_ORIGIN_HEADER]: trace.traceOrigin,
              },
              body,
            });
        } catch {
          // Cursor fanout is best-effort.
        }
      })
    );
  }

  #maybeUnrefTimer(timer: ReturnType<typeof setTimeout>): void {
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") {
      unref.call(timer);
    }
  }

  #logEvent(event: string, fields: Record<string, unknown>): void {
    logStructuredEvent("cursor_hub_do", event, {
      do_id: this.#doId,
      ...fields,
    });
  }

  #readTraceContext(request: Request): CursorTraceContext | null {
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
}
