import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requiredElements: null,
  inboundMessageHandler: null,
  transportLifecycleHandlers: null,
  outboundMessages: [],
  inputHandlerArgs: null,
  teardownInputHandlers: vi.fn(),
  windowAddEventListener: vi.fn(),
  windowRemoveEventListener: vi.fn(),
  markTransportReconnected: vi.fn(),
}));

vi.mock("pixi.js", () => ({
  Application: class MockApplication {
    constructor() {
      this.stage = {
        addChild() {},
      };
      this.renderer = {
        width: 800,
        height: 600,
      };
      this.ticker = {
        add() {},
        remove() {},
      };
    }

    destroy() {}
  },
  Graphics: class MockGraphics {},
}));

vi.mock("@sea/protocol", () => ({
  decodeServerMessageBinary: (payload) => payload,
  encodeClientMessageBinary: (message) => message,
}));

vi.mock("../src/dom", () => ({
  getRequiredElements: () => {
    if (!mocks.requiredElements) {
      throw new Error("Missing required test elements");
    }
    return mocks.requiredElements;
  },
  applyBranding() {},
  updateZoomReadout() {},
}));

vi.mock("../src/camera", () => ({
  createCamera: () => ({ x: 0, y: 0, cellPixelSize: 16 }),
}));

vi.mock("../src/cursorLabels", () => ({
  createCursorLabels: () => ({
    destroy() {},
  }),
}));

vi.mock("../src/heatmap", () => ({
  HeatStore: class MockHeatStore {
    ensureTile() {}
    bump() {}
  },
}));

vi.mock("../src/inputHandlers", () => ({
  setupInputHandlers: (args) => {
    mocks.inputHandlerArgs = args;
    return mocks.teardownInputHandlers;
  },
}));

vi.mock("../src/logger", () => ({
  logger: {
    categories: { PROTOCOL: "protocol" },
    isEnabled: () => false,
    protocol() {},
  },
}));

vi.mock("../src/perfMetricKeys", () => ({
  PERF_COUNTER: {
    WS_RX_COUNT: "ws_rx_count",
    WS_RX_BYTES: "ws_rx_bytes",
    WS_TX_COUNT: "ws_tx_count",
    WS_TX_BYTES: "ws_tx_bytes",
    WEBGL_CONTEXT_LOST: "webgl_context_lost",
    WEBGL_CONTEXT_RESTORED: "webgl_context_restored",
  },
  PERF_TIMING: {
    PROTOCOL_DECODE_MS: "protocol_decode_ms",
    PROTOCOL_ENCODE_MS: "protocol_encode_ms",
  },
}));

vi.mock("../src/perfProbe", () => ({
  isPerfProbeEnabled: () => false,
  createPerfProbe: () => ({
    enabled: false,
    increment() {},
    measure(_metric, fn) {
      return fn();
    },
  }),
}));

