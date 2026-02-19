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
    createInstance: () => new TileOwnerDO(state, env),
    shardNamespace,
  };
}

async function postJson(path: string, body: unknown): Promise<Request> {
  return new Request(`https://tile-owner.internal${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function getJson(path: string): Promise<Request> {
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
  it("keeps shard watchers and continues fanout after re-instantiation", async () => {
    const harness = createTileOwnerHarness();
    const first = harness.createInstance();

    await first.fetch(
      await postJson("/watch", {
        tile: "0:0",
        shard: "shard-a",
        action: "sub",
      })
    );
    await first.fetch(
      await postJson("/watch", {
        tile: "0:0",
        shard: "shard-b",
        action: "sub",
      })
    );

    await first.fetch(
      await postJson("/setCell", {
        tile: "0:0",
        i: 1,
        v: 1,
        op: "op_1",
      })
    );

    const shardA = harness.shardNamespace.getByName("shard-a");
    const shardB = harness.shardNamespace.getByName("shard-b");
    await waitFor(() => {
      expect(shardA.requests.length).toBe(1);
      expect(shardB.requests.length).toBe(1);
    });

    // Recreate the DO instance with the same storage to simulate lifecycle recycle.
    const second = harness.createInstance();
    await second.fetch(
      await postJson("/setCell", {
        tile: "0:0",
        i: 2,
        v: 1,
        op: "op_2",
      })
    );

    await waitFor(() => {
      expect(shardA.requests.length).toBe(2);
      expect(shardB.requests.length).toBe(2);
    });
  });

  it("persists tile snapshot across re-instantiation", async () => {
    const harness = createTileOwnerHarness();
    const first = harness.createInstance();

    await first.fetch(
      await postJson("/setCell", {
        tile: "0:0",
        i: 15,
        v: 1,
        op: "op_1",
      })
    );

    const second = harness.createInstance();
    const snapshotResponse = await second.fetch(await getJson("/snapshot?tile=0:0"));
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

  it("persists unsubscribe state across re-instantiation", async () => {
    const harness = createTileOwnerHarness();
    const first = harness.createInstance();

    await first.fetch(
      await postJson("/watch", {
        tile: "0:0",
        shard: "shard-a",
        action: "sub",
      })
    );
    await first.fetch(
      await postJson("/watch", {
        tile: "0:0",
        shard: "shard-b",
        action: "sub",
      })
    );
    await first.fetch(
      await postJson("/watch", {
        tile: "0:0",
        shard: "shard-b",
        action: "unsub",
      })
    );

    const second = harness.createInstance();
    await second.fetch(
      await postJson("/setCell", {
        tile: "0:0",
        i: 3,
        v: 1,
        op: "op_1",
      })
    );

    const shardA = harness.shardNamespace.getByName("shard-a");
    const shardB = harness.shardNamespace.getByName("shard-b");
    await waitFor(() => {
      expect(shardA.requests.length).toBe(1);
      expect(shardB.requests.length).toBe(0);
    });
  });

  it("does not block setCell response on slow shard fanout", async () => {
    const harness = createTileOwnerHarness();
    const owner = harness.createInstance();

    await owner.fetch(
      await postJson("/watch", {
        tile: "0:0",
        shard: "shard-a",
        action: "sub",
      })
    );
    harness.shardNamespace.getByName("shard-a").setNeverResolvePath("/tile-batch", true);

    const setCellPromise = owner.fetch(
      await postJson("/setCell", {
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
    const snapshotResponse = await owner.fetch(await getJson("/snapshot?tile=0:0"));
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
      await postJson("/setCell", {
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
    const firstSnapshotResponse = await first.fetch(await getJson("/snapshot?tile=0:0"));
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
    const secondSnapshotResponse = await second.fetch(await getJson("/snapshot?tile=0:0"));
    expect(secondSnapshotResponse.ok).toBe(true);
    const secondSnapshot = (await secondSnapshotResponse.json()) as {
      ver: number;
      bits: string;
    };
    expect(secondSnapshot.ver).toBe(7);
    expect(decodeRle64(secondSnapshot.bits)[9]).toBe(1);
  });
});
