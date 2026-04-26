function firebaseEnv(env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {}) {
  return env;
}

const FIREBASE_ANALYTICS_HOST_COOKIE_DOMAIN = "none";

export function normalizeFirebaseConfig(config, {
  requireMeasurementId = false,
} = {}) {
  if (!config || typeof config !== "object") {
    return null;
  }

  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const authDomain = typeof config.authDomain === "string" ? config.authDomain.trim() : "";
  const projectId = typeof config.projectId === "string" ? config.projectId.trim() : "";
  const appId = typeof config.appId === "string" ? config.appId.trim() : "";
  const measurementId = typeof config.measurementId === "string" ? config.measurementId.trim() : "";
  if (
    apiKey.length === 0 ||
    authDomain.length === 0 ||
    projectId.length === 0 ||
    appId.length === 0 ||
    (requireMeasurementId && measurementId.length === 0)
  ) {
    return null;
  }

  const normalized = {
    apiKey,
    authDomain,
    projectId,
    appId,
  };

  if (measurementId.length > 0) {
    normalized.measurementId = measurementId;
  }

  return normalized;
}

export function resolveFirebaseConfigFromEnv(env = firebaseEnv()) {
  return normalizeFirebaseConfig({
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
    measurementId: env.VITE_FIREBASE_MEASUREMENT_ID,
  });
}

export function resolveFirebaseAnalyticsConfigFromEnv(env = firebaseEnv()) {
  return normalizeFirebaseConfig(
    {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID,
      measurementId: env.VITE_FIREBASE_MEASUREMENT_ID,
    },
    { requireMeasurementId: true }
  );
}

export function resolveFirebaseAnalyticsCookieDomain({
  locationLike = typeof window !== "undefined" ? window.location : undefined,
} = {}) {
  return locationLike ? FIREBASE_ANALYTICS_HOST_COOKIE_DOMAIN : "";
}
