function toBool(value) {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isMockTransportEnabled(
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {}
) {
  return toBool(env.VITE_USE_MOCK);
}

export function resolveWebSocketUrl(
  locationLike = typeof window !== "undefined" ? window.location : undefined,
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {}
) {
  const envUrl = typeof env.VITE_WS_URL === "string" ? env.VITE_WS_URL.trim() : "";
  if (envUrl.length > 0) {
    return envUrl;
  }

  if (!locationLike || typeof locationLike.host !== "string") {
    return "ws://127.0.0.1:8787/ws";
  }

  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${locationLike.host}/ws`;
}

