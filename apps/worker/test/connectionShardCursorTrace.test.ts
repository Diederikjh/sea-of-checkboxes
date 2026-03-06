import { describe, expect, it } from "vitest";

import { ConnectionShardCursorTraceState } from "../src/connectionShardCursorTrace";

describe("ConnectionShardCursorTraceState", () => {
  it("parses trace headers from requests", () => {
    let nowMs = 100;
    const state = new ConnectionShardCursorTraceState({
      nowMs: () => nowMs,
    });

    const trace = state.readFromRequest(
      new Request("https://connection-shard.internal/cursor-batch", {
        headers: {
          "x-sea-cursor-trace-id": "trace-1",
          "x-sea-cursor-trace-hop": "1",
          "x-sea-cursor-trace-origin": "shard-origin",
        },
      })
    );

    expect(trace).toEqual({
      traceId: "trace-1",
      traceHop: 1,
      traceOrigin: "shard-origin",
    });
  });

  it("tracks recent traces for duplicate detection and expires them", () => {
    let nowMs = 1_000;
    const state = new ConnectionShardCursorTraceState({
      nowMs: () => nowMs,
      traceCacheTtlMs: 50,
    });

    state.rememberTrace("trace-1");
    expect(state.hasSeenRecentTrace("trace-1")).toBe(true);

    nowMs = 1_060;
    expect(state.hasSeenRecentTrace("trace-1")).toBe(false);
  });

  it("keeps the last ingress trace active through the publish suppression window", () => {
    let nowMs = 5_000;
    const state = new ConnectionShardCursorTraceState({
      nowMs: () => nowMs,
    });
    const trace = {
      traceId: "trace-2",
      traceHop: 1,
      traceOrigin: "shard-origin",
    };

    const previous = state.pushActiveTrace(trace);
    expect(previous).toBeNull();
    expect(state.activeTraceContext()).toEqual(trace);

    state.restoreActiveTrace(previous);
    state.rememberIngressTraceForPublish(trace, 100);
    expect(state.activeTraceContext()).toEqual(trace);

    nowMs = 5_101;
    expect(state.activeTraceContext()).toBeNull();
  });
});
