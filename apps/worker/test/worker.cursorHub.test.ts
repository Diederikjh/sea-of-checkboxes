import { afterEach, describe, expect, it, vi } from "vitest";

import { CursorHubDO } from "../src/worker";
import {
  RecordingDurableObjectStub,
  StubNamespace,
} from "./helpers/doStubs";
import { NullStorage } from "./helpers/storageMocks";
import { waitFor } from "./helpers/waitFor";

function createHarness() {
  const shardNamespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  const env = {
    CONNECTION_SHARD: shardNamespace,
    TILE_OWNER: shardNamespace,
  };
  const state = {
    id: { toString: () => "cursor-hub:global" },
    storage: new NullStorage(),
  };

  return {
    hub: new CursorHubDO(state, env),
    shardNamespace,
  };
}

async function postWatch(hub: CursorHubDO, shard: string, action: "sub" | "unsub"): Promise<Response> {
  return hub.fetch(
    new Request("https://cursor-hub.internal/watch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        shard,
        action,
      }),
    })
  );
}

async function postPublish(
  hub: CursorHubDO,
  from: string,
  updates: Array<{
    uid: string;
    name: string;
    x: number;
    y: number;
    seenAt: number;
    seq: number;
    tileKey: string;
  }>
): Promise<Response> {
  return hub.fetch(
    new Request("https://cursor-hub.internal/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        updates,
      }),
    })
  );
}

