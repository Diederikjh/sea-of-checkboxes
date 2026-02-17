import { decodeRle64 } from "@sea/protocol";
import { describe, expect, it } from "vitest";

import { TileOwnerDO } from "../src/worker";

class FakeStorage {
  #data: Map<string, unknown>;

  constructor() {
    this.#data = new Map();
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.#data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#data.set(key, value);
  }
}

class FakeShardStub {
  readonly name: string;
  readonly requests: Array<{ url: string; method: string; body: string }>;
  #neverResolveTileBatch: boolean;

  constructor(name: string) {
    this.name = name;
    this.requests = [];
    this.#neverResolveTileBatch = false;
  }

  setNeverResolveTileBatch(value: boolean): void {
    this.#neverResolveTileBatch = value;
  }

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request =
      typeof input === "string"
        ? new Request(input, init)
        : input;

    this.requests.push({
      url: request.url,
      method: request.method,
      body: await request.text(),
    });

    const url = new URL(request.url);
    if (this.#neverResolveTileBatch && url.pathname === "/tile-batch") {
      return new Promise<Response>(() => {});
    }

    return new Response(null, { status: 204 });
  }
}

class FakeNamespace {
  readonly #stubs: Map<string, FakeShardStub>;

  constructor() {
    this.#stubs = new Map();
  }

  getByName(name: string): FakeShardStub {
    let stub = this.#stubs.get(name);
    if (!stub) {
      stub = new FakeShardStub(name);
      this.#stubs.set(name, stub);
    }
    return stub;
  }
}

function createTileOwnerHarness() {
  const storage = new FakeStorage();
  const shardNamespace = new FakeNamespace();
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

async function waitFor(
  assertion: () => void,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 5;

  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
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
    harness.shardNamespace.getByName("shard-a").setNeverResolveTileBatch(true);

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
