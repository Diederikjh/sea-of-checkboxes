import { describe, expect, it } from "vitest";

import {
  defaultScenarioPool,
  listScenarioIds,
  normalizeScenarioId,
  parseScenarioPool,
} from "./pool.mjs";

describe("scenario pool", () => {
  it("exposes the default pool and scenario ids", () => {
    expect(defaultScenarioPool()).toEqual([
      "spread-editing",
      "read-only-lurker",
    ]);
    expect(listScenarioIds()).toContain("multi-hotspot");
    expect(listScenarioIds()).toContain("viewport-churn");
    expect(listScenarioIds({ includeLegacy: true })).toContain("phase1-active");
  });

  it("normalizes legacy ids and parses pools", () => {
    expect(normalizeScenarioId("phase1-active")).toBe("spread-editing");
    expect(parseScenarioPool(["hot-tile-contention, read-only-lurker"])).toEqual([
      "hot-tile-contention",
      "read-only-lurker",
    ]);
  });
});