describe("CursorHubDO", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fans out published updates to subscribed shards except the origin shard", async () => {
    const harness = createHarness();

    const subA = await postWatch(harness.hub, "shard-a", "sub");
    expect(subA.status).toBe(200);
    await expect(subA.json()).resolves.toEqual({
      from: "cursor-hub",
      updates: [],
    });

    const subB = await postWatch(harness.hub, "shard-b", "sub");
    expect(subB.status).toBe(200);
    await expect(subB.json()).resolves.toEqual({
      from: "cursor-hub",
      updates: [],
    });

    const publish = await postPublish(harness.hub, "shard-a", [
      {
        uid: "u_a",
        name: "Alice",
        x: 1.5,
        y: 2.5,
        seenAt: Date.now(),
        seq: 1,
        tileKey: "0:0",
      },
    ]);
    expect(publish.status).toBe(204);

    const shardAStub = harness.shardNamespace.getByName("shard-a");
    const shardBStub = harness.shardNamespace.getByName("shard-b");
    expect(shardAStub.requests.length).toBe(0);
    await waitFor(() => {
      expect(shardBStub.requests.length).toBe(1);
    });

    const fanoutRequest = shardBStub.requests[0]?.request;
    expect(fanoutRequest?.method).toBe("POST");
    expect(new URL(fanoutRequest?.url ?? "https://connection-shard.internal/").pathname).toBe("/cursor-batch");
    expect(fanoutRequest?.headers.get("x-sea-cursor-hub")).toBe("1");
    await expect(fanoutRequest?.json()).resolves.toEqual({
      from: "shard-a",
      updates: [
        {
          uid: "u_a",
          name: "Alice",
          x: 1.5,
          y: 2.5,
          seenAt: expect.any(Number),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
  });

  it("returns snapshot on subscribe, rejects stale seq replays, and prunes stale cursors", async () => {
    const harness = createHarness();
    await postWatch(harness.hub, "shard-a", "sub");
    await postWatch(harness.hub, "shard-b", "sub");

    const nowMs = Date.now();
    await postPublish(harness.hub, "shard-a", [
      {
        uid: "u_a",
        name: "Alice",
        x: 2.5,
        y: 2.5,
        seenAt: nowMs,
        seq: 2,
        tileKey: "0:0",
      },
    ]);
    await waitFor(() => {
      expect(harness.shardNamespace.getByName("shard-b").requests.length).toBe(1);
    });

    await postPublish(harness.hub, "shard-a", [
      {
        uid: "u_a",
        name: "Alice",
        x: 4.5,
        y: 4.5,
        seenAt: nowMs + 1,
        seq: 1,
        tileKey: "0:0",
      },
    ]);
    expect(harness.shardNamespace.getByName("shard-b").requests.length).toBe(1);

    const subC = await postWatch(harness.hub, "shard-c", "sub");
    expect(subC.status).toBe(200);
    await expect(subC.json()).resolves.toEqual({
      from: "cursor-hub",
      updates: [
        {
          uid: "u_a",
          name: "Alice",
          x: 2.5,
          y: 2.5,
          seenAt: nowMs,
          seq: 2,
          tileKey: "0:0",
        },
      ],
    });

    await postPublish(harness.hub, "shard-a", [
      {
        uid: "u_stale",
        name: "Stale",
        x: 8.5,
        y: 8.5,
        seenAt: nowMs - 10_000,
        seq: 1,
        tileKey: "0:0",
      },
    ]);
    const subD = await postWatch(harness.hub, "shard-d", "sub");
    expect(subD.status).toBe(200);
    const snapshotD = (await subD.json()) as { updates: Array<{ uid: string }> };
    expect(snapshotD.updates.some((update) => update.uid === "u_stale")).toBe(false);
  });

  it("returns from publish without waiting for downstream shard fanout", async () => {
    const harness = createHarness();
    await postWatch(harness.hub, "shard-a", "sub");
    await postWatch(harness.hub, "shard-b", "sub");

    const shardBStub = harness.shardNamespace.getByName("shard-b");
    shardBStub.setNeverResolvePath("/cursor-batch", true);

    const publishPromise = postPublish(harness.hub, "shard-a", [
      {
        uid: "u_a",
        name: "Alice",
        x: 1.5,
        y: 2.5,
        seenAt: Date.now(),
        seq: 1,
        tileKey: "0:0",
      },
    ]);

    const resolvedQuickly = await Promise.race([
      publishPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 20);
      }),
    ]);
    expect(resolvedQuickly).toBe(true);
  });

  it("dedupes updates for the same uid within a single fanout flush window", async () => {
    vi.useFakeTimers();

    const harness = createHarness();
    await postWatch(harness.hub, "shard-a", "sub");
    await postWatch(harness.hub, "shard-b", "sub");

    await postPublish(harness.hub, "shard-a", [
      {
        uid: "u_a",
        name: "Alice",
        x: 1.5,
        y: 2.5,
        seenAt: Date.now(),
        seq: 1,
        tileKey: "0:0",
      },
    ]);
    await postPublish(harness.hub, "shard-a", [
      {
        uid: "u_a",
        name: "Alice",
        x: 3.5,
        y: 4.5,
        seenAt: Date.now() + 1,
        seq: 2,
        tileKey: "0:0",
      },
    ]);

    await vi.advanceTimersByTimeAsync(30);

    const shardBRequests = harness.shardNamespace.getByName("shard-b").requests;
    expect(shardBRequests.length).toBe(1);
    await expect(shardBRequests[0]?.request.json()).resolves.toEqual({
      from: "shard-a",
      updates: [
        {
          uid: "u_a",
          name: "Alice",
          x: 3.5,
          y: 4.5,
          seenAt: expect.any(Number),
          seq: 2,
          tileKey: "0:0",
        },
      ],
    });
  });

  it("requeues fanout when new updates arrive while a flush is in-flight", async () => {
    vi.useFakeTimers();

    const harness = createHarness();
    await postWatch(harness.hub, "shard-a", "sub");
    await postWatch(harness.hub, "shard-b", "sub");

    const shardBStub = harness.shardNamespace.getByName("shard-b");
    const originalFetch = shardBStub.fetch.bind(shardBStub);
    let releaseFirstFanout: (() => void) | undefined;

    shardBStub.fetch = (async (input: Request | string, init?: RequestInit): Promise<Response> => {
      const request = typeof input === "string" ? new Request(input, init) : input;
      if (new URL(request.url).pathname === "/cursor-batch" && !releaseFirstFanout) {
        await new Promise<void>((resolve) => {
          releaseFirstFanout = resolve;
        });
      }
      return originalFetch(input, init);
    }) as typeof shardBStub.fetch;

    await postPublish(harness.hub, "shard-a", [
      {
        uid: "u_a",
        name: "Alice",
        x: 1.5,
        y: 2.5,
        seenAt: Date.now(),
        seq: 1,
        tileKey: "0:0",
      },
    ]);

    await vi.advanceTimersByTimeAsync(30);
    expect(shardBStub.requests.length).toBe(0);

    await postPublish(harness.hub, "shard-a", [
      {
        uid: "u_b",
        name: "Bob",
        x: 4.5,
        y: 5.5,
        seenAt: Date.now() + 1,
        seq: 1,
        tileKey: "0:0",
      },
    ]);

    await vi.advanceTimersByTimeAsync(30);
    expect(shardBStub.requests.length).toBe(0);

    if (!releaseFirstFanout) {
      throw new Error("Expected first fanout to be in-flight");
    }
    releaseFirstFanout();
    await vi.runAllTimersAsync();

    await waitFor(() => {
      expect(shardBStub.requests.length).toBe(2);
    });

    await expect(shardBStub.requests[0]?.request.json()).resolves.toEqual({
      from: "shard-a",
      updates: [
        {
          uid: "u_a",
          name: "Alice",
          x: 1.5,
          y: 2.5,
          seenAt: expect.any(Number),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });

    await expect(shardBStub.requests[1]?.request.json()).resolves.toEqual({
      from: "shard-a",
      updates: [
        {
          uid: "u_b",
          name: "Bob",
          x: 4.5,
          y: 5.5,
          seenAt: expect.any(Number),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
  });
});
