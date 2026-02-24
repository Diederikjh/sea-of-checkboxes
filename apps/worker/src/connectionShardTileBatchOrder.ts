import type { ServerMessage } from "@sea/protocol";

const DEFAULT_TILE_BATCH_ORDER_TRACK_LIMIT = 8_192;

type CellUpBatchMessage = Extract<ServerMessage, { t: "cellUpBatch" }>;

type TileBatchOrderState = {
  fromVer: number;
  toVer: number;
  opsPreview: Array<[number, 0 | 1]>;
};

export type TileBatchOrderAnomalyKind = "duplicate_or_replay" | "version_regression" | "gap_or_jump";

export type TileBatchOrderAnomaly = {
  tile: string;
  kind: TileBatchOrderAnomalyKind;
  prev_from_ver: number;
  prev_to_ver: number;
  incoming_from_ver: number;
  incoming_to_ver: number;
  prev_ops_preview: Array<[number, 0 | 1]>;
  incoming_ops_preview: Array<[number, 0 | 1]>;
};

export class ConnectionShardTileBatchOrderTracker {
  #byTile: Map<string, TileBatchOrderState>;
  #limit: number;

  constructor(options: { limit?: number } = {}) {
    this.#byTile = new Map();
    this.#limit = options.limit ?? DEFAULT_TILE_BATCH_ORDER_TRACK_LIMIT;
  }

  record(message: CellUpBatchMessage): TileBatchOrderAnomaly | null {
    const previous = this.#byTile.get(message.tile);
    const incomingOpsPreview = message.ops.slice(0, 4);
    let anomaly: TileBatchOrderAnomaly | null = null;

    if (previous) {
      if (message.toVer <= previous.toVer) {
        anomaly = {
          tile: message.tile,
          kind: message.toVer === previous.toVer ? "duplicate_or_replay" : "version_regression",
          prev_from_ver: previous.fromVer,
          prev_to_ver: previous.toVer,
          incoming_from_ver: message.fromVer,
          incoming_to_ver: message.toVer,
          prev_ops_preview: previous.opsPreview,
          incoming_ops_preview: incomingOpsPreview,
        };
      } else if (message.fromVer !== previous.toVer + 1) {
        anomaly = {
          tile: message.tile,
          kind: "gap_or_jump",
          prev_from_ver: previous.fromVer,
          prev_to_ver: previous.toVer,
          incoming_from_ver: message.fromVer,
          incoming_to_ver: message.toVer,
          prev_ops_preview: previous.opsPreview,
          incoming_ops_preview: incomingOpsPreview,
        };
      }
    }

    this.#byTile.set(message.tile, {
      fromVer: message.fromVer,
      toVer: message.toVer,
      opsPreview: incomingOpsPreview,
    });
    this.#evictOldestIfNeeded();

    return anomaly;
  }

  #evictOldestIfNeeded(): void {
    if (this.#byTile.size <= this.#limit) {
      return;
    }
    const oldestTile = this.#byTile.keys().next().value as string | undefined;
    if (!oldestTile) {
      return;
    }
    this.#byTile.delete(oldestTile);
  }
}
