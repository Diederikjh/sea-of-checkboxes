import {
  DEFAULT_SCENARIO_POOL,
  LEGACY_SCENARIO_ALIASES,
  listScenarioDefinitions,
} from "./definitions.mjs";

export function defaultScenarioPool() {
  return [...DEFAULT_SCENARIO_POOL];
}

export function listScenarioIds({ includeLegacy = false } = {}) {
  const ids = listScenarioDefinitions().map((definition) => definition.id);
  if (!includeLegacy) {
    return ids;
  }
  return [...ids, ...Object.keys(LEGACY_SCENARIO_ALIASES)];
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

export function parseScenarioPool(rawValues) {
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
      out.push(normalizeScenarioId(trimmed));
    }
  }

  return out.length > 0 ? out : defaultScenarioPool();
}
