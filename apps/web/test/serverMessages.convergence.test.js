import { TILE_CELL_COUNT } from "@sea/domain";
import { encodeRle64 } from "@sea/protocol";
import { describe, expect, it } from "vitest";

import { createServerMessageHandler } from "../src/serverMessages";
import { TileStore } from "../src/tileStore";

function createHarnessWithStore(tileStore) {
  return createServerMessageHandler({
    identityEl: { textContent: "" },
    setStatus() {},
    tileStore,
    heatStore: { ensureTile() {}, bump() {} },
    transport: { send() {} },
    cursors: new Map(),
    selfIdentity: { uid: null },
  });
}

describe("server message convergence", () => {
  it("converges to same tile state for single updates and batch updates", () => {
    const bits = new Uint8Array(TILE_CELL_COUNT);
    const snapshot = {
      t: "tileSnap",
      tile: "0:0",
      ver: 0,
      enc: "rle64",
      bits: encodeRle64(bits),
    };

    const ops = [
      [1, 1],
      [5, 1],
      [5, 0],
      [300, 1],
      [1024, 1],
      [1024, 0],
      [4095, 1],
    ];

    const singleStore = new TileStore(16);
    const batchStore = new TileStore(16);
    const singleHandler = createHarnessWithStore(singleStore);
    const batchHandler = createHarnessWithStore(batchStore);

    singleHandler(snapshot);
    batchHandler(snapshot);

    let ver = 1;
    for (const [index, value] of ops) {
      singleHandler({
        t: "cellUp",
        tile: "0:0",
        i: index,
        v: value,
        ver,
      });
      ver += 1;
    }

    batchHandler({
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 1,
      toVer: ops.length,
      ops,
    });

    const expected = new Uint8Array(TILE_CELL_COUNT);
    for (const [index, value] of ops) {
      expected[index] = value;
    }

    const stateA = singleStore.get("0:0");
    const stateB = batchStore.get("0:0");

    expect(stateA?.ver).toBe(ops.length);
    expect(stateB?.ver).toBe(ops.length);
    expect(stateA?.bits).toEqual(expected);
    expect(stateB?.bits).toEqual(expected);
    expect(stateA?.bits).toEqual(stateB?.bits);
  });
});
