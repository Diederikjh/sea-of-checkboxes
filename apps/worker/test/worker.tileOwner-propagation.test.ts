import { TILE_CELL_COUNT } from "@sea/domain";
import { decodeRle64, encodeRle64 } from "@sea/protocol";
import { describe, expect, it } from "vitest";

import { TileOwnerDO } from "../src/worker";
import {
  RecordingDurableObjectStub,
  StubNamespace,
} from "./helpers/doStubs";
import type { TileOwnerPersistence } from "../src/tileOwnerPersistence";
import { MemoryStorage, NullStorage } from "./helpers/storageMocks";
import { waitFor } from "./helpers/waitFor";

function createTileOwnerHarness() {
  const storage = new MemoryStorage();
  const shardNamespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  const env = {
    CONNECTION_SHARD: shardNamespace,
    TILE_OWNER: shardNamespace,
  };

  const state = {
    id: { toString: () => "tile:0:0" },
    storage,
  };

  return {
    createInstance: (options: { opHistoryLimit?: number } = {}) => new TileOwnerDO(state, env, options),
    shardNamespace,
  };
}

function postJson(path: string, body: unknown): Request {
  return new Request(`https://tile-owner.internal${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function getJson(path: string): Request {
  return new Request(`https://tile-owner.internal${path}`, {
    method: "GET",
  });
}

class MemoryR2Object {
  #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  async text(): Promise<string> {
    return this.#value;
  }
}

class MemoryR2Bucket {
  #objects: Map<string, string>;

  constructor() {
    this.#objects = new Map();
  }

  async get(key: string): Promise<MemoryR2Object | null> {
    const value = this.#objects.get(key);
    return typeof value === "string" ? new MemoryR2Object(value) : null;
  }

  async put(key: string, value: string): Promise<void> {
    this.#objects.set(key, value);
  }
}

class FlakyR2Bucket {
  #objects: Map<string, string>;
  #remainingPutFailures: number;
  putAttempts: number;

  constructor(failPutAttempts: number = 0) {
    this.#objects = new Map();
    this.#remainingPutFailures = Math.max(0, failPutAttempts);
    this.putAttempts = 0;
  }

  async get(key: string): Promise<MemoryR2Object | null> {
    const value = this.#objects.get(key);
    return typeof value === "string" ? new MemoryR2Object(value) : null;
  }

  async put(key: string, value: string): Promise<void> {
    this.putAttempts += 1;
    if (this.#remainingPutFailures > 0) {
      this.#remainingPutFailures -= 1;
      throw new Error("simulated_r2_put_failure");
    }
    this.#objects.set(key, value);
  }
}

class SnapshotWriteFailingStorage {
  #data: Map<string, unknown>;

  constructor() {
    this.#data = new Map();
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.#data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    if (key === "snapshot") {
      throw new Error("simulated_legacy_snapshot_put_failure");
    }
    this.#data.set(key, value);
  }
}

class SubscriberWriteFailingStorage {
  #data: Map<string, unknown>;

  constructor() {
    this.#data = new Map();
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.#data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    if (key === "subscribers") {
      throw new Error("subscriber_storage_should_not_be_used");
    }
    this.#data.set(key, value);
  }
}

