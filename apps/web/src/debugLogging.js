export const DEBUG_LOG_STORAGE_KEY = "sea_debug_logging";
export const DEBUG_LOG_TTL_MS = 15 * 60 * 1000;
export const DEBUG_LOG_LEVELS = Object.freeze({
  OFF: "off",
  REDUCED: "reduced",
  VERBOSE: "verbose",
});

function parseDebugLevel(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === DEBUG_LOG_LEVELS.REDUCED || normalized === DEBUG_LOG_LEVELS.VERBOSE
    ? normalized
    : null;
}

function toBool(value) {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveNowMs(nowMs) {
  if (typeof nowMs === "function") {
    return Number(nowMs());
  }
  return Number(nowMs);
}

function readStoredValue(storage) {
  if (!storage || typeof storage.getItem !== "function") {
    return null;
  }

  const raw = storage.getItem(DEBUG_LOG_STORAGE_KEY);
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const level = parseDebugLevel(parsed?.level);
    const expiresAtMs =
      typeof parsed?.expiresAtMs === "number" && Number.isFinite(parsed.expiresAtMs)
        ? parsed.expiresAtMs
        : null;
    if (!level || expiresAtMs === null) {
      return null;
    }
    return { level, expiresAtMs };
  } catch {
    return null;
  }
}

function writeStoredValue(storage, value) {
  if (!storage || typeof storage.setItem !== "function") {
    return;
  }

  try {
    storage.setItem(DEBUG_LOG_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore session storage failures in restricted browser contexts.
  }
}

function clearStoredValue(storage) {
  if (!storage || typeof storage.removeItem !== "function") {
    return;
  }

  try {
    storage.removeItem(DEBUG_LOG_STORAGE_KEY);
  } catch {
    // Ignore session storage failures in restricted browser contexts.
  }
}

export function readActiveClientDebugLoggingOverride({
  locationLike = typeof window !== "undefined" ? window.location : undefined,
  storage = globalThis.window?.sessionStorage,
  nowMs = Date.now(),
} = {}) {
  const resolvedNowMs = resolveNowMs(nowMs);
  const params = new URLSearchParams(locationLike?.search ?? "");
  const requestedLevel = parseDebugLevel(params.get("debug_logs"));
  const clearRequested = (params.get("debug_logs") ?? "").trim().toLowerCase() === "off";

  if (clearRequested) {
    clearStoredValue(storage);
    return null;
  }

  if (requestedLevel) {
    const override = {
      level: requestedLevel,
      expiresAtMs: resolvedNowMs + DEBUG_LOG_TTL_MS,
    };
    writeStoredValue(storage, override);
    return override;
  }

  const stored = readStoredValue(storage);
  if (!stored) {
    return null;
  }

  if (stored.expiresAtMs <= resolvedNowMs) {
    clearStoredValue(storage);
    return null;
  }

  return stored;
}

export function resolveDebugCategoryOverrides({
  locationLike = typeof window !== "undefined" ? window.location : undefined,
} = {}) {
  const params = new URLSearchParams(locationLike?.search ?? "");
  return {
    debugEnabled: toBool(params.get("debug")),
  };
}

export function resolveDebugLoggingState({
  locationLike = typeof window !== "undefined" ? window.location : undefined,
  storage = globalThis.window?.sessionStorage,
  nowMs = Date.now(),
} = {}) {
  const resolvedNowMs = resolveNowMs(nowMs);
  const params = new URLSearchParams(locationLike?.search ?? "");
  const requestedLevel = parseDebugLevel(params.get("debug_logs"));
  const clearRequested = (params.get("debug_logs") ?? "").trim().toLowerCase() === "off";

  if (clearRequested) {
    clearStoredValue(storage);
    return {
      level: DEBUG_LOG_LEVELS.OFF,
      expiresAtMs: null,
      source: "url",
    };
  }

  if (requestedLevel) {
    const override = {
      level: requestedLevel,
      expiresAtMs: resolvedNowMs + DEBUG_LOG_TTL_MS,
    };
    writeStoredValue(storage, override);
    return {
      ...override,
      source: "url",
    };
  }

  const stored = readStoredValue(storage);
  if (!stored) {
    return {
      level: DEBUG_LOG_LEVELS.OFF,
      expiresAtMs: null,
      source: "default",
    };
  }

  if (stored.expiresAtMs <= resolvedNowMs) {
    clearStoredValue(storage);
    return {
      level: DEBUG_LOG_LEVELS.OFF,
      expiresAtMs: null,
      source: "expired",
      expiredState: stored,
    };
  }

  return {
    ...stored,
    source: "storage",
  };
}

export function shouldEnableAllClientLogs({
  locationLike = typeof window !== "undefined" ? window.location : undefined,
  storage = globalThis.window?.sessionStorage,
  nowMs = Date.now(),
} = {}) {
  return resolveDebugCategoryOverrides({ locationLike }).debugEnabled
    || resolveDebugLoggingState({
      locationLike,
      storage,
      nowMs,
    }).level !== DEBUG_LOG_LEVELS.OFF;
}

export function buildDebugLoggingQueryParams(debugLoggingState) {
  if (!debugLoggingState || debugLoggingState.level === DEBUG_LOG_LEVELS.OFF) {
    return {};
  }

  return {
    debugLogs: debugLoggingState.level,
    debugLogsExpiresAtMs: String(debugLoggingState.expiresAtMs),
  };
}

export function buildDebugLoggingHeaders(debugLoggingState) {
  if (!debugLoggingState || debugLoggingState.level === DEBUG_LOG_LEVELS.OFF) {
    return {};
  }

  return {
    "x-debug-logs": debugLoggingState.level,
    "x-debug-logs-expires-at-ms": String(debugLoggingState.expiresAtMs),
  };
}
