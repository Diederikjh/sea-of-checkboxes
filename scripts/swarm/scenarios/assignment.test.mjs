import { describe, expect, it } from "vitest";

import { buildScenarioAssignments } from "./assignment.mjs";
import { parseScenarioPool } from "./pool.mjs";

describe("scenario assignment", () => {
  it("assigns scenarios round-robin with scenario-specific origins", () => {
    const assignments = buildScenarioAssignments({
      scenarioPool: ["hot-tile-contention", "spread-editing", "read-only-lurker"],
      botCount: 5,
      originX: 100,
      originY: 200,
    });

    expect(assignments).toEqual([
      {
        scenarioId: "hot-tile-contention",
        readonly: false,
        originX: 100,
        originY: 200,
      },
      {
        scenarioId: "spread-editing",
        readonly: false,
        originX: 100,
        originY: 200,
      },
      {
        scenarioId: "read-only-lurker",
        readonly: true,
        originX: 100,
        originY: 200,
      },
      {
        scenarioId: "hot-tile-contention",
        readonly: false,
        originX: 102,
        originY: 200,
      },
      {
        scenarioId: "spread-editing",
        readonly: false,
        originX: 196,
        originY: 200,
      },
    ]);
  });

  it("expands wildcard-local into a randomized local mix", () => {
    const values = [0.9, 0.1, 0.6, 0.2];
    let index = 0;
    const pool = parseScenarioPool(["wildcard-local"], {
      random: () => {
        const value = values[index] ?? 0;
        index += 1;
        return value;
      },
    });

    expect(pool).toEqual([
      "read-only-lurker",
      "cursor-heavy",
      "viewport-churn",
      "hot-tile-contention",
    ]);

    const assignments = buildScenarioAssignments({
      scenarioPool: pool,
      botCount: 5,
      originX: 100,
      originY: 200,
    });

    expect(assignments.map((assignment) => assignment.scenarioId)).toEqual([
      "read-only-lurker",
      "cursor-heavy",
      "viewport-churn",
      "hot-tile-contention",
      "read-only-lurker",
    ]);
  });
});
