import { describe, expect, it } from "vitest";

import {
  MAX_TILE_ABS,
  WORLD_MAX,
  clampCameraCenter,
  isCellIndexValid,
  isTileCoordInBounds,
  isWorldCoordInBounds,
} from "../src";

describe("validation", () => {
  it("clamps camera to world range", () => {
    expect(clampCameraCenter(WORLD_MAX + 10, -WORLD_MAX - 99)).toEqual({
      x: WORLD_MAX,
      y: -WORLD_MAX,
    });
  });

  it("checks world/tile bounds", () => {
    expect(isWorldCoordInBounds(10, -10)).toBe(true);
    expect(isWorldCoordInBounds(Number.NaN, 0)).toBe(false);
    expect(isTileCoordInBounds(MAX_TILE_ABS, -MAX_TILE_ABS)).toBe(true);
    expect(isTileCoordInBounds(MAX_TILE_ABS + 1, 0)).toBe(false);
  });

  it("checks cell index bounds", () => {
    expect(isCellIndexValid(0)).toBe(true);
    expect(isCellIndexValid(4095)).toBe(true);
    expect(isCellIndexValid(4096)).toBe(false);
  });
});
