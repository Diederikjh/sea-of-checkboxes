import { decodeRle64 } from "@sea/protocol";
import { describe, expect, it } from "vitest";

import { TileOwnerDO } from "../src/worker";
import {
  RecordingDurableObjectStub,
  StubNamespace,
} from "./helpers/doStubs";
import { MemoryStorage } from "./helpers/storageMocks";
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
});
