import { describe, expect, it } from "vitest";

import { enumerateVisibleTiles } from "../src";

describe("viewport tile enumeration", () => {
  it("enumerates visible tiles including margin", () => {
    const tiles = enumerateVisibleTiles({
      cameraX: 0,
      cameraY: 0,
      viewportWidthPx: 512,
      viewportHeightPx: 512,
      cellPixelSize: 8,
      marginTiles: 1,
    });

    const keys = new Set(tiles.map((tile) => tile.tileKey));
    expect(keys.has("0:0")).toBe(true);
    expect(keys.has("1:1")).toBe(true);
    expect(keys.has("-1:-1")).toBe(true);
  });

  it("returns empty list on non-positive zoom", () => {
    const tiles = enumerateVisibleTiles({
      cameraX: 0,
      cameraY: 0,
      viewportWidthPx: 200,
      viewportHeightPx: 200,
      cellPixelSize: 0,
    });
    expect(tiles).toEqual([]);
  });
});
