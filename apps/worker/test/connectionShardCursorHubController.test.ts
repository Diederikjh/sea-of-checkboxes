import { describe, expect, it, vi } from "vitest";

import type { CursorPresence, CursorRelayBatch } from "../src/cursorRelay";
import { ConnectionShardCursorHubController } from "../src/connectionShardCursorHubController";
import type { CursorHubWatchResponse } from "../src/cursorHubGateway";
class MockCursorHubGateway {
  watchCalls: Array<{ shard: string; action: "sub" | "unsub" }> = [];
  watchResponses: Array<CursorHubWatchResponse | null> = [];

  async watchShard(shard: string, action: "sub" | "unsub"): Promise<CursorHubWatchResponse | null> {
    this.watchCalls.push({ shard, action });
    return this.watchResponses.shift() ?? null;
  }
}

function createControllerHarness(options: {
  hasClients?: boolean;
  watchResponses?: Array<CursorHubWatchResponse | null>;
  watchRenewMs?: number;
  watchProbeRenewMs?: number;
}) {
  let hasClients = options.hasClients ?? true;
  const ingested: CursorRelayBatch[] = [];
  const watchedPeerShards: string[][] = [];
  const gateway = new MockCursorHubGateway();
  gateway.watchResponses = [...(options.watchResponses ?? [])];

  const controller = new ConnectionShardCursorHubController({
    gateway,
    hasClients: () => hasClients,
    currentShardName: () => "shard-a",
    ingestBatch: (batch) => {
      ingested.push(batch);
    },
    updateWatchedPeerShards: (peerShards) => {
      watchedPeerShards.push([...peerShards]);
    },
    deferDetachedTask: (task) => {
      void task();
    },
    maybeUnrefTimer: () => {},
    watchRenewMs: options.watchRenewMs ?? 60_000,
    watchProbeRenewMs: options.watchProbeRenewMs ?? 5_000,
  });

  return {
    controller,
    gateway,
    ingested,
    watchedPeerShards,
    setHasClients(value: boolean) {
      hasClients = value;
    },
  };
}

async function flushControllerLoop(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function expectWatchCalls(
  actual: Array<{ shard: string; action: "sub" | "unsub" }>,
  expected: Array<{ shard: string; action: "sub" | "unsub" }>
): void {
  expect(actual).toEqual(expected);
}

function cursor(uid: string): CursorPresence {
  return {
    uid,
    name: uid,
    x: 1,
    y: 2,
    seenAt: Date.now(),
    seq: 1,
    tileKey: "0:0",
  };
}

describe("ConnectionShardCursorHubController", () => {
  it("registers watch and ingests snapshot updates when clients are present", async () => {
    const watchState: CursorHubWatchResponse = {
      snapshot: {
        from: "shard-b",
        updates: [cursor("u_remote")],
      },
      peerShards: ["shard-b", "shard-c"],
    };
    const harness = createControllerHarness({
      watchResponses: [watchState],
    });

    harness.controller.refreshWatchState();
    await flushControllerLoop();

    expectWatchCalls(harness.gateway.watchCalls, [
      { shard: "shard-a", action: "sub" },
    ]);
    expect(harness.ingested).toEqual([watchState.snapshot]);
    expect(harness.watchedPeerShards).toEqual([["shard-b", "shard-c"]]);
  });

  it("does not register a watch when there are no clients", async () => {
    const harness = createControllerHarness({
      hasClients: false,
    });

    harness.controller.refreshWatchState();
    await flushControllerLoop();

    expect(harness.gateway.watchCalls).toEqual([]);
    expect(harness.ingested).toEqual([]);
    expect(harness.watchedPeerShards).toEqual([[]]);
  });

  it("unsubscribes when clients drop to zero", async () => {
    const harness = createControllerHarness({
      watchResponses: [null, null],
    });

    harness.controller.refreshWatchState();
    await flushControllerLoop();
    expectWatchCalls(harness.gateway.watchCalls, [
      { shard: "shard-a", action: "sub" },
    ]);

    harness.setHasClients(false);
    harness.controller.refreshWatchState();
    await flushControllerLoop();

    expectWatchCalls(harness.gateway.watchCalls, [
      { shard: "shard-a", action: "sub" },
      { shard: "shard-a", action: "unsub" },
    ]);
    expect(harness.watchedPeerShards.at(-1)).toEqual([]);
  });

  it("repeated refreshes only issue watch actions for the current shard", async () => {
    const harness = createControllerHarness({
      watchResponses: [null, null],
    });

    harness.controller.refreshWatchState();
    harness.controller.refreshWatchState();
    await flushControllerLoop();

    expect(harness.gateway.watchCalls.length).toBeGreaterThanOrEqual(1);
    expect(harness.gateway.watchCalls[0]).toEqual({
      shard: "shard-a",
      action: "sub",
    });

    harness.setHasClients(false);
    harness.controller.refreshWatchState();
    harness.controller.refreshWatchState();
    await flushControllerLoop();

    expect(harness.gateway.watchCalls.some((call) => call.action === "unsub")).toBe(true);
    expect(harness.gateway.watchCalls[harness.gateway.watchCalls.length - 1]).toEqual({
      shard: "shard-a",
      action: "unsub",
    });

    expect(harness.gateway.watchCalls.every((call) => call.shard === "shard-a")).toBe(true);
  });

  it("renews watch quickly while no watched peers are present", async () => {
    vi.useFakeTimers();
    try {
      const harness = createControllerHarness({
        watchResponses: [
          {
            snapshot: {
              from: "cursor-hub",
              updates: [],
            },
            peerShards: [],
          },
          {
            snapshot: {
              from: "cursor-hub",
              updates: [],
            },
            peerShards: ["shard-b"],
          },
        ],
        watchRenewMs: 60_000,
        watchProbeRenewMs: 5_000,
      });

      harness.controller.refreshWatchState();
      await flushControllerLoop();

      expectWatchCalls(harness.gateway.watchCalls, [
        { shard: "shard-a", action: "sub" },
      ]);
      expect(harness.watchedPeerShards).toEqual([[]]);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(harness.gateway.watchCalls).toEqual([
        { shard: "shard-a", action: "sub" },
      ]);

      await vi.advanceTimersByTimeAsync(1);
      await flushControllerLoop();

      expectWatchCalls(harness.gateway.watchCalls, [
        { shard: "shard-a", action: "sub" },
        { shard: "shard-a", action: "sub" },
      ]);
      expect(harness.watchedPeerShards).toEqual([[], ["shard-b"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to the normal renew interval once watched peers are known", async () => {
    vi.useFakeTimers();
    try {
      const harness = createControllerHarness({
        watchResponses: [
          {
            snapshot: {
              from: "cursor-hub",
              updates: [],
            },
            peerShards: ["shard-b"],
          },
          null,
        ],
        watchRenewMs: 60_000,
        watchProbeRenewMs: 5_000,
      });

      harness.controller.refreshWatchState();
      await flushControllerLoop();

      expectWatchCalls(harness.gateway.watchCalls, [
        { shard: "shard-a", action: "sub" },
      ]);
      expect(harness.watchedPeerShards).toEqual([["shard-b"]]);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.gateway.watchCalls).toEqual([
        { shard: "shard-a", action: "sub" },
      ]);

      await vi.advanceTimersByTimeAsync(55_000);
      await flushControllerLoop();

      expectWatchCalls(harness.gateway.watchCalls, [
        { shard: "shard-a", action: "sub" },
        { shard: "shard-a", action: "sub" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
