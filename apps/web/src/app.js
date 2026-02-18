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
import { renderDirtyAreas, renderScene } from "./renderer";
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
  let needsRender = true;
  const dirtyTileCells = new Map();

  const setStatus = (value) => {
    statusEl.textContent = value;
  };

  const markViewportDirty = () => {
    needsSubscriptionRefresh = true;
    needsRender = true;
  };

  const markVisualDirty = () => {
    needsRender = true;
  };

  const markTileCellsDirty = (tileKey, changedIndices) => {
    const previous = dirtyTileCells.get(tileKey);

    if (!changedIndices) {
      dirtyTileCells.set(tileKey, null);
      return;
    }

    if (previous === null) {
      return;
    }

    const next = previous ?? new Set();
    for (const index of changedIndices) {
      next.add(index);
    }
    dirtyTileCells.set(tileKey, next);
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
      onVisualStateChanged: markVisualDirty,
      onTileCellsChanged: markTileCellsDirty,
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
    needsRender = true;
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
    const hasAnimatedHeat = heatStore.decay(dtSeconds);
    const hasCursorMotion = smoothCursors(cursors, dtSeconds);
    const now = Date.now();
    const hasRecentCursor = cursors.size > 0
      ? [...cursors.values()].some((cursor) => now - cursor.seenAt < 5_000)
      : false;

    if (needsSubscriptionRefresh) {
      syncSubscriptions();
      needsRender = true;
    }

    const canPatchDirtyAreas = !needsRender
      && !hasAnimatedHeat
      && !hasCursorMotion
      && !hasRecentCursor
      && dirtyTileCells.size > 0;

    if (canPatchDirtyAreas) {
      renderDirtyAreas({
        graphics,
        camera,
        viewportWidth: app.renderer.width,
        viewportHeight: app.renderer.height,
        visibleTiles,
        dirtyTileCells,
        tileStore,
        heatStore,
      });
      dirtyTileCells.clear();
      return;
    }

    if (!needsRender && !hasAnimatedHeat && !hasCursorMotion && !hasRecentCursor) {
      return;
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
    dirtyTileCells.clear();
    needsRender = false;
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
