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
- No relay/publish while ingesting inbound cursor batches.
- Cursor hub publish suppressed during inbound cursor/tile batch windows, then resumes.
- Inbound cursor batches are not re-published as outbound hub updates.
- Cursor hub `/publish` returns without waiting for downstream shard fanout.

See current tests in:

- `apps/worker/test/worker.connectionShard-websocket.test.ts`
- `apps/worker/test/worker.cursorHub.test.ts`
- `apps/worker/test/connectionShardCursorHubController.test.ts`

## Review Checklist (PRs)

Before merging any fanout/topology change:

1. Could this create synchronous DO->DO->DO cycles in one request chain?
2. Is ingress guarded against re-entry?
3. Are outbound fanout actions detached from inbound request lifecycle?
4. Is there a suppression window after ingesting remote batches?
5. Are logs structured enough to isolate a single storm by `requestId` and path?
6. Are regression tests updated for the changed flow?

## Incident Response (Quick)

1. Capture server + client logs (`docs/debug-log-capture.md`).
2. Group by `requestId`, path, and message.
3. If one `requestId` dominates recursion errors, treat as request-chain loop.
4. Verify whether the path is ingress or fanout and disable/decouple synchronous fanout first.
5. Deploy fix with added guard + test before re-enabling full fanout.
