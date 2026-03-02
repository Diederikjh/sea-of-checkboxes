import {
  jsonResponse,
  readJson,
  type DurableObjectStateLike,
  type Env,
} from "./doCommon";
import {
  isValidCursorPresence,
  type CursorPresence,
  type CursorRelayBatch,
} from "./cursorRelay";
import {
  elapsedMs,
  logStructuredEvent,
} from "./observability";

const CURSOR_TTL_MS = 5_000;
const CURSOR_HUB_INTERNAL_SHARD = "cursor-hub";
const CURSOR_HUB_SHARD_HEADER = "x-sea-cursor-hub";
const CURSOR_HUB_FANOUT_FLUSH_MS = 25;

interface CursorHubWatchRequest {
  shard: string;
  action: "sub" | "unsub";
}

interface CursorHubPublishRequest {
  from: string;
  updates: CursorPresence[];
}

interface StoredCursor {
  shard: string;
  presence: CursorPresence;
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

export class CursorHubDO {
  #env: Env;
  #doId: string;
  #subscribers: Set<string>;
  #cursorByUid: Map<string, StoredCursor>;
  #pendingFanoutByOrigin: Map<string, Map<string, CursorPresence>>;
  #fanoutFlushTimer: ReturnType<typeof setTimeout> | null;
  #fanoutInFlight: boolean;

  constructor(state: DurableObjectStateLike, env: Env) {
    this.#env = env;
    this.#doId = state.id.toString();
    this.#subscribers = new Set();
    this.#cursorByUid = new Map();
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
      return jsonResponse(this.#snapshotForShard(payload.shard));
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
      this.#enqueueFanout(payload.from, acceptedUpdates);
    }

    this.#logEvent("publish", {
      from: payload.from,
      incoming_count: payload.updates.length,
      accepted_count: acceptedUpdates.length,
      subscriber_count: this.#subscribers.size,
      cursor_count: this.#cursorByUid.size,
      duration_ms: elapsedMs(startMs),
    });
    return new Response(null, { status: 204 });
  }

  #snapshotForShard(shard: string): CursorRelayBatch {
    const updates = Array.from(this.#cursorByUid.values())
      .filter((entry) => entry.shard !== shard)
      .map((entry) => entry.presence);
    return {
      from: CURSOR_HUB_INTERNAL_SHARD,
      updates,
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

  #enqueueFanout(originShard: string, updates: CursorPresence[]): void {
    if (updates.length === 0) {
      return;
    }

    let pendingByUid = this.#pendingFanoutByOrigin.get(originShard);
    if (!pendingByUid) {
      pendingByUid = new Map();
      this.#pendingFanoutByOrigin.set(originShard, pendingByUid);
    }

    for (const update of updates) {
      const existing = pendingByUid.get(update.uid);
      if (existing && existing.seq >= update.seq) {
        continue;
      }
      pendingByUid.set(update.uid, update);
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
    const pending = Array.from(this.#pendingFanoutByOrigin.entries()).map(([originShard, updatesByUid]) => ({
      originShard,
      updates: Array.from(updatesByUid.values()),
    }));
    this.#pendingFanoutByOrigin.clear();

    try {
      await Promise.all(
        pending.map(async ({ originShard, updates }) => {
          await this.#fanoutCursorUpdates(originShard, updates);
        })
      );
    } finally {
      this.#fanoutInFlight = false;
      if (this.#pendingFanoutByOrigin.size > 0) {
        this.#scheduleFanoutFlush(0);
      }
    }
  }

  async #fanoutCursorUpdates(originShard: string, updates: CursorPresence[]): Promise<void> {
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
}
