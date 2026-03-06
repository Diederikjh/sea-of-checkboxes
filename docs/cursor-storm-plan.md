# Cursor Storm Migration Plan

This plan turns cursor replication from hub-push fanout into pull-based convergence, while keeping the existing system deployable in batches.

## Problem Summary

We still see real cursor storms in production-like captures:

- `Subrequest depth limit exceeded`
- one dominant `requestId`
- repeated `POST /cursor-batch`
- hub-originated ingress, usually `shard-4 -> shard-2`

The current repo already contains part of the fix:

- adaptive cursor pull via `GET /cursor-state`
- guardrails on `/cursor-batch`
- trace IDs and client/server error correlation

But the dangerous push path is still live:

- `ConnectionShardCursorHubController` still calls hub `/publish`
- `CursorHubDO` still fans out `/cursor-batch`
- cursor pull is disabled whenever the hub controller is enabled

That leaves the system in a half-migrated state where the storm-prone topology still handles live traffic.

## Goal

Keep `CursorHubDO` only for watch membership and related best-effort metadata. Remove hub-driven cursor update fanout from normal operation. Make remote cursor state converge through adaptive pull from peer shards.

## Target Architecture

### Authoritative ownership

- Each `ConnectionShardDO` is authoritative for cursors of clients directly connected to that shard.
- Remote cursor state is cached, lossy, and TTL-based.

### Cross-shard propagation

- No shard pushes cursor updates to other shards during normal operation.
- Shards pull remote cursor snapshots with `GET /cursor-state`.
- Polling is adaptive:
  - fast while cursor activity is hot
  - slower when repeated polls are quiet
  - wakes immediately on new local interaction

### Hub role

- `CursorHubDO` keeps watch membership only.
- `CursorHubDO` may continue to support recent-edit activity or spawn sampling if needed.
- `CursorHubDO /publish` and normal `/cursor-batch` fanout are retired.

## Migration Phases

### Phase 0: Lock current behavior down (DONE)

Purpose:
- stabilize the current branch before cutting over topology

Work:
- keep current storm guards in place
- keep adaptive cursor pull tests green
- record the current expected behavior in tests before changing control flow

Exit criteria:
- current cursor tests pass
- current logging remains intact during migration

### Phase 1: Make the hub watch-only (DONE)

Purpose:
- stop sending live cursor updates through the storm-prone hub path

Code changes:
- remove publish scheduling from `apps/worker/src/connectionShardCursorHubController.ts`
- remove `publishLocalCursors()` from `apps/worker/src/cursorHubGateway.ts`
- stop calling `markLocalCursorDirty()` for hub publish in `apps/worker/src/connectionShardDO.ts`
- keep `watchShard()` and watch renewal behavior

Behavior changes:
- local cursor movement only updates local shard state
- hub watch state remains active for shard membership

Exit criteria:
- no normal cursor interaction issues `POST /publish`
- no normal cursor interaction issues `POST /cursor-batch`
- watch registration still works

Tests:
- update `apps/worker/test/connectionShardCursorHubController.test.ts`
  - remove publish scheduling assertions
  - keep watch renew / sub / unsub coverage
- update `apps/worker/test/worker.cursorHub.test.ts`
  - reduce scope to watch behavior only
- add regression in `apps/worker/test/worker.connectionShard-websocket.test.ts`
  - local cursor movement does not publish through the hub

### Phase 2: Enable cursor pull even when the hub exists

Purpose:
- make pull the primary live path immediately after hub publish is removed

Code changes:
- in `apps/worker/src/connectionShardDO.ts`, stop disabling cursor pull when the hub controller is enabled
- gate cursor pull on:
  - clients connected
  - at least one peer shard to poll
  - no active local cursor-state ingress conflict

Behavior changes:
- live remote cursor visibility comes from peer `GET /cursor-state`
- adaptive polling stays active whether or not the hub namespace is configured

Exit criteria:
- remote cursors still appear across shards after hub publish removal
- adaptive backoff still works
- no push-path traffic is required for cursor visibility

