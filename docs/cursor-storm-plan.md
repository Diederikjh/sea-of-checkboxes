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

## Current Status

Phase 1 is now deployed and has changed the traffic shape in live captures:

- repo server tail is now dominated by `GET /cursor-state`
- normal hub watch traffic is still present
- the old hub-push `/cursor-batch` pattern is not visible in the latest repo tail

Latest observations from `2026-03-07` captures:

- latest repo server tail showed `207` `GET /cursor-state` requests
- the same tail showed `0` `/cursor-batch`, `0` `Subrequest depth limit exceeded`, and `0` `server_error_sent`
- clients still received websocket `err {"code":"internal","msg":"Failed to process message"}` packets
- one normal-window rebuild took `8442ms`
- rebuild blocking still worked, and some `setCell` failures happened only after rebuild completion
- attached `2026-03-07T06:08:38.982Z` capture showed `784` `GET /cursor-state` requests
- that same capture touched `8` distinct `ConnectionShardDO` instances on the pull path
- the same capture still showed `0` `/cursor-batch`
- all `3` `Subrequest depth limit exceeded` records in that capture were on `GET /cursor-state`
- `2` of those recursion errors surfaced as `internal_error` and `server_error_sent` on `shard-1`
- the same capture showed only two `sub` events while pull traffic still spanned all `8` shard DOs
- raw server capture `2026-03-07T06:49:53.794Z` contained `1296` rows, including `286` `cursor_pull_cycle` and `286` `cursor_pull_peer`
- that raw capture only involved `2` shard DOs on the pull path: `shard-3` and `shard-4`
- watched-peer scoping was active in that capture: `cursor_pull_scope` showed `shard-3 -> ["shard-4"]`, then `[]` after unsubscribe
- despite scoped peers, `shard-4 -> shard-3` still failed `117` of `159` peer pulls with `Subrequest depth limit exceeded`
- all `6` `internal_error` and `6` `server_error_sent` records in that raw capture were on `shard-4`, all triggered by `GET /cursor-state`, all for `uid` `u_193c7c1f`
- the same raw capture showed `4` `sub` and `4` `subAck` events in about `17s`, all with `changed_count: 0`
- matching client logs showed first remote `curUp` about `60s` after `hello` on both clients, not immediately after the first `subAck`

Interpretation:

- the plan direction is still correct
- Phase 1 reduced or removed the visible hub-push path in the latest repo capture
- the remaining bottleneck is no longer broad all-peer polling; it is a scoped but still-recursive mutual pull loop between watched peers
- watched-peer scoping worked in the latest raw capture, but timer/local-activity reheats still let a `2`-shard pair recurse hard enough to hit the subrequest limit
- repeated `sub` / `subAck` with `changed_count: 0` plus delayed first `curUp` means rebuild or resubscribe churn is now part of the failure mode
- peer pull failures still need to stay best-effort and must not surface websocket `internal` errors during normal cursor sync
- Phase 3 is implemented in repo, but its live exit criteria are not yet met in Cloudflare logs

Repo status after the current implementation batch:

- Phase 3 is now implemented in repo
- hub `/watch` now returns both snapshot data and peer shard scope
- `ConnectionShardDO` now caches watched peer scope and polls only those peers when the hub is enabled
- cursor pull now uses jittered timer scheduling and capped peer concurrency
- structured `cursor_pull_scope`, `cursor_pull_peer`, and `cursor_pull_cycle` logs now exist for pull-path observability
- worker regressions now cover watched-peer scoping, concurrency caps, jittered polling, and non-fatal pull failures
- live validation still shows one unresolved production-side pattern:
  - reciprocal `shard-3 <-> shard-4` pull loops
  - repeated `subAck` churn with no actual subscription change
  - delayed first remote cursor visibility
  - client-visible `internal` errors still triggered by pull-path recursion

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

Status:
- implemented
- latest repo tail confirms pull is now the dominant visible cursor path

### Phase 3: Narrow peer polling to watched shards and dampen pull bursts

Purpose:
- reduce cost now that pull is primary
- avoid broad synchronized polling bursts across shards

Code changes:
- change hub watch response to return peer shard membership or equivalent watch scope
- cache that scope in `ConnectionShardDO`
- poll only relevant peer shards instead of all peers from static topology
- add jitter and/or concurrency caps so peer pulls do not run in lockstep
- ensure adaptive pull backs off aggressively when repeated polls are quiet
- keep immediate reheating when real local interaction resumes

Behavior changes:
- adaptive pull is scoped to shards that currently matter
- idle cost drops without restoring push recursion risk
- rebuilds and reconnects should not trigger broad all-peer pull bursts
- pull-path failures remain best-effort and do not surface websocket `internal` errors to clients

Exit criteria:
- shard polls only watched peers
- shard does not fan out all-peer pull cycles during steady-state idle
- single-client subscribe or rebuild flows do not wake a full `8`-shard pull mesh
- remote cursor visibility remains correct during subscribe/unsubscribe churn
- rebuild latency drops from the current worst-case multi-second path
- client idle CPU is materially lower during no-change periods
- pull-path failures do not emit client-visible `server_error_sent` / `internal` websocket errors

