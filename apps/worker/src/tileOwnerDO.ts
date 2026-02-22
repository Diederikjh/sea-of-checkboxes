import { TILE_CELL_COUNT, isCellIndexValid } from "@sea/domain";
import {
  decodeRle64,
  type ServerMessage,
} from "@sea/protocol";

import {
  isValidTileKey,
  jsonResponse,
  readJson,
  type DurableObjectStateLike,
  type Env,
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
const TILE_WAL_FLUSH_MS = 50;
const TILE_WAL_MAX_BATCH_OPS = 128;

export class TileOwnerDO {
  #env: Env;
  #doId: string;
  #tileOwner: TileOwner;
  #tileKey: string | null;
  #subscriberShards: Set<string>;
  #loaded: boolean;
  #persistence: TileOwnerPersistence;
  #pendingBatchOps: Array<[number, 0 | 1]>;
  #pendingBatchFromVer: number | null;
  #pendingBatchToVer: number | null;
  #walFlushTimer: ReturnType<typeof setTimeout> | null;
  #opsSinceSnapshot: number;
  #lastSnapshotAtMs: number;
  #snapshotFlushTimer: ReturnType<typeof setTimeout> | null;
  #snapshotPersistInFlight: boolean;
  #snapshotDirty: boolean;

  constructor(
    state: DurableObjectStateLike,
    env: Env,
    options: {
      persistence?: TileOwnerPersistence;
    } = {}
  ) {
    this.#env = env;
    this.#doId = state.id.toString();
    this.#tileOwner = new TileOwner("0:0");
    this.#tileKey = null;
    this.#subscriberShards = new Set();
    this.#loaded = false;
    this.#pendingBatchOps = [];
    this.#pendingBatchFromVer = null;
    this.#pendingBatchToVer = null;
    this.#walFlushTimer = null;
    this.#opsSinceSnapshot = 0;
    this.#lastSnapshotAtMs = 0;
    this.#snapshotFlushTimer = null;
    this.#snapshotPersistInFlight = false;
    this.#snapshotDirty = false;
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
        this.#subscriberShards.add(payload.shard);
      } else {
        this.#subscriberShards.delete(payload.shard);
      }
      await this.#persistSubscribers();
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

      if (this.#subscriberShards.size >= TILE_READONLY_WATCHER_THRESHOLD) {
        this.#logEvent("setCell", {
          tile: payload.tile,
          i: payload.i,
          v: payload.v,
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

      if (result.changed) {
        this.#enqueueWalOperation(payload.i, payload.v, result.ver);
        await this.#recordSnapshotOperation();
      }

      const body: TileSetCellResponse = result.reason
        ? {
            accepted: result.accepted,
            changed: result.changed,
            ver: result.ver,
            reason: result.reason,
          }
        : {
            accepted: result.accepted,
            changed: result.changed,
            ver: result.ver,
          };

      this.#logEvent("setCell", {
        tile: payload.tile,
        i: payload.i,
        v: payload.v,
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

    this.#clearWalFlushTimer();
    this.#clearSnapshotFlushTimer();
    this.#tileKey = tileKey;
    this.#tileOwner = new TileOwner(tileKey);
    this.#subscriberShards.clear();
    this.#loaded = false;
    this.#pendingBatchOps = [];
    this.#pendingBatchFromVer = null;
    this.#pendingBatchToVer = null;
    this.#opsSinceSnapshot = 0;
    this.#lastSnapshotAtMs = 0;
    this.#snapshotPersistInFlight = false;
    this.#snapshotDirty = false;
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

  #enqueueWalOperation(index: number, value: 0 | 1, ver: number): void {
    if (this.#pendingBatchOps.length === 0) {
      this.#pendingBatchFromVer = ver;
    }

    this.#pendingBatchToVer = ver;
    this.#pendingBatchOps.push([index, value]);

    if (this.#pendingBatchOps.length >= TILE_WAL_MAX_BATCH_OPS) {
      this.#flushWalBatch();
      return;
    }

    this.#scheduleWalFlush();
  }

  #scheduleWalFlush(): void {
    if (this.#walFlushTimer) {
      return;
    }

    this.#walFlushTimer = setTimeout(() => {
      this.#walFlushTimer = null;
      this.#flushWalBatch();
    }, TILE_WAL_FLUSH_MS);
    this.#maybeUnrefTimer(this.#walFlushTimer);
  }

  #clearWalFlushTimer(): void {
    if (!this.#walFlushTimer) {
      return;
    }

    clearTimeout(this.#walFlushTimer);
    this.#walFlushTimer = null;
  }

  #flushWalBatch(): void {
    if (
      this.#pendingBatchOps.length === 0 ||
      this.#pendingBatchFromVer === null ||
      this.#pendingBatchToVer === null
    ) {
      return;
    }

    this.#clearWalFlushTimer();

    const tile = this.#activeTileKey();
    const batch: Extract<ServerMessage, { t: "cellUpBatch" }> = {
      t: "cellUpBatch",
      tile,
      fromVer: this.#pendingBatchFromVer,
      toVer: this.#pendingBatchToVer,
      ops: this.#pendingBatchOps,
    };

    this.#pendingBatchOps = [];
    this.#pendingBatchFromVer = null;
    this.#pendingBatchToVer = null;

    const subscribers = Array.from(this.#subscriberShards);
    const fanoutStartMs = Date.now();
    if (subscribers.length === 0) {
      this.#logEvent("broadcast", {
        tile,
        batch_size: batch.ops.length,
        watcher_count: 0,
        failed_count: 0,
        duration_ms: elapsedMs(fanoutStartMs),
      });
      return;
    }

    // Do not await fanout here to avoid circular waits:
    // shard -> tile owner -> shard (same shard may be in subscribers).
    void Promise.allSettled(
      subscribers.map(async (shardId) => {
        const stub = this.#env.CONNECTION_SHARD.getByName(shardId);
        await stub.fetch("https://connection-shard.internal/tile-batch", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(batch),
        });
      })
    ).then((results) => {
      const failedCount = results.filter((entry) => entry.status === "rejected").length;
      this.#logEvent("broadcast", {
        tile,
        batch_size: batch.ops.length,
        watcher_count: subscribers.length,
        failed_count: failedCount,
        duration_ms: elapsedMs(fanoutStartMs),
      });
    });
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
    this.#snapshotFlushTimer = setTimeout(() => {
      this.#snapshotFlushTimer = null;
      void this.#persistSnapshotManaged().catch(() => {
        // Persistence layer already logs failures.
      });
    }, delayMs);
    this.#maybeUnrefTimer(this.#snapshotFlushTimer);
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

  #logEvent(event: string, fields: Record<string, unknown>): void {
    logStructuredEvent("tile_owner_do", event, {
      do_id: this.#doId,
      tile: this.#tileKey ?? undefined,
      ...fields,
    });
  }
}
