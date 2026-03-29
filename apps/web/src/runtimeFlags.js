function toBool(value, defaultValue = false) {
  if (typeof value !== "string") {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return defaultValue;
  }

  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveFrontendRuntimeFlags(
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {}
) {
  return {
    appDisabled: toBool(env.VITE_APP_DISABLED, false),
    shareLinksEnabled: toBool(env.VITE_SHARE_LINKS_ENABLED, true),
    anonAuthEnabled: toBool(env.VITE_ANON_AUTH_ENABLED, true),
  };
}

