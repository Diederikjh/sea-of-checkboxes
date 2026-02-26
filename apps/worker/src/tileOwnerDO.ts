import { TILE_CELL_COUNT, isCellIndexValid } from "@sea/domain";
import {
  decodeRle64,
} from "@sea/protocol";

import {
  isValidTileKey,
  jsonResponse,
  readJson,
  type DurableObjectStateLike,
  type Env,
  type TileOpsSinceResponse,
  type TileSetCellRequest,
  type TileCellLastEditResponse,
  type TileSetCellResponse,
  type TileWatchRequest,
} from "./doCommon";
import { TileOwner } from "./local/tileOwner";
import {
  DurableObjectStorageTileOwnerPersistence,
  LazyMigratingR2TileOwnerPersistence,
  type TileOwnerPersistence,
} from "./tileOwnerPersistence";
import {
  elapsedMs,
  logStructuredEvent,
} from "./observability";

const TILE_READONLY_WATCHER_THRESHOLD = 8;
const TILE_DENY_WATCHER_THRESHOLD = 12;
const TILE_SNAPSHOT_MAX_AGE_MS = 5_000;
const TILE_SNAPSHOT_MAX_OPS = 500;
const TILE_SNAPSHOT_RETRY_BASE_MS = 250;
const TILE_SNAPSHOT_RETRY_MAX_MS = 5_000;
const TILE_OP_HISTORY_LIMIT = 2_048;
const TILE_OPS_SINCE_DEFAULT_LIMIT = 256;
const TILE_OPS_SINCE_MAX_LIMIT = 1_024;

export class TileOwnerDO {
  #doId: string;
  #tileOwner: TileOwner;
  #tileKey: string | null;
  #subscriberShards: Set<string>;
  #loaded: boolean;
  #persistence: TileOwnerPersistence;
  #recentTileOps: Array<{ ver: number; op: [number, 0 | 1] }>;
  #opHistoryLimit: number;
  #opsSinceSnapshot: number;
  #lastSnapshotAtMs: number;
  #snapshotFlushTimer: ReturnType<typeof setTimeout> | null;
  #snapshotPersistInFlight: boolean;
  #snapshotDirty: boolean;
  #snapshotRetryDelayMs: number;

