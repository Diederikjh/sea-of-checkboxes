import type { ServerMessage } from "@sea/protocol";

import {
  readJson,
  type TileSetCellRequest,
  type TileSetCellResponse,
} from "./doCommon";
import type { ConnectedClient } from "./connectionShardDOOperations";
import { ConnectionShardTileBatchOrderTracker } from "./connectionShardTileBatchOrder";
import { ConnectionShardTileGateway } from "./connectionShardTileGateway";
import { fanoutTileBatchToSubscribers } from "./tileBatchFanout";

const TILE_BATCH_TRACE_ID_HEADER = "x-sea-trace-id";
const TILE_BATCH_TRACE_HOP_HEADER = "x-sea-trace-hop";
const TILE_BATCH_TRACE_ORIGIN_HEADER = "x-sea-trace-origin";
const TILE_BATCH_SETCELL_SUPPRESSION_MS = 120;
const TILE_BATCH_SETCELL_RETRY_MS = 20;
const TILE_PULL_INTERVAL_MIN_MS = 200;
const TILE_PULL_INTERVAL_MAX_MS = 1000;
const TILE_PULL_INTERVAL_BACKOFF_STEP_MS = 200;
const TILE_PULL_INTERVAL_IDLE_MAX_MS = 10_000;
const TILE_PULL_INTERVAL_IDLE_BACKOFF_STEP_MS = 1_000;
const TILE_PULL_IDLE_STREAK_BEFORE_LONG_BACKOFF = 5;
const TILE_PULL_PAGE_LIMIT = 256;
const TILE_PULL_MAX_PAGES_PER_TICK = 4;

export type SetCellSuppressionReason =
  | "tile_batch_ingress_active"
  | "tile_batch_cooldown";

interface ConnectionShardTileRuntimeOptions {
  clients: Map<string, ConnectedClient>;
  tileToClients: Map<string, Set<string>>;
  gateway: ConnectionShardTileGateway;
  sendServerMessage: (client: ConnectedClient, message: ServerMessage) => void;
  logEvent: (event: string, fields: Record<string, unknown>) => void;
  nowMs: () => number;
  maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  onTileActivity: () => void;
}

export class ConnectionShardTileRuntime {
  #clients: Map<string, ConnectedClient>;
  #tileToClients: Map<string, Set<string>>;
  #gateway: ConnectionShardTileGateway;
  #sendServerMessage: (client: ConnectedClient, message: ServerMessage) => void;
  #logEvent: (event: string, fields: Record<string, unknown>) => void;
  #nowMs: () => number;
  #maybeUnrefTimer: (timer: ReturnType<typeof setTimeout>) => void;
  #onTileActivity: () => void;
  #tileBatchOrderTracker: ConnectionShardTileBatchOrderTracker;
  #tileBatchIngressDepth: number;
  #setCellSuppressedUntilMs: number;
  #tileKnownVersionByTile: Map<string, number>;
  #tilePullInFlight: Set<string>;
  #tilePullTimer: ReturnType<typeof setTimeout> | null;
  #tilePullIntervalMs: number;
  #tilePullQuietStreak: number;

  constructor(options: ConnectionShardTileRuntimeOptions) {
    this.#clients = options.clients;
    this.#tileToClients = options.tileToClients;
    this.#gateway = options.gateway;
    this.#sendServerMessage = options.sendServerMessage;
    this.#logEvent = options.logEvent;
    this.#nowMs = options.nowMs;
    this.#maybeUnrefTimer = options.maybeUnrefTimer;
    this.#onTileActivity = options.onTileActivity;
    this.#tileBatchOrderTracker = new ConnectionShardTileBatchOrderTracker();
    this.#tileBatchIngressDepth = 0;
    this.#setCellSuppressedUntilMs = 0;
    this.#tileKnownVersionByTile = new Map();
    this.#tilePullInFlight = new Set();
    this.#tilePullTimer = null;
    this.#tilePullIntervalMs = TILE_PULL_INTERVAL_MAX_MS;
    this.#tilePullQuietStreak = 0;
  }

  tileBatchIngressDepth(): number {
    return this.#tileBatchIngressDepth;
  }

