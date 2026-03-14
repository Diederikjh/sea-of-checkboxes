import { describe, expect, it } from "vitest";

import { buildScenarioAssignments } from "./assignment.mjs";

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
});
