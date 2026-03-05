import {
  Application,
  Graphics,
} from "pixi.js";
import {
  clampCameraCenter,
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
import { bootstrapAuthSession } from "./auth/bootstrap";
import {
  signInWithGoogleSessionTransition,
  signOutToAnonymousSessionTransition,
} from "./auth/sessionSwitcher";
import {
  createFirebaseAuthIdentityProvider,
  resolveFirebaseConfigFromEnv,
} from "./auth/firebaseAuthProvider";
import { createAuthSessionExchangeClient } from "./auth/sessionExchangeClient";
import { HeatStore } from "./heatmap";
import { setupInputHandlers } from "./inputHandlers";
import {
  readStoredAnonymousIdentity,
  readStoredIdentity,
  writeStoredAnonymousIdentity,
  writeStoredIdentity,
} from "./identityStore";
import { logger } from "./logger";
import { PERF_COUNTER, PERF_TIMING } from "./perfMetricKeys";
import { createPerfProbe, isPerfProbeEnabled } from "./perfProbe";
import { createServerMessageHandler } from "./serverMessages";
import { createSetCellOutboxSync } from "./setCellOutboxSync";
import { createRenderLoop } from "./renderLoop";
import {
  createShareLink,
  readShareIdFromLocation,
  resolveSharedCamera,
} from "./shareLinks";
import { TileStore } from "./tileStore";
import { resolveApiBaseUrl } from "./transportConfig";
import { createWireTransport } from "./wireTransport";
import { CURSOR_TTL_MS } from "./cursorRenderConfig";
import {
  cursorWorldPosition,
  isScreenPointInViewport,
  worldToScreenPoint,
} from "./cursorGeometry";

const CURSOR_VIEWPORT_MARGIN_PX = 24;

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
        op: message.op,
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
        opsPreview: message.ops.slice(0, 4),
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
    authGoogleSignInButtonEl,
    authGoogleLogoutButtonEl,
    shareButtonEl,
  } = getRequiredElements();

  applyBranding(titleEl);
  const setStatus = (value) => {
    statusEl.textContent = value;
  };
  const logOther = (...args) => {
    if (typeof logger.other === "function") {
      logger.other(...args);
    }
  };

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
  const shareId = readShareIdFromLocation();
  const sharedCamera = shareId
    ? await resolveSharedCamera({
        apiBaseUrl,
        shareId,
      }).catch((error) => {
        logOther("share resolve_failed", {
          shareId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
    : null;
  if (sharedCamera) {
    camera.x = sharedCamera.x;
    camera.y = sharedCamera.y;
    camera.cellPixelSize = sharedCamera.cellPixelSize;
    setStatus("Loaded shared view.");
  } else if (shareId) {
    setStatus("Share link unavailable or expired; using default view.");
  }
  const env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
  const firebaseConfig = resolveFirebaseConfigFromEnv(env);
  const authSessionExchangeClient = firebaseConfig
    ? createAuthSessionExchangeClient({ apiBaseUrl })
    : null;
  const authIdentityProvider = firebaseConfig
    ? createFirebaseAuthIdentityProvider({ config: firebaseConfig })
    : null;
  let authPrincipal = null;

  if (authIdentityProvider && authSessionExchangeClient) {
    setStatus("Signing in...");
    try {
      const bootstrap = await bootstrapAuthSession({
        identityProvider: authIdentityProvider,
        sessionExchangeClient: authSessionExchangeClient,
        readStoredIdentity,
        writeStoredIdentity,
        allowLegacyFallback: true,
      });

      if (bootstrap.usedLegacyFallback) {
        setStatus("Auth unavailable; using existing session.");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logOther("auth bootstrap_failed", {
        error: errorMessage,
      });
      console.error("auth bootstrap_failed", { error: errorMessage });
      setStatus(`Sign-in failed; continuing with existing session. (${errorMessage})`);
    }

    try {
      authPrincipal = await authIdentityProvider.initAnonymousSession();
    } catch (error) {
      logOther("auth principal_resolve_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (authGoogleSignInButtonEl) {
    authGoogleSignInButtonEl.hidden =
      !authIdentityProvider ||
      !authSessionExchangeClient ||
      (authPrincipal ? authPrincipal.isAnonymous === false : true);
  }
  if (authGoogleLogoutButtonEl) {
    authGoogleLogoutButtonEl.hidden =
      !authIdentityProvider ||
      !authSessionExchangeClient ||
      (authPrincipal ? authPrincipal.isAnonymous === true : true);
  }
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
    env,
    identityProvider: readStoredIdentity,
  });
  let transportOnline = false;
  let wsSessionId = 0;
  let wsSessionOpenedAtMs = null;
  let wsFirstSubLogged = false;
  let wsFirstSetCellLogged = false;
  const isTransportOnline = () => transportOnline;

  const beginWsSession = (reconnected) => {
    wsSessionId += 1;
    wsSessionOpenedAtMs = Date.now();
    wsFirstSubLogged = false;
    wsFirstSetCellLogged = false;
    logOther("ws session_open", {
      sessionId: wsSessionId,
      reconnected,
    });
  };

  const endWsSession = ({ disposed }) => {
    if (wsSessionOpenedAtMs === null) {
      return;
    }
    logOther("ws session_close", {
      sessionId: wsSessionId,
      disposed,
      uptimeMs: Math.max(0, Date.now() - wsSessionOpenedAtMs),
    });
    wsSessionOpenedAtMs = null;
  };

  const maybeLogFirstClientMessageAfterOpen = (message) => {
    if (!transportOnline || wsSessionOpenedAtMs === null) {
      return;
    }

    const elapsedMs = Math.max(0, Date.now() - wsSessionOpenedAtMs);
    if (message.t === "sub" && !wsFirstSubLogged) {
      wsFirstSubLogged = true;
      logOther("ws first_sub_after_open", {
        sessionId: wsSessionId,
        elapsedMs,
        tileCount: message.tiles.length,
      });
      return;
    }

    if (message.t === "setCell" && !wsFirstSetCellLogged) {
      wsFirstSetCellLogged = true;
      logOther("ws first_setcell_after_open", {
        sessionId: wsSessionId,
        elapsedMs,
        tile: message.tile,
        i: message.i,
        op: message.op,
      });
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
  const setCellOutboxSync = createSetCellOutboxSync({
    offlineBannerEl,
    sendToWireTransport,
    isTransportOnline,
    setTimeoutFn: window.setTimeout.bind(window),
    clearTimeoutFn: window.clearTimeout.bind(window),
  });

  const sendMessage = (message, options = {}) => {
    const trackSetCell = options.trackSetCell ?? true;
    if (message.t === "cur" && !transportOnline) {
      return;
    }
    maybeLogFirstClientMessageAfterOpen(message);
    if (trackSetCell) {
      setCellOutboxSync.trackOutgoingClientMessage(message);
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
        setCellOutboxSync.handleServerMessage(message);
        onServerMessage(message);
      }, {
        onOpen(info) {
          transportOnline = true;
          beginWsSession(info.reconnected);
          setCellOutboxSync.handleConnectionOpen();
          onOpen(info);
        },
        onClose(info) {
          transportOnline = false;
          endWsSession(info);
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

  const handleConnectionLost = () => {
    transportOnline = false;
    setCellOutboxSync.handleConnectionLost();
    setStatus("Connection lost; retrying...");
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
  let hasAppliedServerSpawn = sharedCamera !== null;

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
      onSpawnReceived: (spawn) => {
        if (hasAppliedServerSpawn) {
          return;
        }
        const clamped = clampCameraCenter(spawn.x, spawn.y);
        camera.x = clamped.x;
        camera.y = clamped.y;
        hasAppliedServerSpawn = true;
        renderLoop.markViewportDirty();
      },
      onTileCellsChanged: renderLoop.markTileCellsDirty,
      setInteractionRestriction,
      onIdentityReceived: ({ uid, name, token }) => {
        writeStoredIdentity({ uid, name, token });
      },
      getPendingSetCellOpsForTile: setCellOutboxSync.getPendingSetCellOpsForTile,
      dropPendingSetCellOpsForTile: setCellOutboxSync.dropPendingSetCellOpsForTile,
    }),
    {
      onOpen: ({ reconnected }) => {
        if (!reconnected) {
          return;
        }
        renderLoop.markTransportReconnected();
        setStatus("Connection restored; resyncing visible tiles...");
        setCellOutboxSync.scheduleReplay(1_000);
      },
      onClose: ({ disposed }) => {
        if (disposed) {
          return;
        }
        handleConnectionLost();
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
    getActiveVisibleRemoteCursorCount,
  });

  const onResize = () => {
    renderLoop.handleResize();
  };
  const isDocumentVisible = () =>
    typeof document === "undefined" || document.visibilityState === "visible";
  const forceSubscriptionRebuild = (reason) => {
    renderLoop.forceSubscriptionRebuild();
    logOther("ws subscription_rebuild", {
      reason,
      transportOnline,
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
    handleConnectionLost();
  };
  const onBrowserOnline = () => {
    if (!transportOnline) {
      setStatus("Network restored; reconnecting...");
    }
  };
  let authTransitionInFlight = false;
  let shareCreateInFlight = false;
  const setAuthControlsDisabled = (disabled) => {
    if (authGoogleSignInButtonEl) {
      authGoogleSignInButtonEl.disabled = disabled;
    }
    if (authGoogleLogoutButtonEl) {
      authGoogleLogoutButtonEl.disabled = disabled;
    }
  };
  const setShareButtonDisabled = (disabled) => {
    if (shareButtonEl) {
      shareButtonEl.disabled = disabled;
    }
  };

  const onGoogleSignInClick = async () => {
    if (!authIdentityProvider || !authSessionExchangeClient) {
      return;
    }
    if (authTransitionInFlight) {
      logOther("auth transition_ignored_in_flight", { action: "google_signin" });
      return;
    }

    authTransitionInFlight = true;
    setAuthControlsDisabled(true);
    try {
      await signInWithGoogleSessionTransition({
        identityProvider: authIdentityProvider,
        sessionExchangeClient: authSessionExchangeClient,
        readStoredIdentity,
        writeStoredIdentity,
        setStatus,
        logOther,
        errorLogger: console,
      });
    } finally {
      authTransitionInFlight = false;
      setAuthControlsDisabled(false);
    }
  };
  const onGoogleLogoutClick = async () => {
    if (!authIdentityProvider || !authSessionExchangeClient) {
      return;
    }
    if (authTransitionInFlight) {
      logOther("auth transition_ignored_in_flight", { action: "google_logout" });
      return;
    }

    authTransitionInFlight = true;
    setAuthControlsDisabled(true);
    try {
      await signOutToAnonymousSessionTransition({
        identityProvider: authIdentityProvider,
        sessionExchangeClient: authSessionExchangeClient,
        readStoredAnonymousIdentity,
        writeStoredAnonymousIdentity,
        writeStoredIdentity,
        setStatus,
        logOther,
        errorLogger: console,
      });
    } finally {
      authTransitionInFlight = false;
      setAuthControlsDisabled(false);
    }
  };
  const onShareButtonClick = async () => {
    if (shareCreateInFlight) {
      return;
    }

    shareCreateInFlight = true;
    setShareButtonDisabled(true);
    setStatus("Creating share link...");
    try {
      const link = await createShareLink({
        apiBaseUrl,
        camera,
      });
      if (link.copied) {
        setStatus("Share link copied to clipboard.");
      } else {
        setStatus(`Share link ready: ${link.url}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logOther("share create_failed", {
        error: detail,
      });
      setStatus("Share link failed. Please try again.");
    } finally {
      shareCreateInFlight = false;
      setShareButtonDisabled(false);
    }
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("offline", onBrowserOffline);
  window.addEventListener("online", onBrowserOnline);
  if (authGoogleSignInButtonEl) {
    authGoogleSignInButtonEl.addEventListener("click", onGoogleSignInClick);
  }
  if (authGoogleLogoutButtonEl) {
    authGoogleLogoutButtonEl.addEventListener("click", onGoogleLogoutClick);
  }
  if (shareButtonEl) {
    shareButtonEl.addEventListener("click", onShareButtonClick);
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onDocumentVisibilityChange);
  }

  return () => {
    window.removeEventListener("resize", onResize);
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("offline", onBrowserOffline);
    window.removeEventListener("online", onBrowserOnline);
    if (authGoogleSignInButtonEl) {
      authGoogleSignInButtonEl.removeEventListener("click", onGoogleSignInClick);
    }
    if (authGoogleLogoutButtonEl) {
      authGoogleLogoutButtonEl.removeEventListener("click", onGoogleLogoutClick);
    }
    if (shareButtonEl) {
      shareButtonEl.removeEventListener("click", onShareButtonClick);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", onDocumentVisibilityChange);
    }
    if (perfProbe.enabled) {
      canvas.removeEventListener("webglcontextlost", onWebGlContextLost);
      canvas.removeEventListener("webglcontextrestored", onWebGlContextRestored);
    }
    teardownInputHandlers();
    cursorLabels.destroy();
    renderLoop.dispose();
    transport.dispose();
    clearInteractionTimer();
    setCellOutboxSync.dispose();
    app.destroy(true);
  };
}
