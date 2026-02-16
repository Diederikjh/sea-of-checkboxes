import { TILE_CELL_COUNT } from "@sea/domain";
import { describe, expect, it } from "vitest";

import { applyBatch, applyCellOp, createEmptyTileState } from "../src";

describe("tile state helpers", () => {
  it("creates empty tile state", () => {
    const state = createEmptyTileState();
    expect(state.ver).toBe(0);
    expect(state.bits.length).toBe(TILE_CELL_COUNT);
    expect(state.bits.every((value) => value === 0)).toBe(true);
  });

  it("applyCellOp reports changed/no-op accurately", () => {
    const bits = new Uint8Array(TILE_CELL_COUNT);

    expect(applyCellOp(bits, 10, 1)).toBe(true);
    expect(bits[10]).toBe(1);

    expect(applyCellOp(bits, 10, 1)).toBe(false);
    expect(bits[10]).toBe(1);

    expect(applyCellOp(bits, 10, 0)).toBe(true);
    expect(bits[10]).toBe(0);
  });

  it("applyBatch returns number of changed cells", () => {
    const bits = new Uint8Array(TILE_CELL_COUNT);

    const changed = applyBatch(bits, [
      [1, 1],
      [2, 1],
      [2, 1],
      [1, 0],
      [3, 0],
    ]);

    expect(changed).toBe(3);
    expect(bits[1]).toBe(0);
    expect(bits[2]).toBe(1);
    expect(bits[3]).toBe(0);
  });
});
