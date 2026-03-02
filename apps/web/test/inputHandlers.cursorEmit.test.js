import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupInputHandlers } from "../src/inputHandlers";

function createCanvasHarness() {
  const handlers = new Map();
  return {
    handlers,
    canvas: {
      style: {},
      addEventListener: vi.fn((event, handler) => {
        handlers.set(event, handler);
      }),
      removeEventListener: vi.fn((event) => {
        handlers.delete(event);
      }),
    },
    emit(event, payload) {
      const handler = handlers.get(event);
      if (!handler) {
        throw new Error(`Missing handler for ${event}`);
      }
      handler(payload);
    },
  };
}

function createInspectToggle() {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setAttribute: vi.fn(),
  };
}

function createHarness({ getActiveVisibleRemoteCursorCount = () => 0 } = {}) {
  const canvasHarness = createCanvasHarness();
  const transport = { send: vi.fn() };

  setupInputHandlers({
    canvas: canvasHarness.canvas,
    camera: { x: 0, y: 0, cellPixelSize: 16 },
    getViewportSize: () => ({ width: 640, height: 480 }),
    zoomEl: {},
    transport,
    tileStore: {
      get: vi.fn(),
      applyOptimistic: vi.fn(),
    },
    heatStore: {
      isLocallyDisabled: vi.fn(() => false),
    },
    setStatus: vi.fn(),
    inspectToggleEl: createInspectToggle(),
    inspectLabelEl: { textContent: "" },
    editInfoPopupEl: { hidden: true, style: {} },
    apiBaseUrl: "http://worker.local",
    getActiveVisibleRemoteCursorCount,
  });

  return { ...canvasHarness, transport };
}

describe("inputHandlers adaptive cursor emit policy", () => {
  let nowMs = 0;

  beforeEach(() => {
    vi.spyOn(globalThis.performance, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { visibleCount: 0, intervalMs: 220 },
    { visibleCount: 1, intervalMs: 160 },
    { visibleCount: 3, intervalMs: 120 },
    { visibleCount: 8, intervalMs: 80 },
  ])("uses $intervalMs ms interval for $visibleCount visible cursors", ({ visibleCount, intervalMs }) => {
    const harness = createHarness({ getActiveVisibleRemoteCursorCount: () => visibleCount });

    nowMs = 251;
    harness.emit("pointermove", { clientX: 100, clientY: 100 });

    nowMs = 251 + intervalMs;
    harness.emit("pointermove", { clientX: 132, clientY: 100 });

    nowMs = 252 + intervalMs;
    harness.emit("pointermove", { clientX: 164, clientY: 100 });

    expect(harness.transport.send).toHaveBeenCalledTimes(2);
  });

  it("samples visible remote cursor count at most once per 250ms window", () => {
    const getActiveVisibleRemoteCursorCount = vi
      .fn()
      .mockReturnValueOnce(8)
      .mockReturnValueOnce(0);
    const harness = createHarness({ getActiveVisibleRemoteCursorCount });

    nowMs = 260;
    harness.emit("pointermove", { clientX: 120, clientY: 120 });

    nowMs = 350;
    harness.emit("pointermove", { clientX: 152, clientY: 120 });

    nowMs = 520;
    harness.emit("pointermove", { clientX: 184, clientY: 120 });

    expect(getActiveVisibleRemoteCursorCount).toHaveBeenCalledTimes(2);
    expect(harness.transport.send).toHaveBeenCalledTimes(2);
  });

  it("sends heartbeat cursor update at 2s even when board position is unchanged", () => {
    const harness = createHarness();

    nowMs = 300;
    harness.emit("pointermove", { clientX: 200, clientY: 200 });

    nowMs = 600;
    harness.emit("pointermove", { clientX: 200, clientY: 200 });

    nowMs = 2_301;
    harness.emit("pointermove", { clientX: 200, clientY: 200 });

    expect(harness.transport.send).toHaveBeenCalledTimes(2);
  });

  it("does not send unchanged cursor updates when heartbeat is not due", () => {
    const harness = createHarness();

    nowMs = 300;
    harness.emit("pointermove", { clientX: 300, clientY: 300 });

    nowMs = 1_900;
    harness.emit("pointermove", { clientX: 300, clientY: 300 });

    expect(harness.transport.send).toHaveBeenCalledTimes(1);
  });
});
