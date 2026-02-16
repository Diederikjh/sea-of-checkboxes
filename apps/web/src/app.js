import {
  Application,
  Graphics,
} from "pixi.js";
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
import { renderScene } from "./renderer";
import { smoothCursors } from "./cursorSmoothing";
import { createServerMessageHandler } from "./serverMessages";
import { reconcileSubscriptions } from "./subscriptions";
import { TileStore } from "./tileStore";
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

function summarizeMessage(message) {
  switch (message.t) {
    case "sub":
    case "unsub":
      return { t: message.t, tiles: message.tiles.length };
    case "setCell":
      return { t: message.t, tile: message.tile, i: message.i, v: message.v };
    case "resyncTile":
      return { t: message.t, tile: message.tile, haveVer: message.haveVer };
    case "cur":
      return { t: message.t, x: Number(message.x.toFixed(2)), y: Number(message.y.toFixed(2)) };
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
        t: message.t,
        uid: message.uid,
        name: message.name,
        x: Number(message.x.toFixed(2)),
        y: Number(message.y.toFixed(2)),
      };
    case "err":
      return { t: message.t, code: message.code };
    default:
      return { t: message.t };
  }
}

export async function startApp() {
  const {
    canvas,
    identityEl,
    statusEl,
    zoomEl,
    titleEl,
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
  const wireTransport = createWireTransport();
  const transport = {
    connect(onServerMessage) {
      wireTransport.connect((payload) => {
        const payloadInfo = describePayload(payload);
        const message = decodeServerMessageBinary(payload);
        logger.protocol("rx", {
          ...payloadInfo,
          ...summarizeMessage(message),
        });
        onServerMessage(message);
      });
    },
    send(message) {
      const payload = encodeClientMessageBinary(message);
      logger.protocol("tx", {
        ...describePayload(payload),
        ...summarizeMessage(message),
      });
      wireTransport.send(payload);
    },
    dispose() {
      wireTransport.dispose();
    },
  };
  const cursors = new Map();
  const selfIdentity = { uid: null };

  let subscribedTiles = new Set();
  let visibleTiles = [];
  let needsSubscriptionRefresh = true;

  const setStatus = (value) => {
    statusEl.textContent = value;
  };

  const markViewportDirty = () => {
    needsSubscriptionRefresh = true;
  };

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
    onViewportChanged: markViewportDirty,
  });

  const onResize = () => {
    needsSubscriptionRefresh = true;
  };
  window.addEventListener("resize", onResize);

  function syncSubscriptions() {
    const updated = reconcileSubscriptions({
      camera,
      viewportWidth: app.renderer.width,
      viewportHeight: app.renderer.height,
      subscribedTiles,
      transport,
      marginTiles: 1,
    });

    visibleTiles = updated.visibleTiles;
    subscribedTiles = updated.subscribedTiles;
    needsSubscriptionRefresh = false;
  }

  app.ticker.add((ticker) => {
    const dtSeconds = ticker.deltaMS / 1_000;
    heatStore.decay(dtSeconds);
    smoothCursors(cursors, dtSeconds);

    if (needsSubscriptionRefresh) {
      syncSubscriptions();
    }

    const activeCursors = renderScene({
      graphics,
      camera,
      viewportWidth: app.renderer.width,
      viewportHeight: app.renderer.height,
      visibleTiles,
      tileStore,
      heatStore,
      cursors,
    });

    cursorLabels.update(
      activeCursors,
      camera,
      app.renderer.width,
      app.renderer.height
    );

    setStatus(`Tiles loaded: ${subscribedTiles.size}`);
  });

  syncSubscriptions();

  return () => {
    window.removeEventListener("resize", onResize);
    teardownInputHandlers();
    cursorLabels.destroy();
    transport.dispose();
    app.destroy(true);
  };
}