vi.mock("../src/renderLoop", () => ({
  createRenderLoop: () => ({
    markVisualDirty: vi.fn(),
    markTileCellsDirty: vi.fn(),
    markTransportReconnected: mocks.markTransportReconnected,
    handleResize: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock("../src/tileStore", () => ({
  TileStore: class MockTileStore {
    setSnapshot() {}
    applySingle() {
      return { gap: false, haveVer: 0 };
    }
    applyBatch() {
      return { gap: false, haveVer: 0 };
    }
  },
}));

vi.mock("../src/transportConfig", () => ({
  resolveApiBaseUrl: () => "http://worker.local",
}));

vi.mock("../src/wireTransport", () => ({
  createWireTransport: () => ({
    connect(handler, lifecycleHandlers) {
      mocks.inboundMessageHandler = handler;
      mocks.transportLifecycleHandlers = lifecycleHandlers ?? {};
    },
    send(message) {
      mocks.outboundMessages.push(message);
    },
    dispose() {},
  }),
}));

import { startApp } from "../src/app";

function createRequiredElements() {
  return {
    canvas: {
      addEventListener() {},
      removeEventListener() {},
      style: {},
    },
    identityEl: { textContent: "" },
    statusEl: { textContent: "" },
    zoomEl: { textContent: "" },
    titleEl: { textContent: "" },
    interactionOverlayEl: {
      dataset: {},
      hidden: true,
    },
    interactionOverlayTextEl: { textContent: "" },
    inspectToggleEl: {},
    inspectLabelEl: { textContent: "" },
    editInfoPopupEl: {},
    offlineBannerEl: { hidden: true, textContent: "" },
  };
}

describe("app interaction overlays", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.requiredElements = createRequiredElements();
    mocks.inboundMessageHandler = null;
    mocks.transportLifecycleHandlers = null;
    mocks.outboundMessages.length = 0;
    mocks.inputHandlerArgs = null;
    mocks.markTransportReconnected.mockReset();

    globalThis.window = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      addEventListener: mocks.windowAddEventListener,
      removeEventListener: mocks.windowRemoveEventListener,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.window = originalWindow;
  });

  it("shows deny and readonly overlays for matching server errors and auto-hides", async () => {
    const teardown = await startApp();
    const receiveServerPayload = mocks.inboundMessageHandler;
    if (!receiveServerPayload) {
      throw new Error("Expected transport to register a server message handler");
    }

    const { interactionOverlayEl, interactionOverlayTextEl, statusEl } = mocks.requiredElements;
    expect(interactionOverlayEl.hidden).toBe(true);

    receiveServerPayload({
      t: "err",
      code: "tile_sub_denied",
      msg: "Tile is oversubscribed; new subscriptions are temporarily denied",
    });

    expect(interactionOverlayEl.hidden).toBe(false);
    expect(interactionOverlayEl.dataset.state).toBe("deny");
    expect(interactionOverlayTextEl.textContent).toBe("Tile is over capacity; access denied for now");
    expect(statusEl.textContent).toBe("Error: Tile is oversubscribed; new subscriptions are temporarily denied");

    receiveServerPayload({
      t: "err",
      code: "setcell_rejected",
      msg: "tile_readonly_hot",
    });

    expect(interactionOverlayEl.hidden).toBe(false);
    expect(interactionOverlayEl.dataset.state).toBe("readonly");
    expect(interactionOverlayTextEl.textContent).toBe("Hot tile is read-only right now");
    expect(statusEl.textContent).toBe("Error: tile_readonly_hot");

    vi.advanceTimersByTime(2999);
    expect(interactionOverlayEl.hidden).toBe(false);

    vi.advanceTimersByTime(1);
    expect(interactionOverlayEl.hidden).toBe(true);
    expect(interactionOverlayEl.dataset.state).toBeUndefined();
    expect(interactionOverlayTextEl.textContent).toBe("");

    teardown();
    expect(mocks.windowRemoveEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("shows offline banner with unsynced count after 30s disconnected and hides on reconnect", async () => {
    const teardown = await startApp();
    const lifecycle = mocks.transportLifecycleHandlers;
    const inputArgs = mocks.inputHandlerArgs;
    if (!lifecycle) {
      throw new Error("Expected transport lifecycle handlers");
    }
    if (!inputArgs) {
      throw new Error("Expected input handler args");
    }

    const { offlineBannerEl } = mocks.requiredElements;
    expect(offlineBannerEl.hidden).toBe(true);

    lifecycle.onOpen?.({ reconnected: false });
    inputArgs.transport.send({ t: "setCell", tile: "0:0", i: 1, v: 1, op: "op_1" });
    inputArgs.transport.send({ t: "setCell", tile: "0:0", i: 2, v: 1, op: "op_2" });
    inputArgs.transport.send({ t: "setCell", tile: "0:0", i: 3, v: 1, op: "op_3" });
    inputArgs.transport.send({ t: "setCell", tile: "0:0", i: 4, v: 1, op: "op_4" });

    lifecycle.onClose?.({ disposed: false });
    vi.advanceTimersByTime(29_999);
    expect(offlineBannerEl.hidden).toBe(true);

    vi.advanceTimersByTime(1);
    expect(offlineBannerEl.hidden).toBe(false);
    expect(offlineBannerEl.textContent).toBe("You are offline. 4 unsynced events.");

    lifecycle.onOpen?.({ reconnected: true });
    expect(offlineBannerEl.hidden).toBe(true);
    expect(mocks.markTransportReconnected).toHaveBeenCalledTimes(1);

    teardown();
  });

  it("replays queued setCell intents after reconnect", async () => {
    const teardown = await startApp();
    const lifecycle = mocks.transportLifecycleHandlers;
    const inputArgs = mocks.inputHandlerArgs;
    if (!lifecycle || !inputArgs) {
      throw new Error("Expected transport lifecycle handlers and input handler args");
    }

    lifecycle.onOpen?.({ reconnected: false });
    inputArgs.transport.send({
      t: "setCell",
      tile: "0:0",
      i: 1,
      v: 1,
      op: "op_1",
    });

    expect(mocks.outboundMessages).toHaveLength(1);
    expect(mocks.outboundMessages[0]).toMatchObject({ t: "setCell", tile: "0:0", i: 1, v: 1 });

    lifecycle.onClose?.({ disposed: false });
    lifecycle.onOpen?.({ reconnected: true });

    vi.advanceTimersByTime(1_000);
    expect(mocks.outboundMessages).toHaveLength(2);
    expect(mocks.outboundMessages[1]).toMatchObject({ t: "setCell", tile: "0:0", i: 1, v: 1 });

    teardown();
  });
});
