import { describe, expect, it } from "vitest";

import type { CursorPresence, CursorRelayBatch } from "../src/cursorRelay";
import { ConnectionShardCursorHubController } from "../src/connectionShardCursorHubController";
import { waitFor } from "./helpers/waitFor";

class MockCursorHubGateway {
  watchCalls: Array<{ shard: string; action: "sub" | "unsub" }> = [];
  watchResponses: Array<CursorRelayBatch | null> = [];

  async watchShard(shard: string, action: "sub" | "unsub"): Promise<CursorRelayBatch | null> {
    this.watchCalls.push({ shard, action });
    return this.watchResponses.shift() ?? null;
  }
}

function createControllerHarness(options: {
  hasClients?: boolean;
  watchResponses?: Array<CursorRelayBatch | null>;
}) {
  let hasClients = options.hasClients ?? true;
  const ingested: CursorRelayBatch[] = [];
  const gateway = new MockCursorHubGateway();
  gateway.watchResponses = [...(options.watchResponses ?? [])];

  const controller = new ConnectionShardCursorHubController({
    gateway,
    hasClients: () => hasClients,
    currentShardName: () => "shard-a",
    ingestBatch: (batch) => {
      ingested.push(batch);
    },
    deferDetachedTask: (task) => {
      void task();
    },
    maybeUnrefTimer: () => {},
    watchRenewMs: 60_000,
  });

  return {
    controller,
    gateway,
    ingested,
    setHasClients(value: boolean) {
      hasClients = value;
    },
  };
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
    const snapshot: CursorRelayBatch = {
      from: "shard-b",
      updates: [cursor("u_remote")],
    };
    const harness = createControllerHarness({
      watchResponses: [snapshot],
    });

    harness.controller.refreshWatchState();

    await waitFor(() => {
      expect(harness.gateway.watchCalls).toEqual([
        { shard: "shard-a", action: "sub" },
      ]);
      expect(harness.ingested).toEqual([snapshot]);
    });
  });

  it("does not register a watch when there are no clients", async () => {
    const harness = createControllerHarness({
      hasClients: false,
    });

    harness.controller.refreshWatchState();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.gateway.watchCalls).toEqual([]);
    expect(harness.ingested).toEqual([]);
  });

  it("unsubscribes when clients drop to zero", async () => {
    const harness = createControllerHarness({
      watchResponses: [null, null],
    });

    harness.controller.refreshWatchState();
    await waitFor(() => {
      expect(harness.gateway.watchCalls).toEqual([
        { shard: "shard-a", action: "sub" },
      ]);
    });

    harness.setHasClients(false);
    harness.controller.refreshWatchState();

    await waitFor(() => {
      expect(harness.gateway.watchCalls).toEqual([
        { shard: "shard-a", action: "sub" },
        { shard: "shard-a", action: "unsub" },
      ]);
    });
  });

  it("repeated refreshes only issue watch actions for the current shard", async () => {
    const harness = createControllerHarness({
      watchResponses: [null, null],
    });

    harness.controller.refreshWatchState();
    harness.controller.refreshWatchState();

    await waitFor(() => {
      expect(harness.gateway.watchCalls.length).toBeGreaterThanOrEqual(1);
      expect(harness.gateway.watchCalls[0]).toEqual({
        shard: "shard-a",
        action: "sub",
      });
    });

    harness.setHasClients(false);
    harness.controller.refreshWatchState();
    harness.controller.refreshWatchState();

    await waitFor(() => {
      expect(harness.gateway.watchCalls.some((call) => call.action === "unsub")).toBe(true);
      expect(harness.gateway.watchCalls[harness.gateway.watchCalls.length - 1]).toEqual({
        shard: "shard-a",
        action: "unsub",
      });
    });

    expect(harness.gateway.watchCalls.every((call) => call.shard === "shard-a")).toBe(true);
  });
});