Tests:
- update `apps/worker/test/worker.connectionShard-websocket.test.ts`
  - remote cursor appears via pull, not push
  - pull wakes on local activity
  - quiet periods back off polling
- add regression:
  - hub configured + publish disabled still results in active pull

### Phase 3: Narrow peer polling to watched shards

Purpose:
- reduce cost once pull is primary

Code changes:
- change hub watch response to return peer shard membership or equivalent watch scope
- cache that scope in `ConnectionShardDO`
- poll only relevant peer shards instead of all peers from static topology

Behavior changes:
- adaptive pull is scoped to shards that currently matter
- idle cost drops without restoring push recursion risk

Exit criteria:
- shard polls only watched peers
- remote cursor visibility remains correct during subscribe/unsubscribe churn

Tests:
- add targeted tests for watched-peer scoping
- add reconnect / rebuild coverage so watched-peer scope refreshes correctly
- verify no polling occurs to irrelevant peers

### Phase 4: Retire push-only compatibility code

Purpose:
- delete storm-prone code once pull has proven stable

Code changes:
- remove hub `/publish` handler from `apps/worker/src/cursorHubDO.ts`
- remove `publishLocalCursors()` protocol from the hub gateway
- remove normal `/cursor-batch` fanout code paths
- keep a minimal compatibility ingress only if deployment sequencing requires it

Behavior changes:
- `/cursor-batch` is no longer part of the normal cursor architecture
- loop-trace headers become unnecessary for normal cursor replication

Exit criteria:
- no deployed path can generate cursor fanout recursion
- captures show only pull-based cursor replication

Tests:
- delete or demote push-specific tests once no production path uses them
- keep only compatibility coverage if any fallback remains

## Test Matrix

### Tests to add

- local cursor movement does not call hub publish
- remote cursor visibility is established by `GET /cursor-state`
- cursor pull remains active when hub watch is enabled
- quiet cursor pull backs off
- local cursor activity reheats cursor pull immediately
- watched-peer polling only touches relevant shards
- remote cursor TTL expiry removes stale peers when polling stops
- peer pull failures stay best-effort and do not surface client errors

### Tests to update

- `apps/worker/test/worker.connectionShard-websocket.test.ts`
- `apps/worker/test/connectionShardCursorHubController.test.ts`
- `apps/worker/test/worker.cursorHub.test.ts`

### Tests to keep temporarily

- `apps/worker/test/connectionShardCursorBatchIngress.test.ts`
- `apps/worker/test/connectionShardCursorTrace.test.ts`

These should remain until `/cursor-batch` is no longer reachable in a real deployment path.

### Tests to remove later

- any regression that exists only to protect hub cursor publish fanout
- push-path trace propagation tests once push is fully retired

## Rollout Notes

### Safest first batch

The lowest-risk first implementation batch is:

1. make the hub controller watch-only
2. enable cursor pull even with hub configured
3. keep current `/cursor-batch` guards as deadman switches
4. ship with focused regression coverage

This should materially reduce storm risk without needing the full watched-peer optimization first.

### Operational checks after each batch

- check Cloudflare logs for any fresh `Subrequest depth limit exceeded`
- check whether any normal cursor interaction still emits `POST /cursor-batch`
- verify client CPU drops during idle periods
- verify remote cursors still appear and expire correctly

## Open Questions

- Should watched-peer scope be returned directly by `/watch`, or derived from another hub endpoint?
- Do we want a temporary feature flag for hub publish removal, or is direct cutover acceptable in this environment?
- Is recent-edit activity still worth keeping in `CursorHubDO`, or should that also move out of the hub later?

## First Execution Batch

Implement next:

1. remove hub cursor publish from `ConnectionShardCursorHubController`
2. remove hub publish API usage from `ConnectionShardCursorHubGateway`
3. allow adaptive cursor pull to run while hub watch remains enabled
4. update websocket, hub controller, and hub tests to match the new flow
