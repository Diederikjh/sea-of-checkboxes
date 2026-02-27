import { describe, expect, it, vi } from "vitest";

import { createSetCellOutboxSync } from "../src/setCellOutboxSync";

function createHarness() {
  const sendToWireTransport = vi.fn();
  const offlineBannerEl = {
    hidden: true,
    textContent: "",
  };

  const sync = createSetCellOutboxSync({
    offlineBannerEl,
    sendToWireTransport,
    isTransportOnline: () => true,
  });

  return {
    sync,
    sendToWireTransport,
    offlineBannerEl,
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
});
