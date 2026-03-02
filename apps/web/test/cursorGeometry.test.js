import { describe, expect, it } from "vitest";

import {
  cursorWorldPosition,
  isScreenCellInViewport,
  isScreenCircleInViewport,
  isScreenPointInViewport,
  worldToScreenPoint,
} from "../src/cursorGeometry";

describe("cursorGeometry", () => {
  it("prefers draw coordinates when present", () => {
    expect(cursorWorldPosition({ x: 1.5, y: 2.5, drawX: 3.5, drawY: 4.5 })).toEqual({
      x: 3.5,
      y: 4.5,
    });
  });

  it("falls back to cursor x/y when draw coordinates are not finite", () => {
    expect(cursorWorldPosition({ x: 1.5, y: 2.5, drawX: Number.NaN, drawY: Infinity })).toEqual({
      x: 1.5,
      y: 2.5,
    });
  });

  it("projects world to screen from camera and viewport", () => {
    const camera = { x: 10, y: 5, cellPixelSize: 20 };
    expect(worldToScreenPoint(11, 6, camera, 800, 600)).toEqual({ x: 420, y: 320 });
  });

  it("handles point/cell/circle viewport visibility with margins", () => {
    expect(isScreenPointInViewport(-5, 10, 100, 100, 10)).toBe(true);
    expect(isScreenPointInViewport(-11, 10, 100, 100, 10)).toBe(false);

    expect(isScreenCellInViewport(-8, 5, 10, 100, 100, 0)).toBe(true);
    expect(isScreenCellInViewport(-11, 5, 10, 100, 100, 0)).toBe(false);

    expect(isScreenCircleInViewport(-6, 10, 8, 100, 100, 0)).toBe(true);
    expect(isScreenCircleInViewport(-9, 10, 8, 100, 100, 0)).toBe(false);
  });
});
