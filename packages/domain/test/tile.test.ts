import { describe, expect, it } from "vitest";

import {
  TILE_CELL_COUNT,
  TILE_SIZE,
  cellIndexFromWorld,
  cellIndexToLocal,
  parseTileKeyStrict,
  tileKeyFromTileCoord,
  worldFromTileCell,
  worldToLocalCell,
  worldToTile,
} from "../src";

describe("tile math", () => {
  it("builds and parses tile keys", () => {
    const key = tileKeyFromTileCoord(-12, 44);
    expect(key).toBe("-12:44");
    expect(parseTileKeyStrict(key)).toEqual({ tx: -12, ty: 44 });
    expect(parseTileKeyStrict("12:44:9")).toBeNull();
    expect(parseTileKeyStrict("a:b")).toBeNull();
  });

  it("maps world coordinates to tile coordinates", () => {
    expect(worldToTile(0, 0)).toEqual({ tx: 0, ty: 0 });
    expect(worldToTile(63, 63)).toEqual({ tx: 0, ty: 0 });
    expect(worldToTile(64, 64)).toEqual({ tx: 1, ty: 1 });
    expect(worldToTile(-1, -1)).toEqual({ tx: -1, ty: -1 });
  });

  it("creates local cell coordinates for negative world coordinates", () => {
    expect(worldToLocalCell(-1, -1)).toEqual({ localX: TILE_SIZE - 1, localY: TILE_SIZE - 1 });
  });

  it("roundtrips cell index through world coordinates", () => {
    const index = cellIndexFromWorld(-1, -1);
    expect(index).toBe(TILE_CELL_COUNT - 1);

    const world = worldFromTileCell(-1, -1, index);
    expect(world).toEqual({ x: -1, y: -1 });
    expect(cellIndexToLocal(index)).toEqual({ localX: TILE_SIZE - 1, localY: TILE_SIZE - 1 });
  });

  it("rejects invalid cell index", () => {
    expect(() => cellIndexToLocal(TILE_CELL_COUNT)).toThrow();
  });
});
