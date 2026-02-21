import type {
  CellLastEditRecord,
  DurableObjectStateLike,
  R2BucketLike,
} from "./doCommon";
import { logStructuredEvent } from "./observability";

export interface TileSnapshotRecord {
  bits: string;
  ver: number;
  edits?: CellLastEditRecord[];
}

export interface TileOwnerPersistedState {
  snapshot?: TileSnapshotRecord;
  subscribers: string[];
}

export interface TileOwnerPersistence {
  load(tileKey: string): Promise<TileOwnerPersistedState>;
  saveSnapshot(tileKey: string, snapshot: TileSnapshotRecord): Promise<void>;
  saveSubscribers(tileKey: string, subscribers: string[]): Promise<void>;
}

const SNAPSHOT_KEY = "snapshot";
const SUBSCRIBERS_KEY = "subscribers";
const SNAPSHOT_OBJECT_VERSION = "v1";

function snapshotObjectKey(tileKey: string): string {
  const [tx = "0", ty = "0"] = tileKey.split(":");
  return `tiles/${SNAPSHOT_OBJECT_VERSION}/tx=${tx}/ty=${ty}.json`;
}

function isValidSnapshotRecord(value: unknown): value is TileSnapshotRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { bits?: unknown; ver?: unknown; edits?: unknown };
  const editsValid =
    typeof candidate.edits === "undefined" ||
    (Array.isArray(candidate.edits) && candidate.edits.every((entry) => isValidLastEditRecord(entry)));

  return (
    typeof candidate.bits === "string" &&
    Number.isInteger(candidate.ver) &&
    typeof candidate.ver === "number" &&
    candidate.ver >= 0 &&
    editsValid
  );
}

function isValidLastEditRecord(value: unknown): value is CellLastEditRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    i?: unknown;
    uid?: unknown;
    name?: unknown;
    atMs?: unknown;
  };

  return (
    Number.isInteger(candidate.i) &&
    typeof candidate.i === "number" &&
    candidate.i >= 0 &&
    typeof candidate.uid === "string" &&
    candidate.uid.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    Number.isInteger(candidate.atMs) &&
    typeof candidate.atMs === "number" &&
    candidate.atMs >= 0
  );
}

export class DurableObjectStorageTileOwnerPersistence implements TileOwnerPersistence {
  #state: DurableObjectStateLike;
  #doId: string;

  constructor(state: DurableObjectStateLike) {
    this.#state = state;
    this.#doId = state.id.toString();
  }

  async load(tileKey: string): Promise<TileOwnerPersistedState> {
    const startMs = Date.now();
    let snapshot: TileSnapshotRecord | undefined;
    let subscribers: string[] = [];

    try {
      snapshot = await this.#state.storage.get<TileSnapshotRecord>(SNAPSHOT_KEY);
      const rawSubscribers = await this.#state.storage.get<string[]>(SUBSCRIBERS_KEY);
      subscribers = Array.isArray(rawSubscribers)
        ? rawSubscribers.filter((value) => typeof value === "string" && value.length > 0)
        : [];

      logStructuredEvent("tile_owner_persistence", "snapshot_read", {
        do_id: this.#doId,
        tile: tileKey,
        source: "do_storage",
        found: Boolean(snapshot),
        bytes: snapshot ? JSON.stringify(snapshot).length : 0,
        subscriber_count: subscribers.length,
        duration_ms: Date.now() - startMs,
      });
    } catch (error) {
      logStructuredEvent("tile_owner_persistence", "snapshot_read", {
        do_id: this.#doId,
        tile: tileKey,
        source: "do_storage",
        found: false,
        error: true,
        error_message: error instanceof Error ? error.message : "unknown_error",
        duration_ms: Date.now() - startMs,
      });
      throw error;
    }

    if (snapshot) {
      return {
        snapshot,
        subscribers,
      };
    }

    return { subscribers };
  }

  async saveSnapshot(tileKey: string, snapshot: TileSnapshotRecord): Promise<void> {
    const startMs = Date.now();
    const bytes = JSON.stringify(snapshot).length;
    try {
      await this.#state.storage.put(SNAPSHOT_KEY, snapshot);
      logStructuredEvent("tile_owner_persistence", "snapshot_write", {
        do_id: this.#doId,
        tile: tileKey,
        source: "do_storage",
        bytes,
        duration_ms: Date.now() - startMs,
      });
    } catch (error) {
      logStructuredEvent("tile_owner_persistence", "snapshot_write", {
        do_id: this.#doId,
        tile: tileKey,
        source: "do_storage",
        bytes,
        error: true,
        error_message: error instanceof Error ? error.message : "unknown_error",
        duration_ms: Date.now() - startMs,
      });
      throw error;
    }
  }

