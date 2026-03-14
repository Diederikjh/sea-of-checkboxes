import { describe, expect, it } from "vitest";

import { applyTileOffset, buildScenarioRuntime } from "./runtime.mjs";

describe("scenario runtime", () => {
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

  it("preserves disabled setCell traffic and applies tile offsets", () => {
    expect(buildScenarioRuntime({
      scenarioId: "viewport-churn",
      cursorIntervalMs: 1_000,
      setCellIntervalMs: 0,
      durationMs: 60_000,
      readonly: false,
    }).setCellIntervalMs).toBe(0);

    expect(applyTileOffset(100, 200, { dx: 1, dy: -2 })).toEqual({
      x: 164,
      y: 72,
    });
  });
});
