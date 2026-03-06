import { describe, expect, it, vi } from "vitest";

import type { CursorRelayBatch } from "../src/cursorRelay";
import { handleConnectionShardCursorBatchIngress } from "../src/connectionShardCursorBatchIngress";
import { ConnectionShardCursorTraceState } from "../src/connectionShardCursorTrace";

function createHarness(options: {
  ingressDepth?: number;
  seenTraceIds?: string[];
  readBatch?: (request: Request) => Promise<CursorRelayBatch | null>;
} = {}) {
  let ingressDepth = options.ingressDepth ?? 0;
  let publishSuppressedUntilMs = 0;
  let nowMs = 1_000;
  const traceState = new ConnectionShardCursorTraceState({
    nowMs: () => nowMs,
  });
  for (const traceId of options.seenTraceIds ?? []) {
    traceState.rememberTrace(traceId);
  }

  const logEvent = vi.fn();
  const receiveBatch = vi.fn();
  const readBatch =
    options.readBatch
    ?? (async (_request: Request) => ({
      from: "shard-remote",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 1,
          y: 2,
          seenAt: 5,
          seq: 3,
          tileKey: "0:0",
        },
      ],
    }));

  return {
    traceState,
    logEvent,
    receiveBatch,
    setNowMs(value: number) {
      nowMs = value;
    },
    getPublishSuppressedUntilMs() {
      return publishSuppressedUntilMs;
    },
    async handle(request: Request) {
      return handleConnectionShardCursorBatchIngress({
        request,
        traceState,
        currentIngressDepth: () => ingressDepth,
        setIngressDepth: (depth) => {
          ingressDepth = depth;
        },
        nowMs: () => nowMs,
        maxTraceHop: 1,
        publishSuppressionMs: 300,
        extendPublishSuppressedUntil: (untilMs) => {
          publishSuppressedUntilMs = Math.max(publishSuppressedUntilMs, untilMs);
        },
        readBatch,
        receiveBatch,
        logEvent,
      });
    },
  };
}

function requestWithTrace(trace: {
  traceId: string;
  traceHop: number;
  traceOrigin: string;
}): Request {
  return new Request("https://connection-shard.internal/cursor-batch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sea-cursor-hub": "1",
      "x-sea-cursor-trace-id": trace.traceId,
      "x-sea-cursor-trace-hop": String(trace.traceHop),
      "x-sea-cursor-trace-origin": trace.traceOrigin,
    },
    body: JSON.stringify({
      from: "shard-remote",
      updates: [],
    }),
  });
}

describe("handleConnectionShardCursorBatchIngress", () => {
  it("drops traced batches whose hop exceeds the loop guard", async () => {
    const harness = createHarness();

    const response = await harness.handle(requestWithTrace({
      traceId: "trace-loop",
      traceHop: 2,
      traceOrigin: "shard-origin",
    }));

    expect(response.status).toBe(204);
    expect(harness.receiveBatch).not.toHaveBeenCalled();
    expect(harness.logEvent).toHaveBeenCalledWith(
      "cursor_batch_loop_guard_drop",
      expect.objectContaining({
        trace_id: "trace-loop",
        trace_hop: 2,
        max_trace_hop: 1,
      })
    );
  });

  it("drops duplicate traced deliveries seen on the same shard", async () => {
    const harness = createHarness({
      seenTraceIds: ["trace-dupe"],
    });

    const response = await harness.handle(requestWithTrace({
      traceId: "trace-dupe",
      traceHop: 1,
      traceOrigin: "shard-origin",
    }));

    expect(response.status).toBe(204);
    expect(harness.receiveBatch).not.toHaveBeenCalled();
    expect(harness.logEvent).toHaveBeenCalledWith(
      "cursor_batch_duplicate_trace_drop",
      expect.objectContaining({
        trace_id: "trace-dupe",
      })
    );
  });

  it("ingests valid batches and clears the active trace after ingress completes", async () => {
    const harness = createHarness();

    const response = await harness.handle(requestWithTrace({
      traceId: "trace-ok",
      traceHop: 1,
      traceOrigin: "shard-origin",
    }));

    expect(response.status).toBe(204);
    expect(harness.receiveBatch).toHaveBeenCalledTimes(1);
    expect(harness.logEvent).toHaveBeenCalledWith(
      "cursor_batch_ingress",
      expect.objectContaining({
        from: "shard-remote",
        update_count: 1,
        trace_id: "trace-ok",
      })
    );
    expect(harness.traceState.activeTraceContext()).toBeNull();
    expect(harness.getPublishSuppressedUntilMs()).toBe(1_300);
  });

  it("rejects invalid cursor batches with a 400 response", async () => {
    const harness = createHarness({
      readBatch: async () => ({ from: "shard-remote", updates: "bad" } as unknown as CursorRelayBatch),
    });

    const response = await harness.handle(
      new Request("https://connection-shard.internal/cursor-batch", {
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
    expect(harness.receiveBatch).not.toHaveBeenCalled();
  });
});
