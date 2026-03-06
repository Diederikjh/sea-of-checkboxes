import type { CursorRelayBatch } from "./cursorRelay";

import { isValidCursorRelayBatch } from "./cursorRelay";
import type { ConnectionShardCursorTraceState } from "./connectionShardCursorTrace";

export const CURSOR_HUB_SOURCE_HEADER = "x-sea-cursor-hub";

export interface ConnectionShardCursorBatchIngressOptions {
  request: Request;
  traceState: ConnectionShardCursorTraceState;
  currentIngressDepth: () => number;
  setIngressDepth: (depth: number) => void;
  nowMs: () => number;
  maxTraceHop: number;
  publishSuppressionMs: number;
  extendPublishSuppressedUntil: (untilMs: number) => void;
  readBatch: (request: Request) => Promise<CursorRelayBatch | null>;
  receiveBatch: (batch: CursorRelayBatch) => void;
  logEvent: (event: string, fields: Record<string, unknown>) => void;
}

export async function handleConnectionShardCursorBatchIngress(
  options: ConnectionShardCursorBatchIngressOptions
): Promise<Response> {
  const {
    request,
    traceState,
    currentIngressDepth,
    setIngressDepth,
    nowMs,
    maxTraceHop,
    publishSuppressionMs,
    extendPublishSuppressedUntil,
    readBatch,
    receiveBatch,
    logEvent,
  } = options;
  const fromHub = request.headers.get(CURSOR_HUB_SOURCE_HEADER) === "1";
  const incomingTrace = traceState.readFromRequest(request);

  if (incomingTrace && incomingTrace.traceHop > maxTraceHop) {
    logEvent("cursor_batch_loop_guard_drop", {
      from_hub: fromHub,
      path: "/cursor-batch",
      trace_id: incomingTrace.traceId,
      trace_hop: incomingTrace.traceHop,
      trace_origin: incomingTrace.traceOrigin,
      max_trace_hop: maxTraceHop,
    });
    return new Response(null, { status: 204 });
  }

  if (incomingTrace && traceState.hasSeenRecentTrace(incomingTrace.traceId)) {
    logEvent("cursor_batch_duplicate_trace_drop", {
      from_hub: fromHub,
      path: "/cursor-batch",
      trace_id: incomingTrace.traceId,
      trace_hop: incomingTrace.traceHop,
      trace_origin: incomingTrace.traceOrigin,
    });
    return new Response(null, { status: 204 });
  }

  if (currentIngressDepth() > 0) {
    logEvent("cursor_batch_reentrant_drop", {
      ingress_depth: currentIngressDepth(),
      from_hub: fromHub,
      path: "/cursor-batch",
      ...traceState.traceFields(incomingTrace),
    });
    return new Response(null, { status: 204 });
  }

  setIngressDepth(currentIngressDepth() + 1);
  const previousTrace = traceState.pushActiveTrace(incomingTrace);
  try {
    const batch = await readBatch(request);
    if (!batch || !isValidCursorRelayBatch(batch)) {
      return new Response("Invalid cursor batch payload", { status: 400 });
    }
    if (incomingTrace) {
      traceState.rememberTrace(incomingTrace.traceId);
    }
    logEvent("cursor_batch_ingress", {
      from_hub: fromHub,
      path: "/cursor-batch",
      from: batch.from,
      update_count: batch.updates.length,
      ...traceState.traceFields(incomingTrace),
    });
    receiveBatch(batch);
    return new Response(null, { status: 204 });
  } finally {
    traceState.rememberIngressTraceForPublish(incomingTrace, publishSuppressionMs);
    traceState.restoreActiveTrace(previousTrace);
    setIngressDepth(Math.max(0, currentIngressDepth() - 1));
    extendPublishSuppressedUntil(nowMs() + publishSuppressionMs);
  }
}
