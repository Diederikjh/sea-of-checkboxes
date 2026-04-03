import { normalizeStoredIdentity } from "./identityStore";
import {
  buildDebugLoggingQueryParams,
} from "./debugLogging";

function toBool(value) {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function withIdentityQueryParams(wsUrl, identity, clientSessionId = "", debugLoggingState = null) {
  const normalized = normalizeStoredIdentity(identity);
  try {
    const parsed = new URL(wsUrl);
    if (normalized) {
      parsed.searchParams.set("token", normalized.token);
    }
    if (typeof clientSessionId === "string" && clientSessionId.trim().length > 0) {
      parsed.searchParams.set("clientSessionId", clientSessionId.trim());
    }
    const debugParams = buildDebugLoggingQueryParams(debugLoggingState);
    for (const [key, value] of Object.entries(debugParams)) {
      parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    return wsUrl;
  }
}

export function isMockTransportEnabled(
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {}
) {
  return toBool(env.VITE_USE_MOCK);
}

export function resolveWebSocketUrl(
  locationLike = typeof window !== "undefined" ? window.location : undefined,
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {},
  identity = null,
  clientSessionId = "",
  debugLoggingState = null
) {
  const envUrl = typeof env.VITE_WS_URL === "string" ? env.VITE_WS_URL.trim() : "";
  if (envUrl.length > 0) {
    return withIdentityQueryParams(envUrl, identity, clientSessionId, debugLoggingState);
  }

  if (!locationLike || typeof locationLike.host !== "string") {
    return withIdentityQueryParams(
      "ws://127.0.0.1:8787/ws",
      identity,
      clientSessionId,
      debugLoggingState
    );
  }

  const host = locationLike.host.toLowerCase();
  if (host === "localhost:5173" || host === "127.0.0.1:5173") {
    return withIdentityQueryParams(
      "ws://127.0.0.1:8787/ws",
      identity,
      clientSessionId,
      debugLoggingState
    );
  }

  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return withIdentityQueryParams(
    `${protocol}//${locationLike.host}/ws`,
    identity,
    clientSessionId,
    debugLoggingState
  );
}

export function resolveApiBaseUrl(
  locationLike = typeof window !== "undefined" ? window.location : undefined,
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {}
) {
  const envUrl = typeof env.VITE_API_BASE_URL === "string" ? env.VITE_API_BASE_URL.trim() : "";
  if (envUrl.length > 0) {
    return envUrl.replace(/\/+$/, "");
  }

  const wsUrl = resolveWebSocketUrl(locationLike, env);
  try {
    const parsed = new URL(wsUrl);
    const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${parsed.host}`;
  } catch {
    return "http://127.0.0.1:8787";
  }
}
