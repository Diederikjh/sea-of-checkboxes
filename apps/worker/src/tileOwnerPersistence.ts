import type {
  CellLastEditRecord,
  DurableObjectStateLike,
  R2BucketLike,
} from "./doCommon";
import {
  elapsedMs,
  logStructuredEvent,
} from "./observability";

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
const SNAPSHOT_READ_SUCCESS_SAMPLE_RATE = 0.02;
const SNAPSHOT_R2_WRITE_MAX_ATTEMPTS = 3;
const SNAPSHOT_R2_WRITE_RETRY_BASE_MS = 100;
const SNAPSHOT_R2_WRITE_RETRY_MAX_MS = 1_000;

function snapshotObjectKey(tileKey: string): string {
  const [tx = "0", ty = "0"] = tileKey.split(":");
  return `tiles/${SNAPSHOT_OBJECT_VERSION}/tx=${tx}/ty=${ty}.json`;
}

function shouldSampleSnapshotRead(): boolean {
  return Math.random() < SNAPSHOT_READ_SUCCESS_SAMPLE_RATE;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(1, delayMs));
  });
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
  #logMode: string | undefined;

  constructor(state: DurableObjectStateLike, options: { logMode?: string } = {}) {
    this.#state = state;
    this.#doId = state.id.toString();
    this.#logMode = options.logMode;
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

      if (shouldSampleSnapshotRead()) {
        logStructuredEvent("tile_owner_persistence", "snapshot_read", {
          do_id: this.#doId,
          tile: tileKey,
          source: "do_storage",
          found: Boolean(snapshot),
          subscriber_count: subscribers.length,
          duration_ms: elapsedMs(startMs),
        }, {
          mode: this.#logMode,
        });
      }
    } catch (error) {
      logStructuredEvent("tile_owner_persistence", "snapshot_read", {
        do_id: this.#doId,
        tile: tileKey,
        source: "do_storage",
        found: false,
        error: true,
        error_message: error instanceof Error ? error.message : "unknown_error",
        duration_ms: elapsedMs(startMs),
      }, {
        mode: this.#logMode,
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
    try {
      await this.#state.storage.put(SNAPSHOT_KEY, snapshot);
      logStructuredEvent("tile_owner_persistence", "snapshot_write", {
        do_id: this.#doId,
        tile: tileKey,
        source: "do_storage",
        duration_ms: elapsedMs(startMs),
      }, {
        mode: this.#logMode,
      });
    } catch (error) {
      logStructuredEvent("tile_owner_persistence", "snapshot_write", {
        do_id: this.#doId,
        tile: tileKey,
        source: "do_storage",
        error: true,
        error_message: error instanceof Error ? error.message : "unknown_error",
        duration_ms: elapsedMs(startMs),
      }, {
        mode: this.#logMode,
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
  #logMode: string | undefined;

  constructor(
    state: DurableObjectStateLike,
    bucket: R2BucketLike,
    options: {
      dualWriteLegacy?: boolean;
      logMode?: string;
    } = {}
  ) {
    this.#legacy = new DurableObjectStorageTileOwnerPersistence(state, {
      ...(options.logMode ? { logMode: options.logMode } : {}),
    });
    this.#bucket = bucket;
    this.#dualWriteLegacy = options.dualWriteLegacy ?? true;
    this.#doId = state.id.toString();
    this.#logMode = options.logMode;
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
      try {
        await this.#saveSnapshotToR2(tileKey, legacy.snapshot, "migration");
      } catch {
        // Migration write is best-effort; keep serving legacy snapshot.
      }
      return legacy;
    }

    return { subscribers: legacy.subscribers };
  }

  async saveSnapshot(tileKey: string, snapshot: TileSnapshotRecord): Promise<void> {
    let r2Error: unknown = null;
    let legacyError: unknown = null;
    try {
      await this.#saveSnapshotToR2(tileKey, snapshot, "normal");
    } catch (error) {
      r2Error = error;
    }

    if (this.#dualWriteLegacy || r2Error) {
      try {
        await this.#legacy.saveSnapshot(tileKey, snapshot);
      } catch (error) {
        legacyError = error;
      }
    }

    if (!r2Error && !legacyError) {
      return;
    }

    logStructuredEvent("tile_owner_persistence", "snapshot_write", {
      do_id: this.#doId,
      tile: tileKey,
      source: "composite",
      error: true,
      r2_error: Boolean(r2Error),
      legacy_error: Boolean(legacyError),
      r2_error_message: r2Error instanceof Error ? r2Error.message : undefined,
      legacy_error_message: legacyError instanceof Error ? legacyError.message : undefined,
      mode: "normal",
    }, {
      mode: this.#logMode,
    });
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
        if (shouldSampleSnapshotRead()) {
          logStructuredEvent("tile_owner_persistence", "snapshot_read", {
            do_id: this.#doId,
            tile: tileKey,
            source: "r2",
            found: false,
            key,
            duration_ms: elapsedMs(startMs),
          }, {
            mode: this.#logMode,
          });
        }
        return null;
      }

      const payloadText = await object.text();
      const payload = JSON.parse(payloadText) as unknown;
      const snapshot = isValidSnapshotRecord(payload) ? payload : null;
      if (shouldSampleSnapshotRead()) {
        logStructuredEvent("tile_owner_persistence", "snapshot_read", {
          do_id: this.#doId,
          tile: tileKey,
          source: "r2",
          found: Boolean(snapshot),
          key,
          bytes: payloadText.length,
          duration_ms: elapsedMs(startMs),
        }, {
          mode: this.#logMode,
        });
      }
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
        duration_ms: elapsedMs(startMs),
      }, {
        mode: this.#logMode,
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
    let retryDelayMs = SNAPSHOT_R2_WRITE_RETRY_BASE_MS;

    for (let attempt = 1; attempt <= SNAPSHOT_R2_WRITE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.#bucket.put(key, payload);
        logStructuredEvent("tile_owner_persistence", "snapshot_write", {
          do_id: this.#doId,
          tile: tileKey,
          source: "r2",
          mode,
          key,
          bytes: payload.length,
          attempt,
          duration_ms: elapsedMs(startMs),
        }, {
          mode: this.#logMode,
        });
        return;
      } catch (error) {
        const finalAttempt = attempt >= SNAPSHOT_R2_WRITE_MAX_ATTEMPTS;
        logStructuredEvent("tile_owner_persistence", "snapshot_write", {
          do_id: this.#doId,
          tile: tileKey,
          source: "r2",
          mode,
          key,
          bytes: payload.length,
          error: true,
          attempt,
          final_attempt: finalAttempt,
          error_message: error instanceof Error ? error.message : "unknown_error",
          duration_ms: elapsedMs(startMs),
        }, {
          mode: this.#logMode,
        });

        if (finalAttempt) {
          throw error;
        }

        await sleep(retryDelayMs);
        retryDelayMs = Math.min(SNAPSHOT_R2_WRITE_RETRY_MAX_MS, retryDelayMs * 2);
      }
    }
  }
}
