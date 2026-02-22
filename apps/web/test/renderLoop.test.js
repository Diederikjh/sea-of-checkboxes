import { cellIndexFromWorld, tileKeyFromWorld } from "@sea/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_TTL_MS } from "../src/cursorRenderConfig";

const mocks = vi.hoisted(() => ({
  renderDirtyAreas: vi.fn(),
  renderScene: vi.fn(),
  reconcileSubscriptions: vi.fn(),
  smoothCursors: vi.fn(),
  dirtySnapshots: [],
}));

vi.mock("../src/renderer", () => ({
  renderDirtyAreas: mocks.renderDirtyAreas,
  renderScene: mocks.renderScene,
}));

vi.mock("../src/subscriptions", () => ({
  reconcileSubscriptions: mocks.reconcileSubscriptions,
}));

vi.mock("../src/cursorSmoothing", () => ({
  smoothCursors: mocks.smoothCursors,
}));

import { createRenderLoop } from "../src/renderLoop";

function createAppHarness() {
  let onTick = null;
  return {
    app: {
      renderer: {
        width: 800,
        height: 600,
      },
      ticker: {
        add(handler) {
          onTick = handler;
        },
        remove(handler) {
          if (onTick === handler) {
            onTick = null;
          }
        },
      },
    },
    tick(deltaMS = 16) {
      if (!onTick) {
        throw new Error("Expected render loop ticker callback");
      }
      onTick({ deltaMS });
    },
  };
}

describe("render loop cursor dirty patching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    mocks.renderDirtyAreas.mockReset();
    mocks.renderScene.mockReset();
    mocks.reconcileSubscriptions.mockReset();
    mocks.smoothCursors.mockReset();
    mocks.dirtySnapshots.length = 0;

    mocks.reconcileSubscriptions.mockReturnValue({
      visibleTiles: [{ tileKey: "0:0", tx: 0, ty: 0 }],
      subscribedTiles: new Set(["0:0"]),
    });
    mocks.smoothCursors.mockImplementation(() => false);
    mocks.renderScene.mockImplementation(() => []);
    mocks.renderDirtyAreas.mockImplementation(({ dirtyTileCells }) => {
      const snapshot = new Map();
      for (const [tileKey, indices] of dirtyTileCells.entries()) {
        snapshot.set(tileKey, indices === null ? null : new Set(indices));
      }
      mocks.dirtySnapshots.push(snapshot);
      return [];
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("patch-renders cursor movement using dirty tile cells", () => {
    const { app, tick } = createAppHarness();
    const camera = { x: 0, y: 0, cellPixelSize: 16 };
    const cursor = {
      uid: "u_remote",
      name: "Remote",
      x: 1.5,
      y: 1.5,
      drawX: 1.5,
      drawY: 1.5,
      seenAt: Date.now(),
    };
    const cursors = new Map([[cursor.uid, cursor]]);
    const cursorLabels = { update: vi.fn() };

    createRenderLoop({
      app,
      graphics: {},
      camera,
      tileStore: {},
      heatStore: {
        decay: () => false,
      },
      cursors,
      cursorLabels,
      transport: {},
      setStatus: () => {},
    });

    // Initial frame can be a full render due to startup state.
    tick();
    mocks.renderScene.mockClear();
    mocks.renderDirtyAreas.mockClear();
    mocks.dirtySnapshots.length = 0;

    cursor.drawX = 3.5;
    cursor.drawY = 1.5;
    cursor.x = 3.5;
    cursor.y = 1.5;
    cursor.seenAt = Date.now();

    tick();

    expect(mocks.renderDirtyAreas).toHaveBeenCalledTimes(1);
    expect(mocks.renderScene).not.toHaveBeenCalled();

    const dirty = mocks.dirtySnapshots[0];
    const tileKey = tileKeyFromWorld(1, 1);
    const oldCellIndex = cellIndexFromWorld(1, 1);
    const newCellIndex = cellIndexFromWorld(3, 1);

    expect(dirty.has(tileKey)).toBe(true);
    const dirtyIndices = dirty.get(tileKey);
    expect(dirtyIndices).toBeInstanceOf(Set);
    expect(dirtyIndices.has(oldCellIndex)).toBe(true);
    expect(dirtyIndices.has(newCellIndex)).toBe(true);
  });

  it("patch-renders cursor expiry to clear last drawn footprint", () => {
    const { app, tick } = createAppHarness();
    const camera = { x: 0, y: 0, cellPixelSize: 16 };
    const cursor = {
      uid: "u_remote",
      name: "Remote",
      x: 2.5,
      y: 2.5,
      drawX: 2.5,
      drawY: 2.5,
      seenAt: Date.now(),
    };
    const cursors = new Map([[cursor.uid, cursor]]);

    createRenderLoop({
      app,
      graphics: {},
      camera,
      tileStore: {},
      heatStore: {
        decay: () => false,
      },
      cursors,
      cursorLabels: { update: vi.fn() },
      transport: {},
      setStatus: () => {},
    });

    // Initial frame can be full render; expiry behavior is verified on a later frame.
    tick();
    mocks.renderScene.mockClear();
    mocks.renderDirtyAreas.mockClear();
    mocks.dirtySnapshots.length = 0;

    vi.advanceTimersByTime(CURSOR_TTL_MS + 1);
    tick();

    expect(mocks.renderDirtyAreas).toHaveBeenCalledTimes(1);
    expect(mocks.renderScene).not.toHaveBeenCalled();

    const dirty = mocks.dirtySnapshots[0];
    const tileKey = tileKeyFromWorld(2, 2);
    const cellIndex = cellIndexFromWorld(2, 2);
    expect(dirty.has(tileKey)).toBe(true);
    const dirtyIndices = dirty.get(tileKey);
    expect(dirtyIndices).toBeInstanceOf(Set);
    expect(dirtyIndices.has(cellIndex)).toBe(true);
  });

  it("rebuilds subscriptions from an empty baseline after transport reconnect", () => {
    const { app, tick } = createAppHarness();
    const camera = { x: 0, y: 0, cellPixelSize: 16 };
    const observedSubscribedSizes = [];

    mocks.reconcileSubscriptions.mockImplementation(({ subscribedTiles }) => {
      observedSubscribedSizes.push(subscribedTiles.size);
      return {
        visibleTiles: [{ tileKey: "0:0", tx: 0, ty: 0 }],
        subscribedTiles: new Set(["0:0"]),
      };
    });

    const loop = createRenderLoop({
      app,
      graphics: {},
      camera,
      tileStore: {},
      heatStore: {
        decay: () => false,
      },
      cursors: new Map(),
      cursorLabels: { update: vi.fn() },
      transport: {},
      setStatus: () => {},
    });

    expect(observedSubscribedSizes).toEqual([0]);

    loop.markTransportReconnected();
    tick();

    expect(observedSubscribedSizes).toEqual([0, 0]);
  });
});
