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

describe("TileOwnerDO propagation across restart", () => {
  it("keeps shard watchers across re-instantiation without shard push fanout", async () => {
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
      watcherCount: 2,
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

  it("persists unsubscribe state across re-instantiation", async () => {
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
      watcherCount: 1,
    });

    const shardA = harness.shardNamespace.getByName("shard-a");
    const shardB = harness.shardNamespace.getByName("shard-b");
    await waitFor(() => {
      expect(shardA.requests.length).toBe(0);
      expect(shardB.requests.length).toBe(0);
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
    const subscribersByTile = new Map<string, string[]>();
    const persistence: TileOwnerPersistence = {
      async load(tileKey) {
        const snapshot = snapshots.get(tileKey);
        if (snapshot) {
          return {
            snapshot,
            subscribers: [...(subscribersByTile.get(tileKey) ?? [])],
          };
        }

        return {
          subscribers: [...(subscribersByTile.get(tileKey) ?? [])],
        };
      },
      async saveSnapshot(tileKey, snapshot) {
        snapshots.set(tileKey, snapshot);
      },
      async saveSubscribers(tileKey, subscribers) {
        subscribersByTile.set(tileKey, [...subscribers]);
      },
    };

    const seededBits = new Uint8Array(TILE_CELL_COUNT);
    seededBits[10] = 1;
    snapshots.set("0:0", { bits: encodeRle64(seededBits), ver: 3 });
    subscribersByTile.set("0:0", ["shard-a"]);

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
    await storage.put("subscribers", ["shard-a"]);

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
});
