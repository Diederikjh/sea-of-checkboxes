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
import { readStoredIdentity, writeStoredIdentity } from "./identityStore";
import { logger } from "./logger";
import { PERF_COUNTER, PERF_TIMING } from "./perfMetricKeys";
import { createPerfProbe, isPerfProbeEnabled } from "./perfProbe";
import { createEnvironmentObservers } from "./environmentObservers";
import { createServerMessageHandler } from "./serverMessages";
import { createSetCellOutboxSync } from "./setCellOutboxSync";
import { createRecoveryRuntime } from "./recoveryRuntime";
import { createRenderLoop } from "./renderLoop";
import { TileStore } from "./tileStore";
import { describePayload, summarizeMessage } from "./protocolTelemetry";
import { createTransportRuntime } from "./transportRuntime";
import { resolveApiBaseUrl } from "./transportConfig";
import { createUiRuntime } from "./uiRuntime";
import { createWireTransport } from "./wireTransport";
import { CURSOR_TTL_MS } from "./cursorRenderConfig";
import {
  cursorWorldPosition,
  isScreenPointInViewport,
  worldToScreenPoint,
} from "./cursorGeometry";

const CURSOR_VIEWPORT_MARGIN_PX = 24;

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
  const setCellOutboxSync = createSetCellOutboxSync({
    offlineBannerEl,
    sendToWireTransport: (message) => {
      transport.send(message, { trackSetCell: false });
    },
    isTransportOnline: () => transport.isOnline(),
    setTimeoutFn: window.setTimeout.bind(window),
    clearTimeoutFn: window.clearTimeout.bind(window),
  });
  const transport = createTransportRuntime({
    wireTransport,
    perfProbe,
    perfCounter: PERF_COUNTER,
    perfTiming: PERF_TIMING,
    encodeClientMessage: encodeClientMessageBinary,
    decodeServerMessage: decodeServerMessageBinary,
    protocolLogsEnabled,
    logger,
    describePayload,
    summarizeMessage,
    setCellOutboxSync,
  });
  const cursors = new Map();
  const selfIdentity = { uid: null };
  const getActiveVisibleRemoteCursorCount = () => {
    const nowMs = Date.now();
    const viewportWidth = app.renderer.width;
    const viewportHeight = app.renderer.height;
    let count = 0;

    for (const cursor of cursors.values()) {
      if (nowMs - cursor.seenAt >= CURSOR_TTL_MS) {
        continue;
      }

      const world = cursorWorldPosition(cursor);
      const screen = worldToScreenPoint(world.x, world.y, camera, viewportWidth, viewportHeight);
      if (!isScreenPointInViewport(
        screen.x,
        screen.y,
        viewportWidth,
        viewportHeight,
        CURSOR_VIEWPORT_MARGIN_PX
      )) {
        continue;
      }

      count += 1;
    }

    return count;
  };

  const uiRuntime = createUiRuntime({
    statusEl,
    interactionOverlayEl,
    interactionOverlayTextEl,
    setTimeoutFn: window.setTimeout.bind(window),
    clearTimeoutFn: window.clearTimeout.bind(window),
  });
  const { setStatus } = uiRuntime;

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

  const recoveryRuntime = createRecoveryRuntime({
    transport,
    setCellOutboxSync,
    renderLoop,
    setStatus,
  });

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
      setInteractionRestriction: uiRuntime.setInteractionRestriction,
      onIdentityReceived: ({ uid, name, token }) => {
        writeStoredIdentity({ uid, name, token });
      },
      getPendingSetCellOpsForTile: recoveryRuntime.getPendingSetCellOpsForTile,
      dropPendingSetCellOpsForTile: recoveryRuntime.dropPendingSetCellOpsForTile,
    }),
    recoveryRuntime.lifecycleHandlers
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
    getActiveVisibleRemoteCursorCount,
  });

  const isDocumentVisible = () =>
    typeof document === "undefined" || document.visibilityState === "visible";
  const logOther = (...args) => {
    if (typeof logger.other === "function") {
      logger.other(...args);
    }
  };
  const forceSubscriptionRebuild = (reason) => {
    renderLoop.forceSubscriptionRebuild();
    logOther("ws subscription_rebuild", {
      reason,
      transportOnline: transport.isOnline(),
      visibilityState:
        typeof document !== "undefined" && typeof document.visibilityState === "string"
          ? document.visibilityState
          : undefined,
    });
  };
  const onWindowFocus = () => {
    if (!isDocumentVisible()) {
      return;
    }
    forceSubscriptionRebuild("focus");
  };
  const onPageShow = () => {
    if (!isDocumentVisible()) {
      return;
    }
    forceSubscriptionRebuild("pageshow");
  };
  const onDocumentVisibilityChange = () => {
    if (!isDocumentVisible()) {
      return;
    }
    forceSubscriptionRebuild("visibilitychange");
  };
  const onBrowserOffline = () => {
    recoveryRuntime.onBrowserOffline();
  };
  const onBrowserOnline = () => {
    recoveryRuntime.onBrowserOnline();
  };
  const environmentObservers = createEnvironmentObservers({
    windowObj: window,
    documentObj: typeof document === "undefined" ? undefined : document,
    onResize: () => renderLoop.handleResize(),
    onFocus: onWindowFocus,
    onPageShow,
    onOffline: onBrowserOffline,
    onOnline: onBrowserOnline,
    onVisibilityChange: onDocumentVisibilityChange,
  });

  return () => {
    environmentObservers.dispose();
    if (perfProbe.enabled) {
      canvas.removeEventListener("webglcontextlost", onWebGlContextLost);
      canvas.removeEventListener("webglcontextrestored", onWebGlContextRestored);
    }
    teardownInputHandlers();
    cursorLabels.destroy();
    renderLoop.dispose();
    transport.dispose();
    uiRuntime.dispose();
    setCellOutboxSync.dispose();
    app.destroy(true);
  };
}
