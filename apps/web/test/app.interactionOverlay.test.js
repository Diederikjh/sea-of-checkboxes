import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requiredElements: null,
  inboundMessageHandler: null,
  transportLifecycleHandlers: null,
  outboundMessages: [],
  inputHandlerArgs: null,
  rebuildMessages: [],
  teardownInputHandlers: vi.fn(),
  windowAddEventListener: vi.fn(),
  windowRemoveEventListener: vi.fn(),
  documentAddEventListener: vi.fn(),
  documentRemoveEventListener: vi.fn(),
  forceSubscriptionRebuild: vi.fn(),
  markTransportReconnected: vi.fn(),
  rebuildCounter: 0,
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
  createRenderLoop: (args) => ({
    markVisualDirty: vi.fn(),
    markTileCellsDirty: vi.fn(),
    markTransportReconnected: vi.fn((reason = "transport_reconnect") => {
      mocks.markTransportReconnected(reason);
      mocks.rebuildCounter += 1;
      const message = { t: "sub", cid: `c_rebuild_${mocks.rebuildCounter}`, tiles: ["0:0"] };
      mocks.rebuildMessages.push(message);
      args.onSubscriptionRebuildSubSent?.(message, reason);
    }),
    forceSubscriptionRebuild: vi.fn((reason = "subscription_rebuild") => {
      mocks.forceSubscriptionRebuild(reason);
      mocks.rebuildCounter += 1;
      const message = { t: "sub", cid: `c_rebuild_${mocks.rebuildCounter}`, tiles: ["0:0"] };
      mocks.rebuildMessages.push(message);
      args.onSubscriptionRebuildSubSent?.(message, reason);
    }),
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
import { CURSOR_TTL_MS } from "../src/cursorRenderConfig";

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
  const originalDocument = globalThis.document;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.requiredElements = createRequiredElements();
    mocks.inboundMessageHandler = null;
    mocks.transportLifecycleHandlers = null;
    mocks.outboundMessages.length = 0;
    mocks.inputHandlerArgs = null;
    mocks.rebuildMessages.length = 0;
    mocks.rebuildCounter = 0;
    mocks.markTransportReconnected.mockReset();
    mocks.forceSubscriptionRebuild.mockReset();
    mocks.windowAddEventListener.mockClear();
    mocks.windowRemoveEventListener.mockClear();
    mocks.documentAddEventListener.mockClear();
    mocks.documentRemoveEventListener.mockClear();

    globalThis.window = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      addEventListener: mocks.windowAddEventListener,
      removeEventListener: mocks.windowRemoveEventListener,
    };
    globalThis.document = {
      visibilityState: "visible",
      addEventListener: mocks.documentAddEventListener,
      removeEventListener: mocks.documentRemoveEventListener,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
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

  it("wires visible remote cursor counter into input handlers and filters self/offscreen/stale cursors", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const teardown = await startApp();
    const receiveServerPayload = mocks.inboundMessageHandler;
    const inputArgs = mocks.inputHandlerArgs;
    if (!receiveServerPayload || !inputArgs) {
      throw new Error("Expected server message handler and input handler args");
    }

    expect(typeof inputArgs.getActiveVisibleRemoteCursorCount).toBe("function");

    receiveServerPayload({
      t: "hello",
      uid: "u_self",
      name: "Self",
      token: "token_self",
    });
    receiveServerPayload({
      t: "curUp",
      uid: "u_self",
      name: "Self",
      x: 1.5,
      y: 1.5,
    });
    receiveServerPayload({
      t: "curUp",
      uid: "u_visible",
      name: "Visible",
      x: 2.5,
      y: 2.5,
    });
    receiveServerPayload({
      t: "curUp",
      uid: "u_offscreen",
      name: "Offscreen",
      x: 100.5,
      y: 2.5,
    });

    expect(inputArgs.getActiveVisibleRemoteCursorCount()).toBe(1);

    vi.advanceTimersByTime(CURSOR_TTL_MS);
    expect(inputArgs.getActiveVisibleRemoteCursorCount()).toBe(0);

    teardown();
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

    expect(mocks.outboundMessages).toHaveLength(1);

    const rebuildMessage = mocks.rebuildMessages.at(-1);
    if (!rebuildMessage) {
      throw new Error("Expected reconnect rebuild message");
    }
    expect(inputArgs.getSetCellGuard()).toMatchObject({
      reason: "subscription_rebuild",
      trigger: "transport_reconnect",
      cid: rebuildMessage.cid,
    });

    mocks.inboundMessageHandler?.({
      t: "subAck",
      cid: rebuildMessage.cid,
      requestedCount: 1,
      changedCount: 1,
      subscribedCount: 1,
    });
    vi.advanceTimersByTime(0);
    expect(inputArgs.getSetCellGuard()).toBeNull();
    const setCellMessages = mocks.outboundMessages.filter((message) => message.t === "setCell");
    expect(setCellMessages).toHaveLength(2);
    expect(setCellMessages[1]).toMatchObject({ t: "setCell", tile: "0:0", i: 1, v: 1 });

    teardown();
  });

  it("keeps the rebuild guard active until the matching subAck arrives", async () => {
    const teardown = await startApp();
    const lifecycle = mocks.transportLifecycleHandlers;
    const inputArgs = mocks.inputHandlerArgs;
    if (!lifecycle || !inputArgs) {
      throw new Error("Expected transport lifecycle handlers and input handler args");
    }

    lifecycle.onOpen?.({ reconnected: true });

    const rebuildMessage = mocks.rebuildMessages.at(-1);
    if (!rebuildMessage) {
      throw new Error("Expected reconnect rebuild message");
    }

    expect(inputArgs.getSetCellGuard()).toMatchObject({
      reason: "subscription_rebuild",
      trigger: "transport_reconnect",
      cid: rebuildMessage.cid,
    });

    mocks.inboundMessageHandler?.({
      t: "subAck",
      cid: "c_other_rebuild",
      requestedCount: 1,
      changedCount: 1,
      subscribedCount: 1,
    });
    expect(inputArgs.getSetCellGuard()).toMatchObject({
      cid: rebuildMessage.cid,
    });

    mocks.inboundMessageHandler?.({
      t: "subAck",
      cid: rebuildMessage.cid,
      requestedCount: 1,
      changedCount: 1,
      subscribedCount: 1,
    });
    expect(inputArgs.getSetCellGuard()).toBeNull();

    teardown();
  });

  it("forces a subscription rebuild on focus/pageshow and visible lifecycle transitions", async () => {
    const teardown = await startApp();

    const focusHandler = mocks.windowAddEventListener.mock.calls.find(
      ([eventName]) => eventName === "focus"
    )?.[1];
    const pageShowHandler = mocks.windowAddEventListener.mock.calls.find(
      ([eventName]) => eventName === "pageshow"
    )?.[1];
    const visibilityHandler = mocks.documentAddEventListener.mock.calls.find(
      ([eventName]) => eventName === "visibilitychange"
    )?.[1];

    if (typeof focusHandler !== "function") {
      throw new Error("Expected focus event handler registration");
    }
    if (typeof pageShowHandler !== "function") {
      throw new Error("Expected pageshow event handler registration");
    }
    if (typeof visibilityHandler !== "function") {
      throw new Error("Expected visibilitychange event handler registration");
    }

    globalThis.document.visibilityState = "hidden";
    focusHandler();
    pageShowHandler();
    globalThis.document.visibilityState = "visible";
    focusHandler();
    pageShowHandler();
    globalThis.document.visibilityState = "hidden";
    visibilityHandler();
    globalThis.document.visibilityState = "visible";
    visibilityHandler();

    expect(mocks.forceSubscriptionRebuild).toHaveBeenCalledTimes(3);

    teardown();
    expect(mocks.documentRemoveEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function)
    );
  });

  it("shows offline banner from browser offline event even before websocket close", async () => {
    const teardown = await startApp();
    const { offlineBannerEl } = mocks.requiredElements;

    const offlineHandler = mocks.windowAddEventListener.mock.calls.find(
      ([eventName]) => eventName === "offline"
    )?.[1];
    if (typeof offlineHandler !== "function") {
      throw new Error("Expected offline event handler registration");
    }

    offlineHandler();
    vi.advanceTimersByTime(29_999);
    expect(offlineBannerEl.hidden).toBe(true);

    vi.advanceTimersByTime(1);
    expect(offlineBannerEl.hidden).toBe(false);

    teardown();
  });
});
