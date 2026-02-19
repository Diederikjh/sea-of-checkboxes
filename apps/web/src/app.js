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

  const wireTransport = createWireTransport();
  const transport = {
    connect(onServerMessage) {
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
        onServerMessage(message);
      });
    },
    send(message) {
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
    })
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
    app.destroy(true);
  };
}
