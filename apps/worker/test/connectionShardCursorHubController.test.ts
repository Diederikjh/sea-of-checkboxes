import { describe, expect, it } from "vitest";

import type { CursorPresence, CursorRelayBatch } from "../src/cursorRelay";
import { ConnectionShardCursorHubController } from "../src/connectionShardCursorHubController";
import { waitFor } from "./helpers/waitFor";

class MockCursorHubGateway {
  watchCalls: Array<{ shard: string; action: "sub" | "unsub" }> = [];
  publishCalls: Array<{ from: string; updates: CursorPresence[] }> = [];
  watchResponses: Array<CursorRelayBatch | null> = [];

  async watchShard(shard: string, action: "sub" | "unsub"): Promise<CursorRelayBatch | null> {
    this.watchCalls.push({ shard, action });
    return this.watchResponses.shift() ?? null;
  }

  async publishLocalCursors(from: string, updates: CursorPresence[]): Promise<void> {
    this.publishCalls.push({ from, updates });
  }
}

function createControllerHarness(options: {
  hasClients?: boolean;
  canRelayNow?: boolean;
  localSnapshot?: CursorPresence[];
  watchResponses?: Array<CursorRelayBatch | null>;
}) {
  let hasClients = options.hasClients ?? true;
  let canRelayNow = options.canRelayNow ?? true;
  let localSnapshot = options.localSnapshot ?? [];
  const ingested: CursorRelayBatch[] = [];
  const gateway = new MockCursorHubGateway();
  gateway.watchResponses = [...(options.watchResponses ?? [])];

  const controller = new ConnectionShardCursorHubController({
    gateway,
    hasClients: () => hasClients,
    currentShardName: () => "shard-a",
    canRelayNow: () => canRelayNow,
    localCursorSnapshot: () => localSnapshot,
    ingestBatch: (batch) => {
      ingested.push(batch);
    },
    deferDetachedTask: (task) => {
      void task();
    },
    maybeUnrefTimer: () => {},
    publishFlushMs: 0,
    watchRenewMs: 60_000,
  });

  return {
    controller,
    gateway,
    ingested,
    setHasClients(value: boolean) {
      hasClients = value;
    },
    setCanRelayNow(value: boolean) {
      canRelayNow = value;
    },
    setLocalSnapshot(value: CursorPresence[]) {
      localSnapshot = value;
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

  it("publishes local cursors when marked dirty after subscription", async () => {
    const local = cursor("u_local");
    const harness = createControllerHarness({
      watchResponses: [null],
      localSnapshot: [local],
    });

    harness.controller.refreshWatchState();
    await waitFor(() => {
      expect(harness.gateway.watchCalls.length).toBe(1);
    });

    harness.controller.markLocalCursorDirty();

    await waitFor(() => {
      expect(harness.gateway.publishCalls).toHaveLength(1);
      expect(harness.gateway.publishCalls[0]).toEqual({
        from: "shard-a",
        updates: [local],
      });
    });
  });

  it("queues subscription first when a publish arrives before watch is established", async () => {
    const local = cursor("u_local");
    const harness = createControllerHarness({
      watchResponses: [null],
      localSnapshot: [local],
    });

    harness.controller.markLocalCursorDirty();

    await waitFor(() => {
      expect(harness.gateway.watchCalls).toEqual([
        { shard: "shard-a", action: "sub" },
      ]);
      expect(harness.gateway.publishCalls).toHaveLength(1);
    });
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

  it("defers publish while relay is suppressed and retries after suppression lifts", async () => {
    const local = cursor("u_local");
    const harness = createControllerHarness({
      watchResponses: [null],
      localSnapshot: [local],
      canRelayNow: false,
    });

    harness.controller.refreshWatchState();
    await waitFor(() => {
      expect(harness.gateway.watchCalls.length).toBe(1);
    });

    harness.controller.markLocalCursorDirty();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.gateway.publishCalls).toHaveLength(0);

    harness.setCanRelayNow(true);
    harness.controller.markLocalCursorDirty();
    await waitFor(() => {
      expect(harness.gateway.publishCalls).toHaveLength(1);
    });
  });
});