Tests:
- add targeted tests for watched-peer scoping
- add reconnect / rebuild coverage so watched-peer scope refreshes correctly
- verify no polling occurs to irrelevant peers
- add coverage for jitter / capped scheduling behavior at the controller level
- add coverage that quiet polling backs off even when many peers exist
- add coverage that local activity reheats only the relevant polling scope
- add coverage that pull failures stay best-effort and do not emit websocket `server_error_sent`
- add coverage that jitter / concurrency caps prevent lockstep all-peer pull bursts

Status:

- implemented in repo
- targeted worker tests now cover:
  - watched-peer polling only touching relevant shards
  - quiet pull backoff with scoped peers
  - local activity reheating scoped pull immediately
  - capped in-flight peer pulls
  - jitter delaying timer-driven pull ticks
  - pull failures remaining non-fatal to websocket clients
- not yet validated in live captures:
  - latest raw server logs still show scoped `2`-shard recursion
  - latest client logs still show delayed first remote `curUp`
  - latest live captures still show client-visible `internal` websocket errors on the pull path

### Phase 3b: Break reciprocal pull loops and rebuild churn

Purpose:
- eliminate the remaining `2`-shard recursive pull failure mode
- reduce first-visibility latency after subscribe or rebuild
- stop redundant steady-state resubscribe / `subAck` churn

Code changes:
- ensure remote cursor application does not reheat peer polling as if it were fresh local activity
- enforce a stricter minimum interval / single-flight guard so timer wakes cannot pile up into near-lockstep reciprocal pulls
- avoid immediately re-arming pull on unchanged scoped peer results
- add rebuild / resubscribe observability so repeated `subAck` with `changed_count: 0` can be tied to a concrete restart reason
- include request or trace correlation on client-visible internal errors from the pull path

Behavior changes:
- a watched `A <-> B` pair must not recurse during normal operation
- first remote cursor visibility should happen promptly after watch scope and subscription are established
- stable subscriptions should not emit repeated `subAck` responses with no effective change
- pull-path failures must remain diagnosable server-side without degrading one client's cursor stream

Exit criteria:
- no `Subrequest depth limit exceeded` in scoped `2`-shard pull captures
- no client-visible `server_error_sent` / `internal` websocket errors caused by `GET /cursor-state`
- first remote `curUp` arrives within a short bounded interval after initial subscribe / rebuild, not about `60s` later
- steady-state logs do not show repeated `subAck` churn with `changed_count: 0`
- scoped peer polling remains narrow after reconnect / unsubscribe transitions

Tests:
- add regression coverage that reciprocal watched peers do not recursively reheat each other
- add coverage that remote cursor ingestion does not count as local activity for pull wake purposes
- add coverage for stricter timer floor / single-flight pull scheduling
- add rebuild coverage for suppressing redundant steady-state `subAck`
- add coverage that client-visible internal errors carry usable request or trace correlation

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

### Updated priority after Phase 1

The next batch should not be treated as optional tuning.

Based on the latest `2026-03-07` captures:

- peer-scoped polling was the right topology change and is now implemented
- the next priority is breaking scoped reciprocal pull loops:
  - stronger single-flight guarantees
  - stricter minimum timer cadence
  - preventing remote-ingress work from masquerading as local reheat
- rebuild / resubscribe churn now needs the same priority as pull dampening
- client-visible pull-path errors are still a correctness issue, not just an observability gap
- error correlation still needs improvement because the client currently sees `trace:null` even when the server has concrete `requestId`s

The practical ordering is now:

1. validate scoped polling in raw server logs
2. break reciprocal `2`-shard pull recursion
3. suppress rebuild / resubscribe churn
4. make client-visible pull errors fully correlated
5. only then consider deleting more compatibility code

Phase 3 code landed in repo, but the latest Cloudflare logs show that validation is not yet complete. Phase 3b is now the gate before deleting more compatibility code.

### Operational checks after each batch

- check Cloudflare logs for any fresh `Subrequest depth limit exceeded`
- check whether any normal cursor interaction still emits `POST /cursor-batch`
- check whether any `GET /cursor-state` failure surfaced as websocket `internal` / `server_error_sent`
- check whether a small watched peer set still degenerates into reciprocal `A <-> B` pull loops
- check whether repeated `subAck` with `changed_count: 0` is still happening during steady state
- check whether first remote cursor visibility is still delayed after initial subscribe or rebuild
- verify client CPU drops during idle periods
- verify remote cursors still appear and expire correctly

## Open Questions

- Should watched-peer scope be returned directly by `/watch`, or derived from another hub endpoint?
- Do we want a temporary feature flag for hub publish removal, or is direct cutover acceptable in this environment?
- Is recent-edit activity still worth keeping in `CursorHubDO`, or should that also move out of the hub later?
- Should pull-cycle logging live in `ConnectionShardDO` directly, or in a dedicated cursor pull controller extracted from it?

## Next Execution Batch

Implement next:

1. implement Phase 3b follow-up work for reciprocal pull loops and rebuild churn
2. add the new regressions for reciprocal watched peers, timer floors, and redundant `subAck`
3. redeploy and validate against raw Cloudflare server logs plus paired client logs
4. confirm that first remote cursor visibility is prompt and that `GET /cursor-state` no longer surfaces websocket `internal` / `server_error_sent`
5. only if that validation is clean, start Phase 4 and trim the now-redundant push-path tests