  async saveSubscribers(_tileKey: string, subscribers: string[]): Promise<void> {
    await this.#state.storage.put(SUBSCRIBERS_KEY, subscribers);
  }
}

export class LazyMigratingR2TileOwnerPersistence implements TileOwnerPersistence {
  #legacy: DurableObjectStorageTileOwnerPersistence;
  #bucket: R2BucketLike;
  #dualWriteLegacy: boolean;
  #doId: string;

  constructor(
    state: DurableObjectStateLike,
    bucket: R2BucketLike,
    options: {
      dualWriteLegacy?: boolean;
    } = {}
  ) {
    this.#legacy = new DurableObjectStorageTileOwnerPersistence(state);
    this.#bucket = bucket;
    this.#dualWriteLegacy = options.dualWriteLegacy ?? true;
    this.#doId = state.id.toString();
  }

  async load(tileKey: string): Promise<TileOwnerPersistedState> {
    const legacy = await this.#legacy.load(tileKey);
    const fromR2 = await this.#loadSnapshotFromR2(tileKey);
    if (fromR2) {
      return {
        snapshot: fromR2,
        subscribers: legacy.subscribers,
      };
    }

    if (legacy.snapshot) {
      await this.#saveSnapshotToR2(tileKey, legacy.snapshot, "migration");
      return legacy;
    }

    return { subscribers: legacy.subscribers };
  }

  async saveSnapshot(tileKey: string, snapshot: TileSnapshotRecord): Promise<void> {
    await this.#saveSnapshotToR2(tileKey, snapshot, "normal");
    if (this.#dualWriteLegacy) {
      await this.#legacy.saveSnapshot(tileKey, snapshot);
    }
  }

  async saveSubscribers(tileKey: string, subscribers: string[]): Promise<void> {
    await this.#legacy.saveSubscribers(tileKey, subscribers);
  }

  async #loadSnapshotFromR2(tileKey: string): Promise<TileSnapshotRecord | null> {
    const startMs = Date.now();
    const key = snapshotObjectKey(tileKey);

    try {
      const object = await this.#bucket.get(key);
      if (!object) {
        logStructuredEvent("tile_owner_persistence", "snapshot_read", {
          do_id: this.#doId,
          tile: tileKey,
          source: "r2",
          found: false,
          key,
          duration_ms: Date.now() - startMs,
        });
        return null;
      }

      const payload = JSON.parse(await object.text()) as unknown;
      const snapshot = isValidSnapshotRecord(payload) ? payload : null;
      logStructuredEvent("tile_owner_persistence", "snapshot_read", {
        do_id: this.#doId,
        tile: tileKey,
        source: "r2",
        found: Boolean(snapshot),
        key,
        bytes: snapshot ? JSON.stringify(snapshot).length : 0,
        duration_ms: Date.now() - startMs,
      });
      return snapshot;
    } catch (error) {
      logStructuredEvent("tile_owner_persistence", "snapshot_read", {
        do_id: this.#doId,
        tile: tileKey,
        source: "r2",
        found: false,
        key,
        error: true,
        error_message: error instanceof Error ? error.message : "unknown_error",
        duration_ms: Date.now() - startMs,
      });
      return null;
    }
  }

  async #saveSnapshotToR2(
    tileKey: string,
    snapshot: TileSnapshotRecord,
    mode: "normal" | "migration"
  ): Promise<void> {
    const startMs = Date.now();
    const key = snapshotObjectKey(tileKey);
    const payload = JSON.stringify(snapshot);
    try {
      await this.#bucket.put(key, payload);
      logStructuredEvent("tile_owner_persistence", "snapshot_write", {
        do_id: this.#doId,
        tile: tileKey,
        source: "r2",
        mode,
        key,
        bytes: payload.length,
        duration_ms: Date.now() - startMs,
      });
    } catch (error) {
      logStructuredEvent("tile_owner_persistence", "snapshot_write", {
        do_id: this.#doId,
        tile: tileKey,
        source: "r2",
        mode,
        key,
        bytes: payload.length,
        error: true,
        error_message: error instanceof Error ? error.message : "unknown_error",
        duration_ms: Date.now() - startMs,
      });
      throw error;
    }
  }
}
