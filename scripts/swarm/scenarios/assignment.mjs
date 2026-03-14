import { getScenarioDefinition } from "./definitions.mjs";
import { defaultScenarioPool, parseScenarioPool } from "./pool.mjs";

export function buildScenarioAssignments({
  scenarioPool = defaultScenarioPool(),
  botCount,
  originX,
  originY,
}) {
  const normalizedPool = parseScenarioPool(scenarioPool);
  const scenarioSlots = new Map();
  const assignments = [];

  for (let botIndex = 0; botIndex < botCount; botIndex += 1) {
    const scenarioId = normalizedPool[botIndex % normalizedPool.length];
    const slot = scenarioSlots.get(scenarioId) ?? 0;
    scenarioSlots.set(scenarioId, slot + 1);
    const scenario = getScenarioDefinition(scenarioId);
    const offset = scenario.originOffset(slot);

    assignments.push({
      scenarioId,
      readonly: scenario.readonly,
      originX: originX + offset.x,
      originY: originY + offset.y,
    });
  }

  return assignments;
}
