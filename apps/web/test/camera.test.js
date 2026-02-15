import { describe, expect, it } from "vitest";

import { createCamera, zoomCamera, canEditAtZoom } from "../src/camera";

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
});
