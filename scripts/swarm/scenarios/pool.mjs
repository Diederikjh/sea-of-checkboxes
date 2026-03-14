import {
  DEFAULT_SCENARIO_POOL,
  LEGACY_SCENARIO_ALIASES,
  listScenarioDefinitions,
} from "./definitions.mjs";

const WILDCARD_LOCAL_TOKEN = "wildcard-local";
const WILDCARD_LOCAL_READONLY = "read-only-lurker";
const WILDCARD_LOCAL_ACTIVE_CANDIDATES = Object.freeze([
  "spread-editing",
  "hot-tile-contention",
  "cursor-heavy",
  "viewport-churn",
  "reconnect-burst",
]);

export function defaultScenarioPool() {
  return [...DEFAULT_SCENARIO_POOL];
}

export function listScenarioIds({ includeLegacy = false } = {}) {
  const ids = listScenarioDefinitions().map((definition) => definition.id);
  if (!includeLegacy) {
    return ids;
  }
  return [...ids, WILDCARD_LOCAL_TOKEN, ...Object.keys(LEGACY_SCENARIO_ALIASES)];
}

export function normalizeScenarioId(rawScenarioId) {
  const scenarioId = String(rawScenarioId ?? "").trim();
  if (scenarioId.length === 0) {
    throw new Error("Scenario id is required");
  }
  const normalized = LEGACY_SCENARIO_ALIASES[scenarioId] ?? scenarioId;
  if (!listScenarioIds().includes(normalized)) {
    throw new Error(`Unknown scenario id: ${rawScenarioId}`);
  }
  return normalized;
}

export function expandWildcardLocalScenarioPool({
  random = Math.random,
} = {}) {
  const active = [...WILDCARD_LOCAL_ACTIVE_CANDIDATES];
  for (let index = active.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(random() * (index + 1));
    [active[index], active[nextIndex]] = [active[nextIndex], active[index]];
  }
  return [WILDCARD_LOCAL_READONLY, ...active.slice(0, 3)];
}

export function parseScenarioPool(rawValues, options = {}) {
  const random = options.random ?? Math.random;
  const values = Array.isArray(rawValues) ? rawValues : [rawValues];
  const out = [];

  for (const rawValue of values) {
    if (typeof rawValue !== "string") {
      continue;
    }
    for (const part of rawValue.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed === WILDCARD_LOCAL_TOKEN) {
        out.push(...expandWildcardLocalScenarioPool({ random }));
        continue;
      }
      out.push(normalizeScenarioId(trimmed));
    }
  }

  return out.length > 0 ? out : defaultScenarioPool();
}
