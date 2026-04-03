import {
  Application,
  Graphics,
} from "pixi.js";
import {
  clampCameraCenter,
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
import { createEnvironmentObservers } from "./environmentObservers";
import { createServerMessageHandler } from "./serverMessages";
import { createSetCellOutboxSync } from "./setCellOutboxSync";
import { createSubscriptionRebuildTracker } from "./subscriptionRebuildTracker";
import { createRecoveryRuntime } from "./recoveryRuntime";
import { createRenderLoop } from "./renderLoop";
import { resolveClientSessionId } from "./clientSessionId";
import {
  createShareLink,
  readShareIdFromLocation,
  resolveSharedCamera,
} from "./shareLinks";
import { TileStore } from "./tileStore";
import { describePayload, summarizeMessage } from "./protocolTelemetry";
import { createTransportRuntime } from "./transportRuntime";
import { resolveApiBaseUrl } from "./transportConfig";
import { createUiRuntime } from "./uiRuntime";
import { createWireTransport } from "./wireTransport";
import { CURSOR_TTL_MS } from "./cursorRenderConfig";
import { resolveFrontendRuntimeFlags } from "./runtimeFlags";
import { resolveDebugLoggingState as readDebugLoggingState } from "./debugLogging";
import {
  cursorWorldPosition,
  isScreenPointInViewport,
  worldToScreenPoint,
} from "./cursorGeometry";

const CURSOR_VIEWPORT_MARGIN_PX = 24;

function createClientMessageIdFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `c_${Date.now().toString(36)}_${counter.toString(36)}`;
  };
}

function shouldAttachClientMessageId(message) {
  return message.t === "sub"
    || message.t === "unsub"
    || message.t === "setCell"
    || message.t === "resyncTile";
}

