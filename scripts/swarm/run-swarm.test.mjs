import { describe, expect, it } from "vitest";

import {
  buildBotLaunchConfigs,
  parseRunSwarmArgs,
} from "./lib/runSwarmConfig.mjs";
import {
  buildWorkerHealthUrl,
  shouldWaitForWorkerReadiness,
  waitForWorkerReady,
} from "./lib/workerReadiness.mjs";

describe("run swarm config", () => {
  it("builds deterministic two-bot defaults with one spread editor and one readonly lurker", () => {
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
      scenarioId: "spread-editing",
      originX: 100,
      originY: -200,
    });
    expect(bots[1]).toMatchObject({
      botId: "bot-002",
      readonly: true,
      scenarioId: "read-only-lurker",
      originX: 100,
      originY: -200,
    });
  });

  it("cycles through a custom scenario pool", () => {
    const config = parseRunSwarmArgs([
      "--bot-count",
      "4",
      "--scenario-pool",
      "hot-tile-contention,viewport-churn",
      "--origin-x",
      "0",
      "--origin-y",
      "0",
    ]);

    const bots = buildBotLaunchConfigs(config);
    expect(bots.map((bot) => bot.scenarioId)).toEqual([
      "hot-tile-contention",
      "viewport-churn",
      "hot-tile-contention",
      "viewport-churn",
    ]);
    expect(bots[2]).toMatchObject({
      originX: 2,
      originY: 0,
    });
    expect(bots[3]).toMatchObject({
      originX: 128,
      originY: 0,
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

  it("builds a local worker health URL from the websocket endpoint", () => {
    expect(buildWorkerHealthUrl("ws://127.0.0.1:8787/ws")).toBe("http://127.0.0.1:8787/health");
    expect(buildWorkerHealthUrl("wss://worker.example.com/ws")).toBe("https://worker.example.com/health");
  });

  it("waits for local worker readiness but skips remote deployments", () => {
    expect(shouldWaitForWorkerReadiness("ws://127.0.0.1:8787/ws")).toBe(true);
    expect(shouldWaitForWorkerReadiness("ws://localhost:8787/ws")).toBe(true);
    expect(shouldWaitForWorkerReadiness("wss://worker.example.com/ws")).toBe(false);
  });

  it("retries the local health endpoint until the worker is ready", async () => {
    let attempts = 0;
    let currentNowMs = 1_000;
    const events = [];
    const result = await waitForWorkerReady({
      wsUrl: "ws://127.0.0.1:8787/ws",
      runId: "run-local-ready",
      logger: {
        log(event, fields) {
          events.push({ event, fields });
        },
      },
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("worker booting");
        }
        return {
          ok: true,
          async json() {
            return { ok: true };
          },
        };
      },
      nowMs: () => currentNowMs,
      sleep: async (delayMs) => {
        currentNowMs += delayMs;
      },
      timeoutMs: 2_000,
      pollIntervalMs: 250,
    });

    expect(result).toMatchObject({
      ok: true,
      skipped: false,
      attempts: 3,
      healthUrl: "http://127.0.0.1:8787/health",
    });
    expect(events.map((entry) => entry.event)).toEqual([
      "worker_readiness_wait_start",
      "worker_readiness_ready",
    ]);
  });
});
