import { describe, expect, it } from "vitest";
import { WORLD_MAX } from "@sea/domain";

import { createCamera, panCamera, zoomCamera, canEditAtZoom } from "../src/camera";

describe("camera", () => {
  it("clamps minimum zoom", () => {
    const camera = createCamera({ cellPixelSize: 8 });
    zoomCamera(camera, 0.001);
    expect(camera.cellPixelSize).toBeGreaterThanOrEqual(4);
  });

  it("reports edit gating", () => {
    const camera = createCamera({ cellPixelSize: 7.9 });
    expect(canEditAtZoom(camera)).toBe(false);
    camera.cellPixelSize = 8;
    expect(canEditAtZoom(camera)).toBe(true);
  });

  it("clamps initial camera center to world bounds", () => {
    const camera = createCamera({ x: WORLD_MAX + 50, y: -WORLD_MAX - 50 });
    expect(camera.x).toBe(WORLD_MAX);
    expect(camera.y).toBe(-WORLD_MAX);
  });

  it("clamps panning to world bounds", () => {
    const camera = createCamera({ x: WORLD_MAX - 1, y: -WORLD_MAX + 1 });
    panCamera(camera, 100, -100);
    expect(camera.x).toBe(WORLD_MAX);
    expect(camera.y).toBe(-WORLD_MAX);
  });
});
