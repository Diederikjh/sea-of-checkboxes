import { logger } from "./logger";
import { createMockTransport } from "./mockTransport";
import { isMockTransportEnabled, resolveWebSocketUrl } from "./transportConfig";
import { createWebSocketTransport } from "./webSocketTransport";

export function createWireTransport({
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {},
  locationLike = typeof window !== "undefined" ? window.location : undefined,
  wsFactory,
  identityProvider,
  clientSessionId = "",
  debugLoggingState = null,
  debugLoggingStateResolver = null,
} = {}) {
  if (isMockTransportEnabled(env)) {
    logger.other("transport", { mode: "mock" });
    return createMockTransport();
  }

  const resolveIdentity = typeof identityProvider === "function" ? identityProvider : () => null;
  const resolveDebugLoggingState =
    typeof debugLoggingStateResolver === "function"
      ? debugLoggingStateResolver
      : () => debugLoggingState;
  const resolveUrl = () =>
    resolveWebSocketUrl(
      locationLike,
      env,
      resolveIdentity(),
      clientSessionId,
      resolveDebugLoggingState()
    );
  const wsUrl = resolveUrl();
  const initialDebugState = resolveDebugLoggingState();
  logger.other("transport", {
    mode: "ws",
    wsUrl,
    clientSessionId,
    debugLogs: initialDebugState?.level ?? "off",
  });
  return createWebSocketTransport(wsUrl, { wsFactory, resolveUrl });
}
