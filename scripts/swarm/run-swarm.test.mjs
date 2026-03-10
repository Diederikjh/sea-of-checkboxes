import { describe, expect, it } from "vitest";

import {
  buildBotLaunchConfigs,
  parseRunSwarmArgs,
} from "./lib/runSwarmConfig.mjs";

describe("run swarm config", () => {
  it("builds deterministic two-bot defaults with one readonly lurker", () => {
    const config = parseRunSwarmArgs([
      "--run-id",
      "run-test",
      "--bot-count",
      "2",
      "--origin-x",
      "100",
      "--origin-y",
      "-200",
    ]);

    const bots = buildBotLaunchConfigs(config);
    expect(bots).toHaveLength(2);
    expect(bots[0]).toMatchObject({
      botId: "bot-001",
      readonly: false,
      scenarioId: "phase1-active",
      originX: 100,
      originY: -200,
    });
    expect(bots[1]).toMatchObject({
      botId: "bot-002",
      readonly: true,
      scenarioId: "read-only-lurker",
      originX: 108,
      originY: -200,
    });
  });

  it("allows negative coordinates and custom duration", () => {
    const config = parseRunSwarmArgs([
      "--duration-ms",
      "15000",
      "--app-url",
      "https://app.example.com/",
      "--origin-x",
      "-123",
      "--origin-y",
      "-456",
      "--kill-after-ms",
      "500",
    ]);

    expect(config.durationMs).toBe(15000);
    expect(config.appUrl).toBe("https://app.example.com/");
    expect(config.originX).toBe(-123);
    expect(config.originY).toBe(-456);
    expect(config.killAfterMs).toBe(500);
  });
});