describe("TileOwnerDO propagation across restart", () => {
  it("does not persist shard watchers across re-instantiation", async () => {
    const harness = createTileOwnerHarness();
    const first = harness.createInstance();

    await first.fetch(
      postJson("/watch", {
        tile: "0:0",
        shard: "shard-a",
        action: "sub",
      })
    );
    await first.fetch(
      postJson("/watch", {
        tile: "0:0",
        shard: "shard-b",
        action: "sub",
      })
    );

    const firstSetCellResponse = await first.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 1,
        v: 1,
        op: "op_1",
      })
    );
    expect(firstSetCellResponse.ok).toBe(true);
    await expect(firstSetCellResponse.json()).resolves.toMatchObject({
      accepted: true,
      changed: true,
      watcherCount: 2,
    });

    const shardA = harness.shardNamespace.getByName("shard-a");
    const shardB = harness.shardNamespace.getByName("shard-b");
    expect(shardA.requests.length).toBe(0);
    expect(shardB.requests.length).toBe(0);

    // Recreate the DO instance with the same storage to simulate lifecycle recycle.
    // Tile data persists, but live watcher membership is intentionally ephemeral.
    const second = harness.createInstance();
    const secondSetCellResponse = await second.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 2,
        v: 1,
        op: "op_2",
      })
    );
    expect(secondSetCellResponse.ok).toBe(true);
    await expect(secondSetCellResponse.json()).resolves.toMatchObject({
      accepted: true,
      changed: true,
      watcherCount: 0,
    });
    expect(shardA.requests.length).toBe(0);
    expect(shardB.requests.length).toBe(0);
  });

  it("persists tile snapshot across re-instantiation", async () => {
    const harness = createTileOwnerHarness();
    const first = harness.createInstance();

    await first.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 15,
        v: 1,
        op: "op_1",
      })
    );

    const second = harness.createInstance();
    const snapshotResponse = await second.fetch(getJson("/snapshot?tile=0:0"));
    expect(snapshotResponse.ok).toBe(true);

    const snapshot = (await snapshotResponse.json()) as {
      t: string;
      tile: string;
      ver: number;
      bits: string;
    };
    expect(snapshot.t).toBe("tileSnap");
    expect(snapshot.tile).toBe("0:0");
    expect(snapshot.ver).toBe(1);

    const bits = decodeRle64(snapshot.bits);
    expect(bits[15]).toBe(1);
  });

  it("returns ops-since deltas for contiguous versions", async () => {
    const harness = createTileOwnerHarness();
    const owner = harness.createInstance();

    await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 1,
        v: 1,
        op: "op_1",
      })
    );
    await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 2,
        v: 1,
        op: "op_2",
      })
    );
    await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 3,
        v: 1,
        op: "op_3",
      })
    );

    const response = await owner.fetch(getJson("/ops-since?tile=0:0&fromVer=0"));
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      tile: "0:0",
      fromVer: 0,
      toVer: 3,
      currentVer: 3,
      gap: false,
      ops: [[1, 1], [2, 1], [3, 1]],
    });
  });

  it("returns bounded ops-since pages and gap when history window is exceeded", async () => {
    const harness = createTileOwnerHarness();
    const owner = harness.createInstance({ opHistoryLimit: 3 });

    await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 5,
        v: 1,
        op: "op_1",
      })
    );
    await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 5,
        v: 0,
        op: "op_2",
      })
    );
    await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 5,
        v: 1,
        op: "op_3",
      })
    );
    await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 5,
        v: 0,
        op: "op_4",
      })
    );

    const page = await owner.fetch(getJson("/ops-since?tile=0:0&fromVer=1&limit=2"));
    expect(page.ok).toBe(true);
    await expect(page.json()).resolves.toMatchObject({
      tile: "0:0",
      fromVer: 1,
      toVer: 3,
      currentVer: 4,
      gap: false,
      ops: [[5, 0], [5, 1]],
    });

    const gap = await owner.fetch(getJson("/ops-since?tile=0:0&fromVer=0"));
    expect(gap.ok).toBe(true);
    await expect(gap.json()).resolves.toMatchObject({
      tile: "0:0",
      fromVer: 0,
      toVer: 4,
      currentVer: 4,
      gap: true,
      ops: [],
    });
  });

  it("returns per-cell last edit metadata and null for untouched cells", async () => {
    const harness = createTileOwnerHarness();
    const owner = harness.createInstance();

    await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 15,
        v: 1,
        op: "op_1",
        uid: "u_a",
        name: "Alice",
        atMs: 1_700_000_000_000,
      })
    );

    const editedResponse = await owner.fetch(getJson("/cell-last-edit?tile=0:0&i=15"));
    expect(editedResponse.ok).toBe(true);
    await expect(editedResponse.json()).resolves.toEqual({
      tile: "0:0",
      i: 15,
      edit: {
        uid: "u_a",
        name: "Alice",
        atMs: 1_700_000_000_000,
      },
    });

    const untouchedResponse = await owner.fetch(getJson("/cell-last-edit?tile=0:0&i=16"));
    expect(untouchedResponse.ok).toBe(true);
    await expect(untouchedResponse.json()).resolves.toEqual({
      tile: "0:0",
      i: 16,
      edit: null,
    });
  });

  it("persists cell last edit metadata across re-instantiation", async () => {
    const harness = createTileOwnerHarness();
    const first = harness.createInstance();

    await first.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 42,
        v: 1,
        op: "op_1",
        uid: "u_a",
        name: "Alice",
        atMs: 1_700_000_000_123,
      })
    );

    const second = harness.createInstance();
    const response = await second.fetch(getJson("/cell-last-edit?tile=0:0&i=42"));
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({
      tile: "0:0",
      i: 42,
      edit: {
        uid: "u_a",
        name: "Alice",
        atMs: 1_700_000_000_123,
      },
    });
  });

  it("forgets subscriber state across re-instantiation even after unsubscribe", async () => {
    const harness = createTileOwnerHarness();
    const first = harness.createInstance();

    await first.fetch(
      postJson("/watch", {
        tile: "0:0",
        shard: "shard-a",
        action: "sub",
      })
    );
    await first.fetch(
      postJson("/watch", {
        tile: "0:0",
        shard: "shard-b",
        action: "sub",
      })
    );
    await first.fetch(
      postJson("/watch", {
        tile: "0:0",
        shard: "shard-b",
        action: "unsub",
      })
    );

    const second = harness.createInstance();
    const setCellResponse = await second.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 3,
        v: 1,
        op: "op_1",
      })
    );
    expect(setCellResponse.ok).toBe(true);
    await expect(setCellResponse.json()).resolves.toMatchObject({
      accepted: true,
      changed: true,
      watcherCount: 0,
    });

    const shardA = harness.shardNamespace.getByName("shard-a");
    const shardB = harness.shardNamespace.getByName("shard-b");
    await waitFor(() => {
      expect(shardA.requests.length).toBe(0);
      expect(shardB.requests.length).toBe(0);
    });
  });

  it("ignores legacy persisted subscriber records", async () => {
    const storage = new MemoryStorage();
    const shardNamespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
    const env = {
      CONNECTION_SHARD: shardNamespace,
      TILE_OWNER: shardNamespace,
    };
    const state = {
      id: { toString: () => "tile:0:0" },
      storage,
    };

    await storage.put("subscribers", ["shard-a", "shard-b"]);

    const owner = new TileOwnerDO(state, env);
    const response = await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 4,
        v: 1,
        op: "op_ignore_legacy_subscribers",
      })
    );

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      changed: true,
      watcherCount: 0,
    });
  });

  it("does not touch Durable Object storage for watch subscriber coordination", async () => {
    const shardNamespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
    const env = {
      CONNECTION_SHARD: shardNamespace,
      TILE_OWNER: shardNamespace,
    };
    const state = {
      id: { toString: () => "tile:0:0" },
      storage: new SubscriberWriteFailingStorage(),
    };
    const owner = new TileOwnerDO(state, env);

    const watchResponse = await owner.fetch(
      postJson("/watch", {
        tile: "0:0",
        shard: "shard-a",
        action: "sub",
      })
    );

    expect(watchResponse.status).toBe(204);
    const setCellResponse = await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 4,
        v: 1,
        op: "op_watch_no_storage",
      })
    );
    expect(setCellResponse.ok).toBe(true);
    await expect(setCellResponse.json()).resolves.toMatchObject({
      accepted: true,
      changed: true,
      watcherCount: 1,
    });
  });

  it("switches tile to read-only mode when watcher threshold is exceeded", async () => {
    const harness = createTileOwnerHarness();
    const owner = harness.createInstance();

    for (let index = 0; index < 8; index += 1) {
      const response = await owner.fetch(
        await postJson("/watch", {
          tile: "0:0",
          shard: `shard-${index}`,
          action: "sub",
        })
      );
      expect(response.status).toBe(204);
    }

    const response = await owner.fetch(
      await postJson("/setCell", {
        tile: "0:0",
        i: 10,
        v: 1,
        op: "op_1",
      })
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as { accepted: boolean; changed: boolean; reason?: string };
    expect(result.accepted).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("tile_readonly_hot");
  });

  it("denies new shard watchers when oversubscribed", async () => {
    const harness = createTileOwnerHarness();
    const owner = harness.createInstance();

    for (let index = 0; index < 12; index += 1) {
      const response = await owner.fetch(
        await postJson("/watch", {
          tile: "0:0",
          shard: `shard-${index}`,
          action: "sub",
        })
      );
      expect(response.status).toBe(204);
    }

    const denyResponse = await owner.fetch(
      await postJson("/watch", {
        tile: "0:0",
        shard: "shard-over",
        action: "sub",
      })
    );

    expect(denyResponse.status).toBe(429);
    const body = (await denyResponse.json()) as { code?: string };
    expect(body.code).toBe("tile_sub_denied");

    const existingResponse = await owner.fetch(
      await postJson("/watch", {
        tile: "0:0",
        shard: "shard-0",
        action: "sub",
      })
    );
    expect(existingResponse.status).toBe(204);
  });

  it("completes setCell without shard push fanout under watcher subscriptions", async () => {
    const harness = createTileOwnerHarness();
    const owner = harness.createInstance();

    await owner.fetch(
      postJson("/watch", {
        tile: "0:0",
        shard: "shard-a",
        action: "sub",
      })
    );

    const setCellPromise = owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 22,
        v: 1,
        op: "op_1",
      })
    );

    const race = await Promise.race([
      setCellPromise.then(() => "resolved"),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    expect(race).toBe("resolved");
    const shardA = harness.shardNamespace.getByName("shard-a");
    expect(shardA.requests.length).toBe(0);
  });

  it("does not perform shard push fanout for multi-watcher tiles", async () => {
    const harness = createTileOwnerHarness();
    const owner = harness.createInstance();
    await owner.fetch(
      postJson("/watch", {
        tile: "0:0",
        shard: "shard-a",
        action: "sub",
      })
    );
    await owner.fetch(
      postJson("/watch", {
        tile: "0:0",
        shard: "shard-b",
        action: "sub",
      })
    );

    const response = await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 7,
        v: 1,
        op: "op_1",
      })
    );
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      changed: true,
      watcherCount: 2,
    });

    const shardA = harness.shardNamespace.getByName("shard-a");
    const shardB = harness.shardNamespace.getByName("shard-b");
    expect(shardA.requests.length).toBe(0);
    expect(shardB.requests.length).toBe(0);
  });

  it("dedupes duplicate op ids without shard push fanout", async () => {
    const harness = createTileOwnerHarness();
    const owner = harness.createInstance();

    await owner.fetch(
      postJson("/watch", {
        tile: "0:0",
        shard: "shard-a",
        action: "sub",
      })
    );
    await owner.fetch(
      postJson("/watch", {
        tile: "0:0",
        shard: "shard-b",
        action: "sub",
      })
    );

    const firstResponse = await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 12,
        v: 1,
        op: "op_dup",
      })
    );
    expect(firstResponse.ok).toBe(true);
    await expect(firstResponse.json()).resolves.toMatchObject({
      accepted: true,
      changed: true,
      ver: 1,
    });

    const duplicateResponse = await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 12,
        v: 0,
        op: "op_dup",
      })
    );
    expect(duplicateResponse.ok).toBe(true);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      accepted: true,
      changed: false,
      ver: 1,
      reason: "duplicate_op",
    });

    const shardA = harness.shardNamespace.getByName("shard-a");
    const shardB = harness.shardNamespace.getByName("shard-b");
    expect(shardA.requests.length).toBe(0);
    expect(shardB.requests.length).toBe(0);
  });

  it("supports injectable persistence adapters for testability", async () => {
    const snapshots = new Map<string, { bits: string; ver: number }>();
    let saveSnapshotCount = 0;
    const persistence: TileOwnerPersistence = {
      async load(tileKey) {
        const snapshot = snapshots.get(tileKey);
        if (snapshot) {
          return {
            snapshot,
          };
        }

        return {};
      },
      async saveSnapshot(tileKey, snapshot) {
        saveSnapshotCount += 1;
        snapshots.set(tileKey, snapshot);
      },
    };

    const seededBits = new Uint8Array(TILE_CELL_COUNT);
    seededBits[10] = 1;
    snapshots.set("0:0", { bits: encodeRle64(seededBits), ver: 3 });

    const shardNamespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
    const env = {
      CONNECTION_SHARD: shardNamespace,
      TILE_OWNER: shardNamespace,
    };
    const state = {
      id: { toString: () => "tile:0:0" },
      storage: new NullStorage(),
    };

    const owner = new TileOwnerDO(state, env, { persistence });
    const snapshotResponse = await owner.fetch(getJson("/snapshot?tile=0:0"));
    expect(snapshotResponse.ok).toBe(true);
    const snapshot = (await snapshotResponse.json()) as {
      t: string;
      tile: string;
      ver: number;
      bits: string;
    };
    expect(snapshot.t).toBe("tileSnap");
    expect(snapshot.tile).toBe("0:0");
    expect(snapshot.ver).toBe(3);

    const bits = decodeRle64(snapshot.bits);
    expect(bits[10]).toBe(1);

    await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 11,
        v: 1,
        op: "op_1",
      })
    );

    const persisted = snapshots.get("0:0");
    expect(saveSnapshotCount).toBe(1);
    expect(persisted).toBeDefined();
    expect(persisted?.ver).toBe(4);
    const persistedBits = decodeRle64(persisted!.bits);
    expect(persistedBits[11]).toBe(1);
  });

  it("lazy-migrates legacy DO snapshot into R2 on first load", async () => {
    const storage = new MemoryStorage();
    const r2 = new MemoryR2Bucket();
    const shardNamespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
    const env = {
      CONNECTION_SHARD: shardNamespace,
      TILE_OWNER: shardNamespace,
      TILE_SNAPSHOTS: r2,
    };
    const state = {
      id: { toString: () => "tile:0:0" },
      storage,
    };

    const seededBits = new Uint8Array(TILE_CELL_COUNT);
    seededBits[9] = 1;
    await storage.put("snapshot", { bits: encodeRle64(seededBits), ver: 7 });
    const first = new TileOwnerDO(state, env);
    const firstSnapshotResponse = await first.fetch(getJson("/snapshot?tile=0:0"));
    expect(firstSnapshotResponse.ok).toBe(true);
    const firstSnapshot = (await firstSnapshotResponse.json()) as {
      ver: number;
      bits: string;
    };
    expect(firstSnapshot.ver).toBe(7);
    expect(decodeRle64(firstSnapshot.bits)[9]).toBe(1);

    const migratedObject = await r2.get("tiles/v1/tx=0/ty=0.json");
    expect(migratedObject).not.toBeNull();

    await storage.put("snapshot", undefined);
    const second = new TileOwnerDO(state, env);
    const secondSnapshotResponse = await second.fetch(getJson("/snapshot?tile=0:0"));
    expect(secondSnapshotResponse.ok).toBe(true);
    const secondSnapshot = (await secondSnapshotResponse.json()) as {
      ver: number;
      bits: string;
    };
    expect(secondSnapshot.ver).toBe(7);
    expect(decodeRle64(secondSnapshot.bits)[9]).toBe(1);
  });

  it("retries transient R2 snapshot write failures and still accepts setCell", async () => {
    const storage = new MemoryStorage();
    const r2 = new FlakyR2Bucket(2);
    const shardNamespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
    const env = {
      CONNECTION_SHARD: shardNamespace,
      TILE_OWNER: shardNamespace,
      TILE_SNAPSHOTS: r2,
    };
    const state = {
      id: { toString: () => "tile:0:0" },
      storage,
    };

    const owner = new TileOwnerDO(state, env);
    const response = await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 5,
        v: 1,
        op: "op_retry_r2",
      })
    );

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      changed: true,
      ver: 1,
    });
    expect(r2.putAttempts).toBe(3);
    expect(await r2.get("tiles/v1/tx=0/ty=0.json")).not.toBeNull();
  });

  it("falls back to legacy snapshot storage when R2 write retries are exhausted", async () => {
    const storage = new MemoryStorage();
    const r2 = new FlakyR2Bucket(20);
    const shardNamespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
    const env = {
      CONNECTION_SHARD: shardNamespace,
      TILE_OWNER: shardNamespace,
      TILE_SNAPSHOTS: r2,
    };
    const state = {
      id: { toString: () => "tile:0:0" },
      storage,
    };

    const first = new TileOwnerDO(state, env);
    const setCellResponse = await first.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 33,
        v: 1,
        op: "op_fallback_legacy",
      })
    );
    expect(setCellResponse.ok).toBe(true);
    await expect(setCellResponse.json()).resolves.toMatchObject({
      accepted: true,
      changed: true,
      ver: 1,
    });
    expect(r2.putAttempts).toBeGreaterThanOrEqual(3);

    const second = new TileOwnerDO(state, env);
    const snapshotResponse = await second.fetch(getJson("/snapshot?tile=0:0"));
    expect(snapshotResponse.ok).toBe(true);
    const snapshot = (await snapshotResponse.json()) as {
      ver: number;
      bits: string;
    };
    expect(snapshot.ver).toBe(1);
    expect(decodeRle64(snapshot.bits)[33]).toBe(1);
  });

  it("accepts setCell even when both R2 and legacy snapshot writes fail", async () => {
    const storage = new SnapshotWriteFailingStorage();
    const r2 = new FlakyR2Bucket(20);
    const shardNamespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
    const env = {
      CONNECTION_SHARD: shardNamespace,
      TILE_OWNER: shardNamespace,
      TILE_SNAPSHOTS: r2,
    };
    const state = {
      id: { toString: () => "tile:0:0" },
      storage,
    };

    const first = new TileOwnerDO(state, env);
    const setCellResponse = await first.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 55,
        v: 1,
        op: "op_drop_allowed",
      })
    );
    expect(setCellResponse.ok).toBe(true);
    await expect(setCellResponse.json()).resolves.toMatchObject({
      accepted: true,
      changed: true,
      ver: 1,
    });
    expect(r2.putAttempts).toBeGreaterThanOrEqual(3);

    // Snapshot durability is best-effort; a restart may lose this one write.
    const second = new TileOwnerDO(state, env);
    const snapshotResponse = await second.fetch(getJson("/snapshot?tile=0:0"));
    expect(snapshotResponse.ok).toBe(true);
    const snapshot = (await snapshotResponse.json()) as {
      ver: number;
    };
    expect(snapshot.ver).toBe(0);
  });

  it("defers and retries snapshot persistence when adapter fails, without rejecting setCell", async () => {
    let saveAttempts = 0;
    let savedSnapshot: { bits: string; ver: number } | undefined;
    const persistence: TileOwnerPersistence = {
      async load() {
        if (!savedSnapshot) {
          return {};
        }
        return {
          snapshot: savedSnapshot,
        };
      },
      async saveSnapshot(_tileKey, snapshot) {
        saveAttempts += 1;
        if (saveAttempts === 1) {
          throw new Error("simulated_save_snapshot_failure");
        }
        savedSnapshot = snapshot;
      },
    };

    const shardNamespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
    const env = {
      CONNECTION_SHARD: shardNamespace,
      TILE_OWNER: shardNamespace,
    };
    const state = {
      id: { toString: () => "tile:0:0" },
      storage: new NullStorage(),
    };

    const owner = new TileOwnerDO(state, env, { persistence });
    const response = await owner.fetch(
      postJson("/setCell", {
        tile: "0:0",
        i: 41,
        v: 1,
        op: "op_retry_adapter",
      })
    );

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      changed: true,
      ver: 1,
    });

    await waitFor(() => {
      expect(saveAttempts).toBeGreaterThanOrEqual(2);
      expect(savedSnapshot?.ver).toBe(1);
    }, { attempts: 120, delayMs: 10 });
  });
});
