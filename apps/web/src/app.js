import {
  Application,
  Graphics,
} from "pixi.js";

import { createCamera } from "./camera";
import { createCursorLabels } from "./cursorLabels";
import { applyBranding, getRequiredElements, updateZoomReadout } from "./dom";
import { HeatStore } from "./heatmap";
import { setupInputHandlers } from "./inputHandlers";
import { createMockTransport } from "./mockTransport";
import { renderScene } from "./renderer";
import { smoothCursors } from "./cursorSmoothing";
import { createServerMessageHandler } from "./serverMessages";
import { reconcileSubscriptions } from "./subscriptions";
import { TileStore } from "./tileStore";

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
  const transport = createMockTransport();
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
