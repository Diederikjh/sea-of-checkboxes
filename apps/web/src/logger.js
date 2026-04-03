import {
  DEBUG_LOG_LEVELS,
  resolveDebugCategoryOverrides,
  resolveDebugLoggingState,
} from "./debugLogging";

const LOG_CATEGORIES = Object.freeze({
  PROTOCOL: "protocol",
  UI: "ui",
  OTHER: "other",
});

function toBool(value) {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readEnabledCategories() {
  const env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
  const search =
    typeof window !== "undefined" && window.location ? window.location.search : "";
  const params = new URLSearchParams(search);
  const debugLoggingState = resolveDebugLoggingState();
  const { debugEnabled } = resolveDebugCategoryOverrides();
  const enableAllCategories =
    debugEnabled || debugLoggingState.level !== DEBUG_LOG_LEVELS.OFF;

  const fromLogsParam = new Set(
    (params.get("logs") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );

  const protocolEnabled = isCategoryEnabledByConfig(
    env,
    params,
    fromLogsParam,
    LOG_CATEGORIES.PROTOCOL,
    enableAllCategories
  );
  const uiEnabled = isCategoryEnabledByConfig(
    env,
    params,
    fromLogsParam,
    LOG_CATEGORIES.UI,
    enableAllCategories
  );
  const otherEnabled = isCategoryEnabledByConfig(
    env,
    params,
    fromLogsParam,
    LOG_CATEGORIES.OTHER,
    enableAllCategories
  );

  return {
    [LOG_CATEGORIES.PROTOCOL]: protocolEnabled,
    [LOG_CATEGORIES.UI]: uiEnabled,
    [LOG_CATEGORIES.OTHER]: otherEnabled,
  };
}

function isCategoryEnabledByConfig(env, params, fromLogsParam, category, enableAllCategories) {
  if (enableAllCategories) {
    return true;
  }
  const envKey = `VITE_LOG_${category.toUpperCase()}`;
  const paramKey = `log_${category}`;
  const envValue = env[envKey];
  return toBool(envValue) || toBool(params.get(paramKey)) || fromLogsParam.has(category);
}

const enabledCategories = readEnabledCategories();

function isCategoryEnabled(category) {
  return enabledCategories[category] === true;
}

function log(category, ...args) {
  if (!isCategoryEnabled(category)) {
    return;
  }
  console.log(`[${category}]`, ...args);
}

export const logger = Object.freeze({
  categories: LOG_CATEGORIES,
  isEnabled: isCategoryEnabled,
  log,
  protocol(...args) {
    log(LOG_CATEGORIES.PROTOCOL, ...args);
  },
  other(...args) {
    log(LOG_CATEGORIES.OTHER, ...args);
  },
  ui(...args) {
    log(LOG_CATEGORIES.UI, ...args);
  },
});
