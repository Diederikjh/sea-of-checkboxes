import {
  Application,
  Graphics,
} from "pixi.js";
import {
  parseTileKeyStrict,
  worldFromTileCell,
} from "@sea/domain";
import {
  decodeServerMessageBinary,
  encodeClientMessageBinary,
} from "@sea/protocol";

import { createCamera } from "./camera";
import { createCursorLabels } from "./cursorLabels";
import { applyBranding, getRequiredElements, updateZoomReadout } from "./dom";
import { HeatStore } from "./heatmap";
import { setupInputHandlers } from "./inputHandlers";
import { readStoredIdentity, writeStoredIdentity } from "./identityStore";
import { logger } from "./logger";
import { PERF_COUNTER, PERF_TIMING } from "./perfMetricKeys";
import { createPerfProbe, isPerfProbeEnabled } from "./perfProbe";
import { createServerMessageHandler } from "./serverMessages";
import { createRenderLoop } from "./renderLoop";
import { TileStore } from "./tileStore";
import { resolveApiBaseUrl } from "./transportConfig";
import { createWireTransport } from "./wireTransport";

function formatByteCount(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function payloadHeadHex(payload, maxBytes = 8) {
  const head = Array.from(payload.slice(0, maxBytes));
  return head.map((value) => value.toString(16).padStart(2, "0")).join(" ");
}

function describePayload(payload) {
  return {
    bytes: payload.length,
    size: formatByteCount(payload.length),
    tag: payload[0] ?? null,
    headHex: payloadHeadHex(payload),
  };
}

function round2(value) {
  return Number(value.toFixed(2));
}

const OFFLINE_BANNER_DELAY_MS = 30_000;
const SETCELL_OUTBOX_MAX_ENTRIES = 100;
const SETCELL_OUTBOX_TTL_MS = 90_000;
const SETCELL_REPLAY_BATCH_SIZE = 2;
const SETCELL_REPLAY_INTERVAL_MS = 500;
const SETCELL_MAX_REPLAY_ATTEMPTS = 6;

function offlineBannerMessage(unsyncedCount) {
  if (unsyncedCount <= 0) {
    return "You are offline. 0 unsynced events.";
  }
  return `You are offline. ${unsyncedCount} unsynced event${unsyncedCount === 1 ? "" : "s"}.`;
}

function summarizeCursor(message) {
  const x = round2(message.x);
  const y = round2(message.y);
  return {
    t: message.t,
    x,
    y,
    boardX: x,
    boardY: y,
  };
}

function summarizeMessage(message) {
  switch (message.t) {
    case "sub":
    case "unsub":
      return { t: message.t, tiles: message.tiles.length };
    case "setCell":
      return {
        t: message.t,
        tile: message.tile,
        i: message.i,
        v: message.v,
        ...deriveBoardCoordFromSetCell(message.tile, message.i),
      };
    case "resyncTile":
      return { t: message.t, tile: message.tile, haveVer: message.haveVer };
    case "cur":
      return summarizeCursor(message);
    case "hello":
      return { t: message.t, uid: message.uid, name: message.name };
    case "tileSnap":
      return { t: message.t, tile: message.tile, ver: message.ver };
    case "cellUp":
      return { t: message.t, tile: message.tile, i: message.i, v: message.v, ver: message.ver };
    case "cellUpBatch":
      return {
        t: message.t,
        tile: message.tile,
        fromVer: message.fromVer,
        toVer: message.toVer,
        ops: message.ops.length,
      };
    case "curUp":
      return {
        uid: message.uid,
        name: message.name,
        ...summarizeCursor(message),
      };
    case "err":
      return { t: message.t, code: message.code };
    default:
      return { t: message.t };
  }
}

function deriveBoardCoordFromSetCell(tileKey, index) {
  const tile = parseTileKeyStrict(tileKey);
  if (!tile) {
    return {};
  }

  try {
    const world = worldFromTileCell(tile.tx, tile.ty, index);
    return {
      worldX: world.x,
      worldY: world.y,
      boardX: Number((world.x + 0.5).toFixed(2)),
      boardY: Number((world.y + 0.5).toFixed(2)),
    };
  } catch {
    return {};
  }
}

export async function startApp() {
  const {
    canvas,
    identityEl,
    statusEl,
    zoomEl,
    titleEl,
    interactionOverlayEl,
    interactionOverlayTextEl,
    offlineBannerEl,
    inspectToggleEl,
    inspectLabelEl,
    editInfoPopupEl,
  } = getRequiredElements();

  applyBranding(titleEl);

  const app = new Application({
    view: canvas,
    resizeTo: window,
    antialias: false,
    backgroundAlpha: 0,
    autoDensity: true,
  });

  const graphics = new Graphics();
  app.stage.addChild(graphics);

  const cursorLabels = createCursorLabels(app.stage);
  const camera = createCamera();
  const tileStore = new TileStore(512);
  const heatStore = new HeatStore();
  const apiBaseUrl = resolveApiBaseUrl();
  const perfProbe = createPerfProbe({
    enabled: isPerfProbeEnabled(),
  });
  const protocolLogsEnabled = logger.isEnabled(logger.categories.PROTOCOL);
  const onWebGlContextLost = (event) => {
    perfProbe.increment(PERF_COUNTER.WEBGL_CONTEXT_LOST);
    event.preventDefault();
  };
  const onWebGlContextRestored = () => {
    perfProbe.increment(PERF_COUNTER.WEBGL_CONTEXT_RESTORED);
  };
  if (perfProbe.enabled) {
    canvas.addEventListener("webglcontextlost", onWebGlContextLost, { passive: false });
    canvas.addEventListener("webglcontextrestored", onWebGlContextRestored);
  }

  const wireTransport = createWireTransport({
    identityProvider: readStoredIdentity,
  });
  let transportOnline = false;
  let offlineBannerTimerId = null;
  let outboxReplayTimerId = null;
  const setCellOutbox = new Map();
  const refreshOfflineBannerText = () => {
    offlineBannerEl.textContent = offlineBannerMessage(setCellOutbox.size);
  };

  const outboxKeyForSetCell = (tile, index) => `${tile}:${index}`;
  const clearOutboxReplayTimer = () => {
    if (outboxReplayTimerId === null) {
      return;
    }
    window.clearTimeout(outboxReplayTimerId);
    outboxReplayTimerId = null;
  };
  const clearOfflineBannerTimer = () => {
    if (offlineBannerTimerId === null) {
      return;
    }
    window.clearTimeout(offlineBannerTimerId);
    offlineBannerTimerId = null;
  };
  const hideOfflineBanner = () => {
    clearOfflineBannerTimer();
    offlineBannerEl.hidden = true;
  };
  const scheduleOfflineBanner = () => {
    clearOfflineBannerTimer();
    offlineBannerTimerId = window.setTimeout(() => {
      offlineBannerTimerId = null;
      if (!transportOnline) {
        refreshOfflineBannerText();
        offlineBannerEl.hidden = false;
      }
    }, OFFLINE_BANNER_DELAY_MS);
  };

  const pruneSetCellOutbox = (nowMs) => {
    let changed = false;
    for (const [key, entry] of setCellOutbox.entries()) {
      const staleByAge = nowMs - entry.updatedAtMs > SETCELL_OUTBOX_TTL_MS;
      const staleByAttempts = entry.replayAttempts >= SETCELL_MAX_REPLAY_ATTEMPTS;
      if (staleByAge || staleByAttempts) {
        setCellOutbox.delete(key);
        changed = true;
      }
    }
    if (changed && !offlineBannerEl.hidden) {
      refreshOfflineBannerText();
    }
  };

  const recordSetCellOutboxEntry = (message) => {
    const nowMs = Date.now();
    pruneSetCellOutbox(nowMs);
    const key = outboxKeyForSetCell(message.tile, message.i);
    const existing = setCellOutbox.get(key);
    setCellOutbox.set(key, {
      message: { ...message },
      updatedAtMs: nowMs,
      replayAttempts: existing?.replayAttempts ?? 0,
    });

    if (setCellOutbox.size > SETCELL_OUTBOX_MAX_ENTRIES) {
      let oldestKey = null;
      let oldestUpdatedAt = Number.POSITIVE_INFINITY;
      for (const [entryKey, entry] of setCellOutbox.entries()) {
        if (entry.updatedAtMs < oldestUpdatedAt) {
          oldestUpdatedAt = entry.updatedAtMs;
          oldestKey = entryKey;
        }
      }
      if (oldestKey !== null) {
        setCellOutbox.delete(oldestKey);
      }
    }

    if (!offlineBannerEl.hidden) {
      refreshOfflineBannerText();
    }
  };

  const clearSetCellOutboxFromServerMessage = (message) => {
    if (message.t === "cellUp") {
      const key = outboxKeyForSetCell(message.tile, message.i);
      const entry = setCellOutbox.get(key);
      if (entry?.message.v === message.v) {
        setCellOutbox.delete(key);
        if (!offlineBannerEl.hidden) {
          refreshOfflineBannerText();
        }
      }
      return;
    }

    if (message.t !== "cellUpBatch") {
      return;
    }

    for (const [index, value] of message.ops) {
      const key = outboxKeyForSetCell(message.tile, index);
      const entry = setCellOutbox.get(key);
      if (entry?.message.v === value) {
        setCellOutbox.delete(key);
        if (!offlineBannerEl.hidden) {
          refreshOfflineBannerText();
        }
      }
    }
  };

  const sendToWireTransport = (message) => {
    const payload = perfProbe.measure(PERF_TIMING.PROTOCOL_ENCODE_MS, () =>
      encodeClientMessageBinary(message)
    );
    perfProbe.increment(PERF_COUNTER.WS_TX_COUNT);
    perfProbe.increment(PERF_COUNTER.WS_TX_BYTES, payload.length);
    if (protocolLogsEnabled) {
      logger.protocol("tx", {
        ...describePayload(payload),
        ...summarizeMessage(message),
      });
    }
    wireTransport.send(payload);
  };

  const replaySetCellOutbox = () => {
    outboxReplayTimerId = null;
    if (!transportOnline) {
      return;
    }

    const nowMs = Date.now();
    pruneSetCellOutbox(nowMs);
    if (setCellOutbox.size === 0) {
      return;
    }

    const pending = Array.from(setCellOutbox.entries())
      .sort(([, left], [, right]) => left.updatedAtMs - right.updatedAtMs)
      .slice(0, SETCELL_REPLAY_BATCH_SIZE);

    for (const [key, entry] of pending) {
      if (entry.replayAttempts >= SETCELL_MAX_REPLAY_ATTEMPTS) {
        setCellOutbox.delete(key);
        continue;
      }
      entry.replayAttempts += 1;
      sendToWireTransport(entry.message);
    }

    if (setCellOutbox.size > 0) {
      outboxReplayTimerId = window.setTimeout(replaySetCellOutbox, SETCELL_REPLAY_INTERVAL_MS);
    }
  };

  const scheduleSetCellOutboxReplay = (delayMs) => {
    if (!transportOnline || setCellOutbox.size === 0 || outboxReplayTimerId !== null) {
      return;
    }
    outboxReplayTimerId = window.setTimeout(replaySetCellOutbox, delayMs);
  };

  const sendMessage = (message, options = {}) => {
    const trackSetCell = options.trackSetCell ?? true;
    if (message.t === "cur" && !transportOnline) {
      return;
    }
    if (trackSetCell && message.t === "setCell") {
      recordSetCellOutboxEntry(message);
    }
    sendToWireTransport(message);
  };

  const transport = {
    connect(onServerMessage, lifecycleHandlers) {
      const onOpen =
        typeof lifecycleHandlers?.onOpen === "function" ? lifecycleHandlers.onOpen : () => {};
      const onClose =
        typeof lifecycleHandlers?.onClose === "function" ? lifecycleHandlers.onClose : () => {};

      wireTransport.connect((payload) => {
        perfProbe.increment(PERF_COUNTER.WS_RX_COUNT);
        perfProbe.increment(PERF_COUNTER.WS_RX_BYTES, payload.length);
        const message = perfProbe.measure(PERF_TIMING.PROTOCOL_DECODE_MS, () =>
          decodeServerMessageBinary(payload)
        );
        if (protocolLogsEnabled) {
          const payloadInfo = describePayload(payload);
          logger.protocol("rx", {
            ...payloadInfo,
            ...summarizeMessage(message),
          });
        }
        clearSetCellOutboxFromServerMessage(message);
        onServerMessage(message);
      }, {
        onOpen(info) {
          transportOnline = true;
          hideOfflineBanner();
          clearOutboxReplayTimer();
          onOpen(info);
        },
        onClose(info) {
          transportOnline = false;
          clearOutboxReplayTimer();
          onClose(info);
        },
      });
    },
    send(message) {
      sendMessage(message);
    },
    dispose() {
      wireTransport.dispose();
    },
  };
  const cursors = new Map();
  const selfIdentity = { uid: null };

  const setStatus = (value) => {
    statusEl.textContent = value;
  };

  let interactionTimerId = null;
  const clearInteractionTimer = () => {
    if (interactionTimerId !== null) {
      window.clearTimeout(interactionTimerId);
      interactionTimerId = null;
    }
  };

  const setInteractionRestriction = (state, message) => {
    interactionOverlayEl.dataset.state = state;
    interactionOverlayTextEl.textContent = message;
    interactionOverlayEl.hidden = false;

    clearInteractionTimer();
    interactionTimerId = window.setTimeout(() => {
      interactionOverlayEl.hidden = true;
      delete interactionOverlayEl.dataset.state;
      interactionOverlayTextEl.textContent = "";
      interactionTimerId = null;
    }, 3000);
  };

  const renderLoop = createRenderLoop({
    app,
    graphics,
    camera,
    tileStore,
    heatStore,
    cursors,
    cursorLabels,
    transport,
    setStatus,
    perfProbe,
  });

  updateZoomReadout(camera, zoomEl);

  transport.connect(
    createServerMessageHandler({
      identityEl,
      setStatus,
      tileStore,
      heatStore,
      transport,
      cursors,
      selfIdentity,
      onVisualStateChanged: renderLoop.markVisualDirty,
      onTileCellsChanged: renderLoop.markTileCellsDirty,
      setInteractionRestriction,
      onIdentityReceived: ({ uid, name, token }) => {
        writeStoredIdentity({ uid, name, token });
      },
    }),
    {
      onOpen: ({ reconnected }) => {
        if (!reconnected) {
          return;
        }
        renderLoop.markTransportReconnected();
        setStatus("Connection restored; resyncing visible tiles...");
        scheduleSetCellOutboxReplay(1_000);
      },
      onClose: ({ disposed }) => {
        if (disposed) {
          return;
        }
        setStatus("Connection lost; retrying...");
        scheduleOfflineBanner();
      },
    }
  );

  const teardownInputHandlers = setupInputHandlers({
    canvas,
    camera,
    getViewportSize: () => ({
      width: app.renderer.width,
      height: app.renderer.height,
    }),
    zoomEl,
    transport,
    tileStore,
    heatStore,
    setStatus,
    inspectToggleEl,
    inspectLabelEl,
    editInfoPopupEl,
    apiBaseUrl,
    onViewportChanged: renderLoop.markViewportDirty,
    onTileCellsChanged: renderLoop.markTileCellsDirty,
  });

  const onResize = () => {
    renderLoop.handleResize();
  };
  window.addEventListener("resize", onResize);

  return () => {
    window.removeEventListener("resize", onResize);
    if (perfProbe.enabled) {
      canvas.removeEventListener("webglcontextlost", onWebGlContextLost);
      canvas.removeEventListener("webglcontextrestored", onWebGlContextRestored);
    }
    teardownInputHandlers();
    cursorLabels.destroy();
    renderLoop.dispose();
    transport.dispose();
    clearInteractionTimer();
    clearOutboxReplayTimer();
    hideOfflineBanner();
    app.destroy(true);
  };
}
