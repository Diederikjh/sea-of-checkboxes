import { describe, expect, it } from "vitest";

import {
  buildScenarioAssignments,
  buildScenarioRuntime,
  normalizeScenarioId,
  parseScenarioPool,
} from "./catalog.mjs";

describe("scenario catalog", () => {
  it("normalizes legacy ids and parses pools", () => {
    expect(normalizeScenarioId("phase1-active")).toBe("spread-editing");
    expect(parseScenarioPool(["hot-tile-contention, read-only-lurker"])).toEqual([
      "hot-tile-contention",
      "read-only-lurker",
    ]);
  });

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

  it("builds runtime timing and reconnect behavior per scenario", () => {
    expect(buildScenarioRuntime({
      scenarioId: "cursor-heavy",
      cursorIntervalMs: 1_000,
      setCellIntervalMs: 3_000,
      durationMs: 60_000,
      readonly: false,
    })).toMatchObject({
      id: "cursor-heavy",
      readonly: false,
      cursorIntervalMs: 250,
      setCellIntervalMs: 9_000,
      viewportIntervalMs: 10_000,
    });

    expect(buildScenarioRuntime({
      scenarioId: "reconnect-burst",
      cursorIntervalMs: 1_000,
      setCellIntervalMs: 3_000,
      durationMs: 60_000,
      readonly: false,
    })).toMatchObject({
      id: "reconnect-burst",
      reconnectBurstDelayMs: 27_000,
    });
  });
});