  constructor(
    state: DurableObjectStateLike,
    env: Env,
    options: {
      persistence?: TileOwnerPersistence;
      opHistoryLimit?: number;
    } = {}
  ) {
    this.#doId = state.id.toString();
    this.#tileOwner = new TileOwner("0:0");
    this.#tileKey = null;
    this.#subscriberShards = new Set();
    this.#loaded = false;
    this.#recentTileOps = [];
    this.#opHistoryLimit = Math.max(1, options.opHistoryLimit ?? TILE_OP_HISTORY_LIMIT);
    this.#opsSinceSnapshot = 0;
    this.#lastSnapshotAtMs = 0;
    this.#snapshotFlushTimer = null;
    this.#snapshotPersistInFlight = false;
    this.#snapshotDirty = false;
    this.#snapshotRetryDelayMs = TILE_SNAPSHOT_RETRY_BASE_MS;
    this.#persistence =
      options.persistence ??
      (env.TILE_SNAPSHOTS
        ? new LazyMigratingR2TileOwnerPersistence(state, env.TILE_SNAPSHOTS)
        : new DurableObjectStorageTileOwnerPersistence(state));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/watch" && request.method === "POST") {
      const startMs = Date.now();
      const payload = await readJson<TileWatchRequest>(request);
      if (!payload || !isValidTileKey(payload.tile)) {
        return new Response("Invalid watch payload", { status: 400 });
      }

      await this.#ensureLoaded(payload.tile);
      let subscribersChanged = false;
      if (payload.action === "sub") {
        const alreadySubscribed = this.#subscriberShards.has(payload.shard);
        if (!alreadySubscribed && this.#subscriberShards.size >= TILE_DENY_WATCHER_THRESHOLD) {
          this.#logEvent("sub", {
            tile: payload.tile,
            accepted: false,
            reason: "tile_sub_denied",
            watcher_count: this.#subscriberShards.size,
            clamped: true,
            duration_ms: elapsedMs(startMs),
          });
          return jsonResponse(
            {
              code: "tile_sub_denied",
              msg: "Tile is oversubscribed; new subscriptions are temporarily denied",
            },
            { status: 429 }
          );
        }
        if (!alreadySubscribed) {
          this.#subscriberShards.add(payload.shard);
          subscribersChanged = true;
        }
      } else {
        subscribersChanged = this.#subscriberShards.delete(payload.shard);
      }
      if (subscribersChanged) {
        await this.#persistSubscribers();
      }
      this.#logEvent(payload.action, {
        tile: payload.tile,
        accepted: true,
        watcher_count: this.#subscriberShards.size,
        clamped: false,
        duration_ms: elapsedMs(startMs),
      });

      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/snapshot") {
      const tileKey = url.searchParams.get("tile");
      if (!tileKey || !isValidTileKey(tileKey)) {
        return new Response("Invalid tile", { status: 400 });
      }

      await this.#ensureLoaded(tileKey);
      return jsonResponse(this.#tileOwner.getSnapshotMessage());
    }

    if (url.pathname === "/ops-since" && request.method === "GET") {
      const tileKey = url.searchParams.get("tile");
      const rawFromVer = url.searchParams.get("fromVer");
      const rawLimit = url.searchParams.get("limit");
      if (!tileKey || !isValidTileKey(tileKey) || !rawFromVer || !/^\d+$/.test(rawFromVer)) {
        return new Response("Invalid tile or fromVer", { status: 400 });
      }

      const fromVer = Number.parseInt(rawFromVer, 10);
      const parsedLimit =
        typeof rawLimit === "string" && /^\d+$/.test(rawLimit)
          ? Number.parseInt(rawLimit, 10)
          : TILE_OPS_SINCE_DEFAULT_LIMIT;
      const limit = Math.max(1, Math.min(TILE_OPS_SINCE_MAX_LIMIT, parsedLimit));

      await this.#ensureLoaded(tileKey);
      const body = this.#tileOpsSinceResponse(tileKey, fromVer, limit);
      return jsonResponse(body);
    }

    if (url.pathname === "/setCell" && request.method === "POST") {
      const startMs = Date.now();
      const payload = await readJson<TileSetCellRequest>(request);
      if (!payload || !isValidTileKey(payload.tile)) {
        this.#logEvent("setCell", {
          accepted: false,
          changed: false,
          reason: "bad_setCell_payload",
          duration_ms: elapsedMs(startMs),
        });
        return new Response("Invalid setCell payload", { status: 400 });
      }

      await this.#ensureLoaded(payload.tile);
      const beforeValue = this.#tileOwner.getCellValue(payload.i);

      if (this.#subscriberShards.size >= TILE_READONLY_WATCHER_THRESHOLD) {
        this.#logEvent("setCell", {
          tile: payload.tile,
          i: payload.i,
          v: payload.v,
          op: payload.op,
          prev_v: beforeValue,
          accepted: false,
          changed: false,
          reason: "tile_readonly_hot",
          watcher_count: this.#subscriberShards.size,
          duration_ms: elapsedMs(startMs),
        });
        return jsonResponse({
          accepted: false,
          changed: false,
          ver: this.#tileOwner.getVersion(),
          reason: "tile_readonly_hot",
          watcherCount: this.#subscriberShards.size,
        } satisfies TileSetCellResponse);
      }

      const result = this.#tileOwner.applySetCell({
        i: payload.i,
        v: payload.v,
        op: payload.op,
        ...(typeof payload.uid === "string" ? { uid: payload.uid } : {}),
        ...(typeof payload.name === "string" ? { name: payload.name } : {}),
        ...(typeof payload.atMs === "number" ? { atMs: payload.atMs } : {}),
      });
      const afterValue = this.#tileOwner.getCellValue(payload.i);

      if (result.changed) {
        this.#recordRecentTileOp(result.ver, payload.i, payload.v);
        await this.#recordSnapshotOperation();
      }

      const body: TileSetCellResponse = result.reason
        ? {
            accepted: result.accepted,
            changed: result.changed,
            ver: result.ver,
            reason: result.reason,
            watcherCount: this.#subscriberShards.size,
          }
        : {
            accepted: result.accepted,
            changed: result.changed,
            ver: result.ver,
            watcherCount: this.#subscriberShards.size,
          };

      this.#logEvent("setCell", {
        tile: payload.tile,
        i: payload.i,
        v: payload.v,
        op: payload.op,
        prev_v: beforeValue,
        next_v: afterValue,
        accepted: body.accepted,
        changed: body.changed,
        ...(body.reason ? { reason: body.reason } : {}),
        ver: body.ver,
        watcher_count: this.#subscriberShards.size,
        duration_ms: elapsedMs(startMs),
      });
      return jsonResponse(body);
    }

    if (url.pathname === "/cell-last-edit" && request.method === "GET") {
      const tileKey = url.searchParams.get("tile");
      const rawIndex = url.searchParams.get("i");
      if (!tileKey || !isValidTileKey(tileKey) || !rawIndex || !/^\d+$/.test(rawIndex)) {
        return new Response("Invalid tile or cell index", { status: 400 });
      }

      const index = Number.parseInt(rawIndex, 10);
      if (!isCellIndexValid(index)) {
        return new Response("Invalid tile or cell index", { status: 400 });
      }

      await this.#ensureLoaded(tileKey);
      const body: TileCellLastEditResponse = {
        tile: tileKey,
        i: index,
        edit: this.#tileOwner.getCellLastEdit(index),
      };
      return jsonResponse(body);
    }

    return new Response("Not found", { status: 404 });
  }

  #setTileKey(tileKey: string): void {
    if (this.#tileKey === tileKey) {
      return;
    }

    this.#clearSnapshotFlushTimer();
    this.#tileKey = tileKey;
    this.#tileOwner = new TileOwner(tileKey);
    this.#subscriberShards.clear();
    this.#loaded = false;
    this.#recentTileOps = [];
    this.#opsSinceSnapshot = 0;
    this.#lastSnapshotAtMs = 0;
    this.#snapshotPersistInFlight = false;
    this.#snapshotDirty = false;
    this.#snapshotRetryDelayMs = TILE_SNAPSHOT_RETRY_BASE_MS;
  }

  async #ensureLoaded(tileKey: string): Promise<void> {
    this.#setTileKey(tileKey);
    if (this.#loaded) {
      return;
    }

    const persisted = await this.#persistence.load(tileKey);
    if (persisted.snapshot) {
      const bits = decodeRle64(persisted.snapshot.bits, TILE_CELL_COUNT);
      this.#tileOwner.loadSnapshot(bits, persisted.snapshot.ver, persisted.snapshot.edits ?? []);
    }

    for (const shard of persisted.subscribers) {
      this.#subscriberShards.add(shard);
    }

    this.#loaded = true;
  }

  async #persistSnapshot(): Promise<void> {
    const snapshot = this.#tileOwner.getSnapshotMessage();
    await this.#persistence.saveSnapshot(this.#activeTileKey(), {
      bits: snapshot.bits,
      ver: snapshot.ver,
      edits: this.#tileOwner.getPersistedLastEdits(),
    });
  }

  async #persistSubscribers(): Promise<void> {
    await this.#persistence.saveSubscribers(this.#activeTileKey(), Array.from(this.#subscriberShards));
  }

  async #recordSnapshotOperation(): Promise<void> {
    this.#opsSinceSnapshot += 1;
    const nowMs = Date.now();
    const dueByOps = this.#opsSinceSnapshot >= TILE_SNAPSHOT_MAX_OPS;
    const dueByTime = nowMs - this.#lastSnapshotAtMs >= TILE_SNAPSHOT_MAX_AGE_MS;

    if (dueByOps || dueByTime) {
      this.#clearSnapshotFlushTimer();
      await this.#persistSnapshotManaged();
      return;
    }

    this.#scheduleSnapshotFlush(nowMs);
  }

  #scheduleSnapshotFlush(nowMs: number): void {
    if (this.#snapshotFlushTimer) {
      return;
    }

    const elapsedSinceLastSnapshot = nowMs - this.#lastSnapshotAtMs;
    const delayMs = Math.max(1, TILE_SNAPSHOT_MAX_AGE_MS - elapsedSinceLastSnapshot);
    this.#scheduleSnapshotPersistIn(delayMs);
  }

  #scheduleSnapshotPersistIn(delayMs: number): void {
    this.#clearSnapshotFlushTimer();
    this.#snapshotFlushTimer = setTimeout(() => {
      this.#snapshotFlushTimer = null;
      void this.#persistSnapshotManaged().catch(() => {
        // Persistence retries are scheduled internally.
      });
    }, Math.max(1, delayMs));
    this.#maybeUnrefTimer(this.#snapshotFlushTimer);
  }

  #scheduleSnapshotRetry(): void {
    this.#snapshotDirty = true;
    const retryDelayMs = this.#snapshotRetryDelayMs;
    this.#snapshotRetryDelayMs = Math.min(
      TILE_SNAPSHOT_RETRY_MAX_MS,
      Math.max(TILE_SNAPSHOT_RETRY_BASE_MS, this.#snapshotRetryDelayMs * 2)
    );
    this.#scheduleSnapshotPersistIn(retryDelayMs);
  }

  #clearSnapshotFlushTimer(): void {
    if (!this.#snapshotFlushTimer) {
      return;
    }

    clearTimeout(this.#snapshotFlushTimer);
    this.#snapshotFlushTimer = null;
  }

  async #persistSnapshotManaged(): Promise<void> {
    if (this.#snapshotPersistInFlight) {
      this.#snapshotDirty = true;
      return;
    }

    this.#snapshotPersistInFlight = true;
    const opsAtPersistStart = this.#opsSinceSnapshot;
    try {
      await this.#persistSnapshot();
      this.#lastSnapshotAtMs = Date.now();
      this.#opsSinceSnapshot = Math.max(0, this.#opsSinceSnapshot - opsAtPersistStart);
      this.#snapshotRetryDelayMs = TILE_SNAPSHOT_RETRY_BASE_MS;
    } catch (error) {
      this.#logEvent("snapshot_write_deferred", {
        reason: "persist_failed",
        pending_ops: this.#opsSinceSnapshot,
        retry_in_ms: this.#snapshotRetryDelayMs,
        error_message: this.#errorMessage(error),
      });
      this.#scheduleSnapshotRetry();
      return;
    } finally {
      this.#snapshotPersistInFlight = false;
    }

    if (!this.#snapshotDirty && this.#opsSinceSnapshot === 0) {
      return;
    }

    this.#snapshotDirty = false;
    const nowMs = Date.now();
    const dueByOps = this.#opsSinceSnapshot >= TILE_SNAPSHOT_MAX_OPS;
    const dueByTime = nowMs - this.#lastSnapshotAtMs >= TILE_SNAPSHOT_MAX_AGE_MS;
    if (dueByOps || dueByTime) {
      await this.#persistSnapshotManaged();
      return;
    }

    this.#scheduleSnapshotFlush(nowMs);
  }

  #errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return "unknown_error";
  }

  #maybeUnrefTimer(timer: ReturnType<typeof setTimeout>): void {
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") {
      unref.call(timer);
    }
  }

  #activeTileKey(): string {
    if (!this.#tileKey) {
      throw new Error("TileOwnerDO tile key was not initialized");
    }
    return this.#tileKey;
  }

  #recordRecentTileOp(ver: number, index: number, value: 0 | 1): void {
    this.#recentTileOps.push({
      ver,
      op: [index, value],
    });

    if (this.#recentTileOps.length <= this.#opHistoryLimit) {
      return;
    }

    const overflow = this.#recentTileOps.length - this.#opHistoryLimit;
    if (overflow > 0) {
      this.#recentTileOps.splice(0, overflow);
    }
  }

  #tileOpsSinceResponse(
    tileKey: string,
    fromVer: number,
    limit: number
  ): TileOpsSinceResponse {
    const currentVer = this.#tileOwner.getVersion();
    if (fromVer >= currentVer) {
      return {
        tile: tileKey,
        fromVer,
        toVer: currentVer,
        currentVer,
        gap: false,
        ops: [],
      };
    }

    const firstKnown = this.#recentTileOps[0];
    if (!firstKnown || fromVer + 1 < firstKnown.ver) {
      return {
        tile: tileKey,
        fromVer,
        toVer: currentVer,
        currentVer,
        gap: true,
        ops: [],
      };
    }

    const selected = this.#recentTileOps
      .filter((entry) => entry.ver > fromVer)
      .slice(0, limit);
    const toVer = selected.length > 0 ? selected[selected.length - 1]!.ver : fromVer;
    return {
      tile: tileKey,
      fromVer,
      toVer,
      currentVer,
      gap: false,
      ops: selected.map((entry) => entry.op),
    };
  }

  #logEvent(event: string, fields: Record<string, unknown>): void {
    logStructuredEvent("tile_owner_do", event, {
      do_id: this.#doId,
      tile: this.#tileKey ?? undefined,
      ...fields,
    });
  }
}
