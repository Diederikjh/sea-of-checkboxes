const LOG_CATEGORIES = Object.freeze({
  PROTOCOL: "protocol",
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

  const fromLogsParam = new Set(
    (params.get("logs") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );

  const protocolEnabled =
    toBool(env.VITE_LOG_PROTOCOL) ||
    toBool(params.get("log_protocol")) ||
    fromLogsParam.has(LOG_CATEGORIES.PROTOCOL);

  const otherEnabled =
    toBool(env.VITE_LOG_OTHER) ||
    toBool(params.get("log_other")) ||
    fromLogsParam.has(LOG_CATEGORIES.OTHER);

  return {
    [LOG_CATEGORIES.PROTOCOL]: protocolEnabled,
    [LOG_CATEGORIES.OTHER]: otherEnabled,
  };
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
});