  setCellSuppressedUntilMs(): number {
    return this.#setCellSuppressedUntilMs;
  }

  setCellSuppressionState(): { reason: SetCellSuppressionReason; delayMs: number } | null {
    if (this.#tileBatchIngressDepth > 0) {
      return {
        reason: "tile_batch_ingress_active",
        delayMs: TILE_BATCH_SETCELL_RETRY_MS,
      };
    }

    const remainingMs = this.#setCellSuppressedUntilMs - this.#nowMs();
    if (remainingMs > 0) {
      return {
        reason: "tile_batch_cooldown",
        delayMs: Math.max(1, Math.min(remainingMs, TILE_BATCH_SETCELL_RETRY_MS)),
      };
    }

    return null;
  }

  async handleTileBatchRequest(request: Request): Promise<Response> {
    const traceId = this.tileBatchTraceIdFromRequest(request);
    const traceHop = this.tileBatchTraceHopFromRequest(request);
    const traceOrigin = request.headers.get(TILE_BATCH_TRACE_ORIGIN_HEADER);

    if (traceHop !== null && traceHop > 1) {
      this.#logEvent("tile_batch_loop_guard_drop", {
        trace_id: traceId ?? undefined,
        trace_hop: traceHop,
        trace_origin: traceOrigin ?? undefined,
        path: "/tile-batch",
      });
      return new Response(null, { status: 204 });
    }

    if (traceId || traceHop !== null) {
      this.#logEvent("tile_batch_ingress", {
        trace_id: traceId ?? undefined,
        trace_hop: traceHop ?? undefined,
        trace_origin: traceOrigin ?? undefined,
        path: "/tile-batch",
      });
    }

    const batch = await readJson<Extract<ServerMessage, { t: "cellUpBatch" }>>(request);
    if (!batch || batch.t !== "cellUpBatch") {
      return new Response("Invalid tile batch payload", { status: 400 });
    }

    const localSubscriberCount = this.localTileSubscriberCount(batch.tile);
    if (localSubscriberCount === 0) {
      this.#logEvent("tile_batch_no_local_subscribers", {
        tile: batch.tile,
        trace_id: traceId ?? undefined,
        trace_hop: traceHop ?? undefined,
        trace_origin: traceOrigin ?? undefined,
        path: "/tile-batch",
      });
      return new Response(null, { status: 410 });
    }

    this.#tileBatchIngressDepth += 1;
    try {
      this.receiveTileBatch(batch);
    } finally {
      this.#tileBatchIngressDepth = Math.max(0, this.#tileBatchIngressDepth - 1);
      this.#setCellSuppressedUntilMs = Math.max(
        this.#setCellSuppressedUntilMs,
        this.#nowMs() + TILE_BATCH_SETCELL_SUPPRESSION_MS
      );
    }
    return new Response(null, { status: 204 });
  }

  receiveTileBatch(message: Extract<ServerMessage, { t: "cellUpBatch" }>): void {
    this.recordTileVersion(message.tile, message.toVer);
    this.recordTileBatchOrdering(message);
    fanoutTileBatchToSubscribers({
      message,
      tileToClients: this.#tileToClients,
      clients: this.#clients,
      sendServerMessage: (client, batch) => {
        this.#sendServerMessage(client, batch);
      },
    });
    this.#onTileActivity();
  }

  async watchTile(
    tileKey: string,
    action: "sub" | "unsub"
  ): Promise<{ ok: boolean; code?: string; msg?: string }> {
    const result = await this.#gateway.watchTile(tileKey, action);
    if (!result) {
      return { ok: true };
    }
    return result;
  }

  async fetchTileSnapshot(
    tileKey: string
  ): Promise<Extract<ServerMessage, { t: "tileSnap" }> | null> {
    return this.#gateway.fetchSnapshot(tileKey);
  }

  async fetchTileOpsSince(
    tileKey: string,
    fromVer: number,
    limit: number
  ): Promise<{
    tile: string;
    fromVer: number;
    toVer: number;
    currentVer: number;
    gap: boolean;
    ops: Array<[number, 0 | 1]>;
  } | null> {
    return this.#gateway.fetchTileOpsSince(tileKey, fromVer, limit);
  }

  async setTileCell(payload: TileSetCellRequest): Promise<TileSetCellResponse | null> {
    return this.#gateway.setTileCell(payload);
  }

  async sendSnapshotToClient(client: ConnectedClient, tileKey: string): Promise<void> {
    const snapshot = await this.fetchTileSnapshot(tileKey);
    if (!snapshot) {
      this.#logEvent("snapshot_send_failed", {
        uid: client.uid,
        tile: tileKey,
      });
      return;
    }
    this.#logEvent("snapshot_send", {
      uid: client.uid,
      tile: tileKey,
      ver: snapshot.ver,
    });
    this.recordTileVersion(tileKey, snapshot.ver);
    this.#sendServerMessage(client, snapshot);
  }

  sendBadTile(client: ConnectedClient, tileKey: string, fields: Record<string, unknown> = {}): void {
    this.#sendServerMessage(client, {
      t: "err",
      code: "bad_tile",
      msg: `Invalid tile key ${tileKey}`,
      ...(fields as Record<string, unknown>),
    } as ServerMessage);
  }

  recordTileVersion(tileKey: string, ver: number): void {
    const previous = this.#tileKnownVersionByTile.get(tileKey);
    this.#tileKnownVersionByTile.set(tileKey, previous === undefined ? ver : Math.max(previous, ver));
  }

  refreshTilePullSchedule(): void {
    if (this.#tileToClients.size === 0) {
      this.#clearTilePullTimer();
      this.#tilePullInFlight.clear();
      this.#tileKnownVersionByTile.clear();
      this.#tilePullIntervalMs = TILE_PULL_INTERVAL_MAX_MS;
      this.#tilePullQuietStreak = 0;
      return;
    }

    this.#tilePullIntervalMs = TILE_PULL_INTERVAL_MAX_MS;
    this.#tilePullQuietStreak = 0;
    this.#scheduleTilePullTick(0);
  }

  localTileSubscriberCount(tileKey: string): number {
    return this.#tileToClients.get(tileKey)?.size ?? 0;
  }

  recordTileBatchOrdering(message: Extract<ServerMessage, { t: "cellUpBatch" }>): void {
    const anomaly = this.#tileBatchOrderTracker.record(message);
    if (!anomaly) {
      return;
    }
    this.#logEvent("tile_batch_order_anomaly", {
      ...anomaly,
    });
  }

  tileBatchTraceIdFromRequest(request: Request): string | null {
    const traceId = request.headers.get(TILE_BATCH_TRACE_ID_HEADER)?.trim() ?? "";
    return traceId.length > 0 ? traceId : null;
  }

  tileBatchTraceHopFromRequest(request: Request): number | null {
    const rawHop = request.headers.get(TILE_BATCH_TRACE_HOP_HEADER)?.trim() ?? "";
    if (rawHop.length === 0) {
      return null;
    }
    const hop = Number.parseInt(rawHop, 10);
    if (!Number.isFinite(hop) || hop < 0) {
      return null;
    }
    return hop;
  }

  #clearTilePullTimer(): void {
    if (!this.#tilePullTimer) {
      return;
    }
    clearTimeout(this.#tilePullTimer);
    this.#tilePullTimer = null;
  }

  #scheduleTilePullTick(delayMs: number = this.#tilePullIntervalMs): void {
    if (this.#tilePullTimer || this.#tileToClients.size === 0) {
      return;
    }

    this.#tilePullTimer = setTimeout(() => {
      this.#tilePullTimer = null;
      void this.#runTilePullTick();
    }, Math.max(0, delayMs));
    this.#maybeUnrefTimer(this.#tilePullTimer);
  }

  async #runTilePullTick(): Promise<void> {
    const activeTiles = Array.from(this.#tileToClients.keys());
    if (activeTiles.length === 0) {
      return;
    }

    const deltaObserved = (
      await Promise.all(activeTiles.map((tileKey) => this.#pollTileIfNeeded(tileKey)))
    ).some(Boolean);
    this.#updateTilePullInterval(deltaObserved);
    this.#pruneStaleTilePullState();
    this.#scheduleTilePullTick(this.#tilePullIntervalMs);
  }

  #updateTilePullInterval(deltaObserved: boolean): void {
    if (deltaObserved) {
      this.#tilePullIntervalMs = TILE_PULL_INTERVAL_MIN_MS;
      this.#tilePullQuietStreak = 0;
      return;
    }

    if (this.#tilePullIntervalMs < TILE_PULL_INTERVAL_MAX_MS) {
      this.#tilePullIntervalMs = Math.min(
        TILE_PULL_INTERVAL_MAX_MS,
        this.#tilePullIntervalMs + TILE_PULL_INTERVAL_BACKOFF_STEP_MS
      );
      this.#tilePullQuietStreak = 0;
      return;
    }

    this.#tilePullQuietStreak += 1;
    if (this.#tilePullQuietStreak < TILE_PULL_IDLE_STREAK_BEFORE_LONG_BACKOFF) {
      return;
    }

    this.#tilePullIntervalMs = Math.min(
      TILE_PULL_INTERVAL_IDLE_MAX_MS,
      this.#tilePullIntervalMs + TILE_PULL_INTERVAL_IDLE_BACKOFF_STEP_MS
    );
  }

  #pruneStaleTilePullState(): void {
    for (const tileKey of Array.from(this.#tileKnownVersionByTile.keys())) {
      if (this.#tileToClients.has(tileKey)) {
        continue;
      }
      this.#tileKnownVersionByTile.delete(tileKey);
      this.#tilePullInFlight.delete(tileKey);
    }
  }

  async #pollTileIfNeeded(tileKey: string): Promise<boolean> {
    if (!this.#tileToClients.has(tileKey) || this.#tilePullInFlight.has(tileKey)) {
      return false;
    }

    this.#tilePullInFlight.add(tileKey);
    try {
      return await this.#pollTileDeltas(tileKey);
    } finally {
      this.#tilePullInFlight.delete(tileKey);
    }
  }

  async #pollTileDeltas(tileKey: string): Promise<boolean> {
    let fromVer = this.#tileKnownVersionByTile.get(tileKey) ?? 0;
    let sawDelta = false;

    for (let page = 0; page < TILE_PULL_MAX_PAGES_PER_TICK; page += 1) {
      const response = await this.fetchTileOpsSince(tileKey, fromVer, TILE_PULL_PAGE_LIMIT);
      if (!response || response.tile !== tileKey) {
        return sawDelta;
      }

      if (response.gap) {
        const resynced = await this.#resyncTileViaSnapshot(tileKey);
        return sawDelta || resynced;
      }

      if (response.ops.length === 0) {
        this.recordTileVersion(tileKey, response.toVer);
        return sawDelta;
      }

      const expectedToVer = fromVer + response.ops.length;
      if (response.toVer !== expectedToVer) {
        const resynced = await this.#resyncTileViaSnapshot(tileKey);
        return sawDelta || resynced;
      }

      this.receiveTileBatch({
        t: "cellUpBatch",
        tile: tileKey,
        fromVer: fromVer + 1,
        toVer: response.toVer,
        ops: response.ops,
      });
      sawDelta = true;
      fromVer = response.toVer;

      if (response.toVer >= response.currentVer) {
        return sawDelta;
      }
    }

    return sawDelta;
  }

  async #resyncTileViaSnapshot(tileKey: string): Promise<boolean> {
    const snapshot = await this.fetchTileSnapshot(tileKey);
    if (!snapshot) {
      return false;
    }

    this.recordTileVersion(tileKey, snapshot.ver);
    this.#fanoutSnapshotToSubscribers(snapshot);
    this.#logEvent("tile_pull_gap_resync", {
      tile: tileKey,
      ver: snapshot.ver,
    });
    return true;
  }

  #fanoutSnapshotToSubscribers(snapshot: Extract<ServerMessage, { t: "tileSnap" }>): void {
    const subscribers = this.#tileToClients.get(snapshot.tile);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    for (const uid of subscribers) {
      const client = this.#clients.get(uid);
      if (!client) {
        continue;
      }
      this.#sendServerMessage(client, snapshot);
    }
  }
}
