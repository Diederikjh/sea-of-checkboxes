import { describe, expect, it, vi } from "vitest";

import { renderDirtyAreas } from "../src/renderer";

function createGraphicsSpy() {
  return {
    beginFill: vi.fn(),
    drawRect: vi.fn(),
    endFill: vi.fn(),
    lineStyle: vi.fn(),
    drawCircle: vi.fn(),
  };
}

describe("renderer dirty patching", () => {
  it("keeps sparse dirty indices sparse (no huge block expansion)", () => {
    const graphics = createGraphicsSpy();
    const dirtyTileCells = new Map([
      ["0:0", new Set([0, 4095])],
    ]);
    const tileStore = {
      get: vi.fn(() => ({
        tileKey: "0:0",
        bits: new Uint8Array(4096),
      })),
    };
    const heatStore = {
      getHeat: vi.fn(() => 0),
    };

    renderDirtyAreas({
      graphics,
      camera: { x: 0, y: 0, cellPixelSize: 8 },
      viewportWidth: 10_000,
      viewportHeight: 10_000,
      visibleTiles: [{ tileKey: "0:0", tx: 0, ty: 0 }],
      dirtyTileCells,
      tileStore,
      heatStore,
      cursors: new Map(),
    });

    expect(graphics.drawRect).toHaveBeenCalledTimes(2);
  });
});
