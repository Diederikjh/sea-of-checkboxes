import { logger } from "./logger";
import { createMockTransport } from "./mockTransport";
import { isMockTransportEnabled, resolveWebSocketUrl } from "./transportConfig";
import { createWebSocketTransport } from "./webSocketTransport";

export function createWireTransport({
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {},
  locationLike = typeof window !== "undefined" ? window.location : undefined,
  wsFactory,
  identityProvider,
} = {}) {
  if (isMockTransportEnabled(env)) {
    logger.other("transport", { mode: "mock" });
    return createMockTransport();
  }

  const resolveIdentity = typeof identityProvider === "function" ? identityProvider : () => null;
  const resolveUrl = () => resolveWebSocketUrl(locationLike, env, resolveIdentity());
  const wsUrl = resolveUrl();
  logger.other("transport", { mode: "ws", wsUrl });
  return createWebSocketTransport(wsUrl, { wsFactory, resolveUrl });
}
