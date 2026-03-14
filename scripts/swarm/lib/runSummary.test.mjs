import { describe, expect, it } from "vitest";

import { buildRunSummary, formatRunSummaryText } from "./runSummary.mjs";

describe("run summary", () => {
  it("aggregates bot summaries into run-level counters and latency ranges", () => {
    const summary = buildRunSummary({
      config: {
        runId: "run-123",
        botCount: 2,
      },
      stopReason: null,
      shareLink: {
        url: "https://example.test/?share=abc",
      },
      botResults: [
        {
          botId: "bot-001",
          code: 0,
          signal: null,
          forced: false,
          summary: {
            scenarioId: "spread-editing",
            counters: {
              cursorSent: 30,
              setCellSent: 9,
              setCellResolved: 9,
              firstRemoteCursorPeers: 1,
            },
            errorsByCode: {
              hot_tile: 1,
            },
            remoteCursorCountsByPeer: {
              u_a: 29,
            },
            latencyMs: {
              hello: { count: 1, minMs: 900, maxMs: 900, avgMs: 900, p50Ms: 900, p95Ms: 900, p99Ms: 900 },
              subscribeAck: { count: 1, minMs: 700, maxMs: 700, avgMs: 700, p50Ms: 700, p95Ms: 700, p99Ms: 700 },
              setCellSync: { count: 9, minMs: 320, maxMs: 400, avgMs: 350, p50Ms: 340, p95Ms: 400, p99Ms: 400 },
              reconnect: { count: 0, minMs: null, maxMs: null, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
              stop: { count: 1, minMs: 2, maxMs: 2, avgMs: 2, p50Ms: 2, p95Ms: 2, p99Ms: 2 },
              firstRemoteCursor: { count: 1, minMs: 500, maxMs: 500, avgMs: 500, p50Ms: 500, p95Ms: 500, p99Ms: 500 },
            },
            readonly: false,
            shard: "shard-1",
            durationMs: 30_100,
          },
        },
        {
          botId: "bot-002",
          code: 0,
          signal: null,
          forced: false,
          summary: {
            scenarioId: "read-only-lurker",
            counters: {
              cursorSent: 29,
              authoritativeUpdates: 9,
              firstRemoteCursorPeers: 1,
            },
            errorsByCode: {},
            remoteCursorCountsByPeer: {
              u_b: 29,
            },
            latencyMs: {
              hello: { count: 1, minMs: 1100, maxMs: 1100, avgMs: 1100, p50Ms: 1100, p95Ms: 1100, p99Ms: 1100 },
              subscribeAck: { count: 1, minMs: 800, maxMs: 800, avgMs: 800, p50Ms: 800, p95Ms: 800, p99Ms: 800 },
              setCellSync: { count: 0, minMs: null, maxMs: null, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
              reconnect: { count: 0, minMs: null, maxMs: null, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
              stop: { count: 1, minMs: 1, maxMs: 1, avgMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1 },
              firstRemoteCursor: { count: 1, minMs: 650, maxMs: 650, avgMs: 650, p50Ms: 650, p95Ms: 650, p99Ms: 650 },
            },
            readonly: true,
            shard: "shard-2",
            durationMs: 30_050,
          },
        },
      ],
    });

    expect(summary.roleCounts).toEqual({
      active: 1,
      readonly: 1,
    });
    expect(summary.scenarioCounts).toEqual({
      "read-only-lurker": 1,
      "spread-editing": 1,
    });
    expect(summary.counters).toMatchObject({
      cursorSent: 59,
      setCellSent: 9,
      setCellResolved: 9,
      authoritativeUpdates: 9,
      firstRemoteCursorPeers: 2,
    });
    expect(summary.errorsByCode).toEqual({
      hot_tile: 1,
    });
    expect(summary.latencyMs.hello).toMatchObject({
      botsWithSamples: 2,
      sampleCount: 2,
      observedMinMs: 900,
      observedMaxMs: 1100,
      avgOfAveragesMs: 1000,
      botP50Ms: {
        min: 900,
        max: 1100,
      },
    });
    expect(summary.latencyMs.setCellSync).toMatchObject({
      botsWithSamples: 1,
      sampleCount: 9,
      observedMinMs: 320,
      observedMaxMs: 400,
      botP50Ms: {
        min: 340,
        max: 340,
      },
    });
    expect(summary.remoteCursorVisibility).toEqual({
      botsWithAnyRemoteCursor: 2,
      uniquePeerUidCount: 2,
      peersSeenPerBot: {
        min: 1,
        max: 1,
      },
    });
    expect(summary.shards).toEqual(["shard-1", "shard-2"]);
  });

  it("formats a readable text summary", () => {
    const text = formatRunSummaryText({
      runId: "run-123",
      ok: true,
      stopReason: null,
      botCount: 2,
      roleCounts: {
        active: 1,
        readonly: 1,
      },
      scenarioCounts: {
        "spread-editing": 1,
        "read-only-lurker": 1,
      },
      failedBots: 0,
      forcedKillCount: 0,
      durationMs: {
        min: 30_000,
        max: 30_050,
        avgMs: 30_025,
      },
      shards: ["shard-1"],
      counters: {
        cursorSent: 59,
        setCellSent: 9,
        setCellResolved: 9,
        authoritativeUpdates: 18,
        reconnects: 0,
      },
      remoteCursorVisibility: {
        botsWithAnyRemoteCursor: 2,
        peersSeenPerBot: {
          min: 1,
          max: 1,
        },
        uniquePeerUidCount: 2,
      },
      latencyMs: {
        hello: {
          sampleCount: 2,
          botsWithSamples: 2,
          observedMinMs: 900,
          observedMaxMs: 1100,
          botP50Ms: {
            min: 900,
            max: 1100,
          },
        },
        subscribeAck: {
          sampleCount: 2,
          botsWithSamples: 2,
          observedMinMs: 700,
          observedMaxMs: 800,
          botP50Ms: {
            min: 700,
            max: 800,
          },
        },
        firstRemoteCursor: {
          sampleCount: 2,
          botsWithSamples: 2,
          observedMinMs: 500,
          observedMaxMs: 650,
          botP50Ms: {
            min: 500,
            max: 650,
          },
        },
        setCellSync: {
          sampleCount: 9,
          botsWithSamples: 1,
          observedMinMs: 320,
          observedMaxMs: 400,
          botP50Ms: {
            min: 340,
            max: 340,
          },
        },
        reconnect: {
          sampleCount: 0,
          botsWithSamples: 0,
          observedMinMs: null,
          observedMaxMs: null,
          botP50Ms: {
            min: null,
            max: null,
          },
        },
        stop: {
          sampleCount: 2,
          botsWithSamples: 2,
          observedMinMs: 1,
          observedMaxMs: 2,
          botP50Ms: {
            min: 1,
            max: 2,
          },
        },
      },
      errorsByCode: {},
      shareLink: {
        url: "https://example.test/?share=abc",
      },
    });

    expect(text).toContain("Run run-123");
    expect(text).toContain("Bots: 2 total | 1 active | 1 readonly | 0 failed | 0 force-killed");
    expect(text).toContain("Scenarios: spread-editing=1 read-only-lurker=1");
    expect(text).toContain("setCellResolved=9");
    expect(text).toContain("setCellSuperseded=0");
    expect(text).toContain("hello: 2 samples across 2 bots");
    expect(text).toContain("Errors: none");
    expect(text).toContain("Share link: https://example.test/?share=abc");
  });
});