export async function startApp({
  runtimeFlags = resolveFrontendRuntimeFlags(),
} = {}) {
  if (runtimeFlags.appDisabled) {
    return () => {};
  }
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

  const uiRuntime = createUiRuntime({
    statusEl,
    interactionOverlayEl,
    interactionOverlayTextEl,
    setTimeoutFn: window.setTimeout.bind(window),
    clearTimeoutFn: window.clearTimeout.bind(window),
  });
  const { setStatus } = uiRuntime;

  const logOther = (...args) => {
    if (typeof logger.other === "function") {
      logger.other(...args);
    }
  };
  const logSetCellSyncWait = (event, fields) => {
    logOther(event, fields);
  };
  const nextClientMessageId = createClientMessageIdFactory();
  const clientSessionId = resolveClientSessionId();
  logOther("client_session", { clientSessionId });
  const shareLinksEnabled = runtimeFlags.shareLinksEnabled;
  const anonAuthEnabled = runtimeFlags.anonAuthEnabled;

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
  const shareLinksDisabledMessage =
    shareId && !shareLinksEnabled ? "Share links are disabled right now." : null;
  const sharedCamera = shareLinksEnabled && shareId
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
    ? createAuthSessionExchangeClient({
        apiBaseUrl,
        clientSessionId,
        debugLoggingStateResolver: readDebugLoggingState,
      })
    : null;
  const authIdentityProvider = firebaseConfig
    ? createFirebaseAuthIdentityProvider({ config: firebaseConfig })
    : null;
  let authPrincipal = null;

  if (authIdentityProvider && authSessionExchangeClient && anonAuthEnabled) {
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
  } else if (!anonAuthEnabled) {
    const storedIdentity = readStoredIdentity();
    if (!storedIdentity && !shareId) {
      setStatus("Anonymous access is disabled right now.");
    }
  }

  if (shareLinksDisabledMessage) {
    setStatus(shareLinksDisabledMessage);
  }

  if (authGoogleSignInButtonEl) {
    authGoogleSignInButtonEl.hidden =
      !authIdentityProvider ||
      !authSessionExchangeClient ||
      (anonAuthEnabled ? (authPrincipal ? authPrincipal.isAnonymous === false : true) : false);
  }
  if (authGoogleLogoutButtonEl) {
    authGoogleLogoutButtonEl.hidden =
      !authIdentityProvider ||
      !authSessionExchangeClient ||
      !anonAuthEnabled ||
      (authPrincipal ? authPrincipal.isAnonymous === true : true);
  }
  if (shareButtonEl) {
    shareButtonEl.hidden = !shareLinksEnabled;
    shareButtonEl.disabled = !shareLinksEnabled;
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
    clientSessionId,
    debugLoggingStateResolver: readDebugLoggingState,
  });
  let transport = null;
  const setCellOutboxSync = createSetCellOutboxSync({
    offlineBannerEl,
    sendToWireTransport: (message) => {
      transport.send(message, { trackSetCell: false });
    },
    isTransportOnline: () => transport?.isOnline() ?? false,
    setTimeoutFn: window.setTimeout.bind(window),
    clearTimeoutFn: window.clearTimeout.bind(window),
    onSyncWaitEvent: logSetCellSyncWait,
  });
  const subscriptionRebuildTracker = createSubscriptionRebuildTracker({
    logEvent: logOther,
    scheduleReplay: (delayMs) => {
      setCellOutboxSync.scheduleReplay(delayMs);
    },
  });

  const transportRuntime = createTransportRuntime({
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
  transport = {
    connect: transportRuntime.connect,
    send(message, options = {}) {
      const preparedMessage = shouldAttachClientMessageId(message) && typeof message.cid !== "string"
        ? { ...message, cid: nextClientMessageId() }
        : message;

      if (preparedMessage.t === "cur" && !transportRuntime.isOnline()) {
        return undefined;
      }

      transportRuntime.send(preparedMessage, options);
      return preparedMessage;
    },
    isOnline: transportRuntime.isOnline,
    markOffline: transportRuntime.markOffline,
    dispose: transportRuntime.dispose,
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
    onSubscriptionRebuildSubSent: subscriptionRebuildTracker.onDispatch,
    onSubscriptionRebuildSkipped: subscriptionRebuildTracker.onSkipped,
    getPendingSetCellOpsForTile: setCellOutboxSync.getPendingSetCellOpsForTile,
    schedulePendingSetCellReplay: (delayMs) => setCellOutboxSync.scheduleReplay(delayMs),
  });
  let hasAppliedServerSpawn = sharedCamera !== null;

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
      setInteractionRestriction: uiRuntime.setInteractionRestriction,
      onIdentityReceived: ({ uid, name, token }) => {
        writeStoredIdentity({ uid, name, token });
      },
      onSubscriptionAck: subscriptionRebuildTracker.onAck,
      getPendingSetCellOpsForTile: recoveryRuntime.getPendingSetCellOpsForTile,
      dropPendingSetCellOpsForTile: recoveryRuntime.dropPendingSetCellOpsForTile,
    }),
    {
      onOpen: ({ reconnected }) => {
        if (!reconnected) {
          return;
        }
        subscriptionRebuildTracker.begin("transport_reconnect");
        subscriptionRebuildTracker.markReplayPending();
        renderLoop.markTransportReconnected("transport_reconnect");
        setStatus("Connection restored; resyncing visible tiles...");
      },
      onClose: ({ disposed }) => {
        if (disposed) {
          return;
        }
        recoveryRuntime.onBrowserOffline();
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
    getSetCellGuard: subscriptionRebuildTracker.getSetCellGuard,
  });

  const isDocumentVisible = () =>
    typeof document === "undefined" || document.visibilityState === "visible";
  const forceSubscriptionRebuild = (reason) => {
    if (subscriptionRebuildTracker.isActive()) {
      logOther("ws subscription_rebuild_suppressed", {
        reason,
        suppressReason: "already_active",
        transportOnline: transport.isOnline(),
        visibilityState:
          typeof document !== "undefined" && typeof document.visibilityState === "string"
            ? document.visibilityState
            : undefined,
      });
      return;
    }
    subscriptionRebuildTracker.begin(reason);
    renderLoop.forceSubscriptionRebuild(reason);
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
    if (!shareLinksEnabled) {
      setStatus("Share links are disabled right now.");
      return;
    }
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
        identityToken: readStoredIdentity()?.token ?? "",
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

  if (authGoogleSignInButtonEl) {
    authGoogleSignInButtonEl.addEventListener("click", onGoogleSignInClick);
  }
  if (authGoogleLogoutButtonEl) {
    authGoogleLogoutButtonEl.addEventListener("click", onGoogleLogoutClick);
  }
  if (shareButtonEl) {
    shareButtonEl.addEventListener("click", onShareButtonClick);
  }

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
    if (authGoogleSignInButtonEl) {
      authGoogleSignInButtonEl.removeEventListener("click", onGoogleSignInClick);
    }
    if (authGoogleLogoutButtonEl) {
      authGoogleLogoutButtonEl.removeEventListener("click", onGoogleLogoutClick);
    }
    if (shareButtonEl) {
      shareButtonEl.removeEventListener("click", onShareButtonClick);
    }
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
