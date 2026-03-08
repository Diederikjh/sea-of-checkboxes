import { describe, expect, it, vi } from "vitest";

import { createSetCellOutboxSync } from "../src/setCellOutboxSync";

function createHarness({ setTimeoutFn, clearTimeoutFn } = {}) {
  const sendToWireTransport = vi.fn();
  const onSyncWaitEvent = vi.fn();
  const offlineBannerEl = {
    hidden: true,
    textContent: "",
  };
  let currentMs = 1_000;

  const sync = createSetCellOutboxSync({
    offlineBannerEl,
    sendToWireTransport,
    isTransportOnline: () => true,
    nowMs: () => currentMs,
    onSyncWaitEvent,
    setTimeoutFn,
    clearTimeoutFn,
  });

  return {
    sync,
    sendToWireTransport,
    offlineBannerEl,
    onSyncWaitEvent,
    advanceTime(ms) {
      currentMs += ms;
    },
  };
}

describe("setCell outbox sync", () => {
  it("clears pending setCell intent on authoritative single-cell server update", () => {
    const { sync } = createHarness();

    sync.trackOutgoingClientMessage({
      t: "setCell",
      tile: "0:-1",
      i: 10,
      v: 1,
      op: "op_local",
    });

    expect(sync.getPendingSetCellOpsForTile("0:-1")).toEqual([{ i: 10, v: 1 }]);

    sync.handleServerMessage({
      t: "cellUp",
      tile: "0:-1",
      i: 10,
      v: 0,
      ver: 100,
    });

    expect(sync.getPendingSetCellOpsForTile("0:-1")).toEqual([]);
  });

  it("clears pending setCell intent on authoritative batch server update", () => {
    const { sync } = createHarness();

    sync.trackOutgoingClientMessage({
      t: "setCell",
      tile: "0:-1",
      i: 7,
      v: 1,
      op: "op_local",
    });

    expect(sync.getPendingSetCellOpsForTile("0:-1")).toEqual([{ i: 7, v: 1 }]);

    sync.handleServerMessage({
      t: "cellUpBatch",
      tile: "0:-1",
      fromVer: 50,
      toVer: 52,
      ops: [
        [7, 0],
        [15, 1],
      ],
    });

    expect(sync.getPendingSetCellOpsForTile("0:-1")).toEqual([]);
  });

  it("keeps pending setCell intents for unrelated cells", () => {
    const { sync } = createHarness();

    sync.trackOutgoingClientMessage({
      t: "setCell",
      tile: "0:-1",
      i: 7,
      v: 1,
      op: "op_local",
    });

    sync.handleServerMessage({
      t: "cellUpBatch",
      tile: "0:-1",
      fromVer: 90,
      toVer: 91,
      ops: [[8, 1]],
    });

    expect(sync.getPendingSetCellOpsForTile("0:-1")).toEqual([{ i: 7, v: 1 }]);
  });

  it("drops all pending intents for a tile on snapshot authority", () => {
    const { sync, onSyncWaitEvent } = createHarness();

    sync.trackOutgoingClientMessage({
      t: "setCell",
      tile: "0:-1",
      i: 7,
      v: 1,
      op: "op_1",
    });
    sync.trackOutgoingClientMessage({
      t: "setCell",
      tile: "0:-1",
      i: 8,
      v: 1,
      op: "op_2",
    });
    sync.trackOutgoingClientMessage({
      t: "setCell",
      tile: "0:0",
      i: 1,
      v: 1,
      op: "op_3",
    });

    expect(sync.dropPendingSetCellOpsForTile("0:-1")).toBe(2);
    expect(sync.getPendingSetCellOpsForTile("0:-1")).toEqual([]);
    expect(sync.getPendingSetCellOpsForTile("0:0")).toEqual([{ i: 1, v: 1 }]);
    expect(onSyncWaitEvent).toHaveBeenCalledWith(
      "setcell_sync_wait_dropped",
      expect.objectContaining({
        tile: "0:-1",
        reason: "tile_snapshot_authority",
      })
    );
  });

  it("logs sync-wait start and authoritative clear with cid and elapsed time", () => {
    const { sync, onSyncWaitEvent, advanceTime } = createHarness();

    sync.trackOutgoingClientMessage({
      t: "setCell",
      tile: "0:-1",
      i: 10,
      v: 1,
      op: "op_local",
      cid: "c_set_1",
    });

    expect(onSyncWaitEvent).toHaveBeenCalledWith(
      "setcell_sync_wait_started",
      expect.objectContaining({
        tile: "0:-1",
        i: 10,
        v: 1,
        op: "op_local",
        cid: "c_set_1",
        pendingCount: 1,
        pendingForMs: 0,
        replayAttempts: 0,
        reason: "outgoing_setcell",
      })
    );

    advanceTime(250);
    sync.handleServerMessage({
      t: "cellUp",
      tile: "0:-1",
      i: 10,
      v: 1,
      ver: 7,
    });

    expect(onSyncWaitEvent).toHaveBeenLastCalledWith(
      "setcell_sync_wait_cleared",
      expect.objectContaining({
        tile: "0:-1",
        i: 10,
        cid: "c_set_1",
        pendingCount: 0,
        pendingForMs: 250,
        reason: "cellUp",
        serverValue: 1,
        serverVer: 7,
      })
    );
  });

  it("logs replay attempts for pending setCell intents", () => {
    const timers = [];
    const { sync, advanceTime, onSyncWaitEvent, sendToWireTransport } = createHarness({
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeoutFn: () => {},
    });

    sync.trackOutgoingClientMessage({
      t: "setCell",
      tile: "0:-1",
      i: 4,
      v: 1,
      op: "op_replay",
      cid: "c_replay_1",
    });

    sync.scheduleReplay(10);
    expect(timers).toHaveLength(1);
    advanceTime(500);
    timers[0]();

    expect(sendToWireTransport).toHaveBeenCalledWith(expect.objectContaining({
      t: "setCell",
      tile: "0:-1",
      i: 4,
      op: "op_replay",
    }));
    expect(onSyncWaitEvent).toHaveBeenCalledWith(
      "setcell_sync_wait_replayed",
      expect.objectContaining({
        tile: "0:-1",
        i: 4,
        cid: "c_replay_1",
        pendingForMs: 500,
        replayAttempts: 1,
        reason: "scheduled_replay",
      })
    );
  });
});
