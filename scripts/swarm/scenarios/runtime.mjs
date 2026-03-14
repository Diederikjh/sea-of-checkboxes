import { getScenarioDefinition, TILE_SIZE } from "./definitions.mjs";
import { defaultScenarioPool, normalizeScenarioId } from "./pool.mjs";

export function buildScenarioRuntime(config) {
  const scenarioId = normalizeScenarioId(config.scenarioId ?? defaultScenarioPool()[0]);
  return getScenarioDefinition(scenarioId).runtime({
    ...config,
    scenarioId,
  });
}

export function applyTileOffset(anchorX, anchorY, offset) {
  return {
    x: anchorX + (offset.dx * TILE_SIZE),
    y: anchorY + (offset.dy * TILE_SIZE),
  };
}
