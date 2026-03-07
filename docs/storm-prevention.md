# Event Storm Prevention Guide

This document captures the practices that prevented `Subrequest depth limit exceeded` storms in our Worker + Durable Object topology.

## Scope

This guide is for event paths that can fan out quickly:

- `POST /cursor-batch`
- `POST /tile-batch`
- cross-shard fanout (`ConnectionShardDO` <-> `CursorHubDO`)

## Storm Signature

When a storm starts, logs typically show:

- many `Subrequest depth limit exceeded` errors
- most errors tied to one `requestId`
- repeated calls to the same path (usually `/cursor-batch`)
- very short bursts (hundreds of nested errors in under a few seconds)

## Root Cause Pattern

The common failure mode is request-chain amplification:

1. A DO receives an inbound batch.
2. While handling that request, it synchronously calls another DO.
3. The callee path eventually calls back into the original path (directly or indirectly).
4. The same ancestry chain deepens until Cloudflare rejects it.

Even if each individual call is valid, synchronous chaining can still recurse under load.

## Guardrails That Work

### 1. Separate authoritative state from lossy presence

- Tile/cell writes are authoritative and versioned.
- Cursor presence is lossy and best-effort.
- Never let lossy cursor fanout block or recursively affect authoritative write paths.

### 2. Do not synchronously fan out from ingress handlers

- In `CursorHubDO`, `/publish` now queues fanout and returns `204` immediately.
- Fanout flush runs in detached timer ticks and coalesces updates by uid.
- This breaks deep request ancestry and reduces duplicate fanout volume.

### 3. Add explicit re-entrancy guards on ingress

- `ConnectionShardDO` tracks ingress depth for `/cursor-batch` and `/tile-batch`.
- Re-entrant `/cursor-batch` requests are dropped with `204` and a structured log event.

### 4. Add cooldown suppression after inbound batches

- After ingesting inbound cursor/tile batches, temporarily suppress local relay/publish.
- This avoids immediate echo loops and ping-pong bursts.

### 5. Use loop-trace headers for shard-to-shard push paths

- Tile batch fanout uses hop tracking headers and drops requests past safe hop depth.
- Cursor batch fanout now also carries trace headers:
  - `x-sea-cursor-trace-id`
  - `x-sea-cursor-trace-hop`
  - `x-sea-cursor-trace-origin`
- `ConnectionShardDO` drops traced `/cursor-batch` requests that exceed safe hop depth.
- `ConnectionShardDO` also drops duplicate traced deliveries seen recently on the same shard.
- This provides a hard fail-safe when topology changes accidentally create loops.

### 6. Prefer pull-based convergence for durable state

- Cross-shard tile convergence is done with `ops-since` polling + versions.
- Avoid "push to every shard for every write" as the primary replication mechanism.

### 7. Keep best-effort paths non-fatal

- Cursor fanout and non-critical persistence retries should not hard-fail client comms.
- Log and recover on next poll/snapshot instead of cascading failures.

## Required Regression Tests

Any topology change touching batch fanout should keep these covered:

- Re-entrant ingress drop for `/cursor-batch`.
- Traced `/cursor-batch` hop-limit drop.
- Duplicate traced `/cursor-batch` delivery drop.
- No relay/publish while ingesting inbound cursor batches.
- Cursor hub publish suppressed during inbound cursor/tile batch windows, then resumes.
- Inbound cursor batches are not re-published as outbound hub updates.
- Cursor hub `/publish` returns without waiting for downstream shard fanout.
- Client-visible internal errors include the active cursor trace id when present.

See current tests in:

- `apps/worker/test/worker.connectionShard-websocket.test.ts`
- `apps/worker/test/worker.cursorHub.test.ts`
- `apps/worker/test/connectionShardCursorHubController.test.ts`
- `apps/worker/test/connectionShardCursorBatchIngress.test.ts`
- `apps/worker/test/connectionShardCursorTrace.test.ts`
- `apps/worker/test/connectionShardClientMessageHandler.test.ts`
- `packages/protocol/test/binary.test.ts`
- `packages/protocol/test/messages.server.test.ts`
- `apps/web/test/serverMessages.test.js`

## Logging And Correlation

For cursor storms, the minimum useful correlation data is now:

- Cloudflare `requestId`
- request path
- cursor `trace_id`
- `trace_hop`
- `trace_origin`
- shard name
- whether the request came `from_hub`

Key log events to group on:

- `cursor_batch_ingress`
- `cursor_batch_reentrant_drop`
- `cursor_batch_loop_guard_drop`
- `cursor_batch_duplicate_trace_drop`
- `internal_error`

Client correlation:

- Internal server errors now include the active cursor trace id in the websocket `err` message when available.
- The web client surfaces that as `Error: ... [trace <id>]`.
- If a user reports a trace id from the UI, that trace id should be searchable directly in server logs.

Recommended query order during an incident:

1. Capture three first-pass logs:
   - limited server tail
   - normal-window client log
   - private-window client log
2. Wait about `2 minutes` for Cloudflare stored worker logs to settle before assuming the historical query results are complete.
3. Pivot from the client logs first:
   - compare normal vs private behavior
   - extract client-visible `trace` ids
   - note whether first remote visibility is delayed or asymmetric
4. Group recursion errors by `requestId`.
5. Group relevant logs by `trace_id`.
6. Check whether the same `trace_id` appears with increasing `trace_hop`.
7. If the limited tail is incomplete, use `pnpm logs:server:query` to fetch:
   - the trace-specific rows
   - the full request chain by `requestId`
   - the surrounding failure window by path and event
8. Check for guard events:
   - `cursor_batch_loop_guard_drop`
   - `cursor_batch_duplicate_trace_drop`
   - `cursor_batch_reentrant_drop`
9. If no guard events appear, inspect the ingress or pull path that emitted the first recursive event for that trace.

Recent pull-path captures add one more concrete pattern to check:

- the failure may be asymmetric
- one client can receive remote cursor packets promptly while the reverse direction is delayed by about `60s`
- during that same window, one shard can show successful `cursor_pull_peer` to its watched peer while the reverse shard fails every nested reverse-direction pull with `Subrequest depth limit exceeded`
- if that happens, inspect the failing shard's inbound `GET /cursor-state` request chain first and verify that it did not start timer- or local-activity-driven peer pull work before the current request unwound

What a healthy capture usually shows:

- isolated `cursor_batch_ingress` events
- no repeated `trace_id` across many shards in a tight burst
- near-zero loop-guard and duplicate-trace drops

What a storm capture usually shows:

- one dominant `requestId`
- one or a small number of dominant `trace_id` values
- repeated `/cursor-batch` ingress on the same second
- many `internal_error` records with `Subrequest depth limit exceeded`
- or, on the newer pull path, a narrow watched pair where:
  - one side keeps succeeding on `GET /cursor-state`
  - the reverse side emits `internal_error` / `server_error_sent`
  - the failing side starts nested `cursor_pull_cycle` / `cursor_pull_peer` work inside inbound `/cursor-state`

## Review Checklist (PRs)

Before merging any fanout/topology change:

1. Could this create synchronous DO->DO->DO cycles in one request chain?
2. Is ingress guarded against re-entry?
3. Are outbound fanout actions detached from inbound request lifecycle?
4. Is there a suppression window after ingesting remote batches?
5. Are loop-trace headers propagated on every shard-to-shard push path?
6. Are logs structured enough to isolate a single storm by `requestId`, path, and `trace_id`?
7. Does the client surface a trace id for actionable internal errors?
8. Are regression tests updated for the changed flow?

## Incident Response (Quick)

1. Capture limited server tail plus two client logs: normal window and private window (`docs/debug-log-capture.md`).
2. Wait about `2 minutes` for Cloudflare historical worker logs to settle.
3. Group by `requestId`, path, `trace_id`, and message.
4. If the client captured `[trace ...]`, pivot historical worker logs to that trace immediately with `pnpm logs:server:query`.
5. If one `requestId` dominates recursion errors, treat as request-chain loop.
6. Verify whether the path is ingress, fanout, or nested pull and disable/decouple the synchronous part first.
7. In paired-client runs, verify whether the issue is directional:
   - one side receives remote cursors promptly
   - the other side waits about `30-60s` or fails entirely
   - if so, inspect the failing shard's inbound `/cursor-state` chains before widening the search
8. Deploy fix with added guard + test before re-enabling full fanout.
