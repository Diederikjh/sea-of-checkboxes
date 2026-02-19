import type {
  DurableObjectStateLike,
  R2BucketLike,
} from "./doCommon";

export interface TileSnapshotRecord {
  bits: string;
  ver: number;
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

  const candidate = value as { bits?: unknown; ver?: unknown };
  return (
    typeof candidate.bits === "string" &&
    Number.isInteger(candidate.ver) &&
    typeof candidate.ver === "number" &&
    candidate.ver >= 0
  );
}

export class DurableObjectStorageTileOwnerPersistence implements TileOwnerPersistence {
  #state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike) {
    this.#state = state;
  }

  async load(_tileKey: string): Promise<TileOwnerPersistedState> {
    const snapshot = await this.#state.storage.get<TileSnapshotRecord>(SNAPSHOT_KEY);
    const rawSubscribers = await this.#state.storage.get<string[]>(SUBSCRIBERS_KEY);
    const subscribers = Array.isArray(rawSubscribers)
      ? rawSubscribers.filter((value) => typeof value === "string" && value.length > 0)
      : [];

    if (snapshot) {
      return {
        snapshot,
        subscribers,
      };
    }

    return { subscribers };
  }

  async saveSnapshot(_tileKey: string, snapshot: TileSnapshotRecord): Promise<void> {
    await this.#state.storage.put(SNAPSHOT_KEY, snapshot);
  }

  async saveSubscribers(_tileKey: string, subscribers: string[]): Promise<void> {
    await this.#state.storage.put(SUBSCRIBERS_KEY, subscribers);
  }
}

export class LazyMigratingR2TileOwnerPersistence implements TileOwnerPersistence {
  #legacy: DurableObjectStorageTileOwnerPersistence;
  #bucket: R2BucketLike;
  #dualWriteLegacy: boolean;

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
      await this.#saveSnapshotToR2(tileKey, legacy.snapshot);
      return legacy;
    }

    return { subscribers: legacy.subscribers };
  }

  async saveSnapshot(tileKey: string, snapshot: TileSnapshotRecord): Promise<void> {
    await this.#saveSnapshotToR2(tileKey, snapshot);
    if (this.#dualWriteLegacy) {
      await this.#legacy.saveSnapshot(tileKey, snapshot);
    }
  }

  async saveSubscribers(tileKey: string, subscribers: string[]): Promise<void> {
    await this.#legacy.saveSubscribers(tileKey, subscribers);
  }

  async #loadSnapshotFromR2(tileKey: string): Promise<TileSnapshotRecord | null> {
    const object = await this.#bucket.get(snapshotObjectKey(tileKey));
    if (!object) {
      return null;
    }

    try {
      const payload = JSON.parse(await object.text()) as unknown;
      return isValidSnapshotRecord(payload) ? payload : null;
    } catch {
      return null;
    }
  }

  async #saveSnapshotToR2(tileKey: string, snapshot: TileSnapshotRecord): Promise<void> {
    await this.#bucket.put(snapshotObjectKey(tileKey), JSON.stringify(snapshot));
  }
}
