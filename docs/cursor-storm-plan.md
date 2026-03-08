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
- raw ramp-up capture `2026-03-07T10:01:10.757Z` showed a healthy scoped topology before failure:
  - `shard-5 -> ["shard-6"]`
  - `shard-4 -> ["shard-5", "shard-6"]`
  - `93` `cursor_pull_peer`, `0` pull errors, `0` `internal_error`, `0` `server_error_sent`
- that same ramp-up capture still showed repeated subscribe churn:
  - `46` `sub`
  - `10` `subAck`
  - several of those lived on the websocket `GET /ws` request chain
- raw failure-window capture `2026-03-07T09:58:53.037Z` showed the topology widen into a watched three-shard mesh centered on `shard-6`
- in that failure sample:
  - `shard-6` polled both `shard-4` and `shard-5` successfully (`178/178` peer pulls ok)
  - `shard-4` polled both `shard-6` and `shard-5` and failed `94/108` peer pulls
  - `shard-5` polled `shard-6` and failed `47/51` peer pulls
  - all failures were `Subrequest depth limit exceeded`
- the new client-visible trace IDs now correlate cleanly to raw server failures:
  - client trace `ctrace_2987a7d4-ab82-4b37-b392-53f71021d6ab` maps to `shard-4` `internal_error` / `server_error_sent`
  - client trace `ctrace_50ef5ffb-712b-48d8-9e11-9499acdfb6b5` maps to `shard-5` `internal_error` / `server_error_sent`
- the request ancestry is now clearer in raw logs:
  - many ramp-up `cursor_pull_peer` records ran under websocket `GET /ws` request ids
  - failure-window `cursor_pull_peer`, `internal_error`, and `server_error_sent` records all ran under `GET /cursor-state`
- targeted historical queries using `pnpm logs:server:query` now confirm the missing backend detail for client-visible traces:
  - client trace `ctrace_2987a7d4-ab82-4b37-b392-53f71021d6ab` resolves to request `3JKQL8WFLCMNOL0X` on `shard-4`
  - client trace `ctrace_50ef5ffb-712b-48d8-9e11-9499acdfb6b5` resolves to request `X1ZEYMS33CR1H9KH` on `shard-5`
  - in both cases the incoming request is already `GET /cursor-state` with `x-sea-cursor-pull: 1` and `x-sea-cursor-trace-origin: shard-6`
  - while handling that incoming pull, the target shard still starts local `cursor_pull_cycle` work and issues failing `cursor_pull_peer` calls back out to peers
  - only after those nested peer pulls fail with `Subrequest depth limit exceeded` do we emit `internal_error` and `server_error_sent`
- latest paired multi-window run (`2026-03-07T20:17Z`) shows the remaining failure in a simpler watched pair:
  - private-window client received the main-window cursor quickly: first tag `105` at `2026-03-07T20:17:45.292Z`, about `2.5s` after `hello`
  - main-window client did not receive the private-window cursor until `2026-03-07T20:18:25.325Z`, about `60.2s` after `hello`
  - the private-window client then received `8` websocket `internal` errors from `20:18:26.893Z` through `20:18:30.610Z`
- the matching limited repo server tail for that run was dominated by `https://connection-shard.internal/cursor-state` and showed a live `shard-4 <-> shard-1` pull pair around `20:18:25Z`
- targeted historical worker queries for the same window confirm:
  - `37` `cursor_pull_cycle`
  - `37` `cursor_pull_peer`
  - `5` `internal_error`
  - `5` `server_error_sent`
  - all `5` pull-path client-visible errors were on `shard-1` under `GET /cursor-state`
  - in the same window, `shard-4 -> shard-1` `cursor_pull_peer` remained successful while `shard-1 -> shard-4` repeatedly failed with `Subrequest depth limit exceeded`
  - request `M0T0FQWIQMGHGBXP` shows the exact failing shape:
    - inbound `GET /cursor-state` arrives on `shard-1` with `x-sea-cursor-pull: 1` and `x-sea-cursor-trace-origin: shard-4`
    - while still handling that request, `shard-1` emits `cursor_pull_cycle`
    - the nested `shard-1 -> shard-4` `cursor_pull_peer` fails immediately with recursion
    - then `internal_error` and `server_error_sent` are emitted for the same request
  - `shard-4` also emitted a no-op `subAck` under `GET /cursor-state` at `2026-03-07T20:18:31.738Z` with `changed_count: 0`

Interpretation:

- the plan direction is still correct
- Phase 1 reduced or removed the visible hub-push path in the latest repo capture
- the remaining bottleneck is no longer broad all-peer polling; it is a scoped but still-recursive mutual pull loop between watched peers
- watched-peer scoping worked in the latest raw capture, but timer/local-activity reheats still let a small watched topology recurse hard enough to hit the subrequest limit
- the newer raw captures refine that further:
  - the failure mode is not just a `2`-shard pair
  - it can widen into a watched `3`-shard mesh where one shard succeeds while two others recurse against it
  - we should treat those as examples of a more general watched-graph storm risk, not as the upper bound of the problem
- repeated `sub` / `subAck` with `changed_count: 0` plus delayed first `curUp` means rebuild or resubscribe churn is now part of the failure mode
- the raw `requestId` / `trigger` fields strongly suggest pull ticks are still executing on live websocket or cursor-state request ancestry instead of a fully detached background context
- the new historical query results make that stricter:
  - pull is not only correlated with incoming `/cursor-state`
  - in the failing traces, nested peer polling is actually happening inside the active `/cursor-state` request chain
- the latest paired run adds a directional symptom:
  - one watched direction can still look healthy while the reverse direction is delayed by about `60s` and then fails
  - we need to treat one-way visibility plus reverse-direction recursion as an explicit validation failure, not as partial success
- peer pull failures still need to stay best-effort and must not surface websocket `internal` errors during normal cursor sync
- Phase 3 is implemented in repo, but its live exit criteria are not yet met in Cloudflare logs

Repo status after the current implementation batch:

- Phase 3 is now implemented in repo
- hub `/watch` now returns both snapshot data and peer shard scope
- `ConnectionShardDO` now caches watched peer scope and polls only those peers when the hub is enabled
- cursor pull now uses jittered timer scheduling and capped peer concurrency
- structured `cursor_pull_scope`, `cursor_pull_peer`, and `cursor_pull_cycle` logs now exist for pull-path observability
- worker regressions now cover watched-peer scoping, concurrency caps, jittered polling, and non-fatal pull failures
- repo now adds tile-sync observability for the next reliability pass:
  - client `setCell` outbox logs explicit `setcell_sync_wait_started`, `setcell_sync_wait_replayed`, `setcell_sync_wait_cleared`, and `setcell_sync_wait_dropped` events with `tile`, `i`, `op`, `cid`, elapsed wait time, and outcome reason
  - client `click_blocked` logs now retain the sync guard `cid` and UI message when the app tells the user it is `waiting for sync`
  - `ConnectionShardDO` now logs `setCell_received` before the existing `setCell` result log so client wait state can be correlated with shard ingress and tile-owner commit
- repo now adds maintenance cleanups that are already landed and covered:
  - `ConnectionShardDO` scheduled pull is detached through DO alarms
  - `setCell` client outbox sync-wait logging is factored into smaller helpers
  - worker `setCell` ingress/result logging shares one base field builder
  - `app.js` subscription rebuild tracking now lives in a dedicated helper
- the worker historical log query script is now operational for this workflow:
  - it reads `CLOUDFLARE_LOG_QUERY_*` directly from `.env.local`
  - it can be used after the usual `~2 minute` settle delay without manually exporting env vars in the shell
- live validation still shows one unresolved production-side pattern:
  - scoped recursive pull meshes (`shard-3 <-> shard-4` in one run, `shard-4/shard-5/shard-6` in another)
  - repeated `subAck` churn with no actual subscription change
  - delayed first remote cursor visibility
  - client-visible `internal` errors still triggered by pull-path recursion
- Phase 3b scheduler and trace fixes are now implemented in repo:
  - cursor pull wakeups are coalesced behind a real minimum interval instead of repeated `clear + schedule(0)` churn
  - local cursor activity now reheats pull promptly without opening a sustained hot window on every heartbeat
  - pull requests now carry trace headers, and fallback trace IDs are attached to client-visible internal errors even when no active cursor trace exists
  - inbound `GET /cursor-state` now defers queued pull wakes until after the request unwinds instead of re-arming timer or local-activity pull work inside the live ingress chain
  - live Cloudflare logs then showed that ingress deferral alone was not enough: request `6T6C1TH6HFXZSAXO` on `shard-7` still emitted nested `cursor_pull_cycle` (`timer`, then `local_activity`) and `cursor_pull_peer` back to `shard-4` under the same inbound `GET /cursor-state` chain
  - repo now adds a short post-ingress pull suppression window so reverse-direction peer pull cannot immediately restart off the tail of an inbound pulled `/cursor-state`
  - repo now routes scheduled cursor pull through a Durable Object alarm so peer polling runs from a detached DO event instead of directly from the in-memory wake callback/request invocation
  - worker regressions now cover local reheat coalescing, fallback internal-error trace correlation, the post-ingress suppression of timer and local-activity reverse pull, and detached alarm-backed pull dispatch
  - the latest `2026-03-08T07:41Z` paired run was more stable client-side:
    - no client-visible `internal` or `server_error_sent`
    - but first remote cursor visibility was still slow (`~59.9s` on one client, `~71.7s` on the other)
    - repeated `subAck` churn remained (`11` and `10` `subAck` respectively)
    - one side only received a short sparse visibility window (`12` remote cursor updates over `~31.2s`)
    - raw worker logs still showed late hidden recursion: `shard-4 -> shard-2` `cursor_pull_peer` hit `Subrequest depth limit exceeded` at `07:43:43.368Z` and `07:43:44.292Z` without surfacing websocket errors
  - the latest `2026-03-08T10:16Z` paired run improved again:
    - both clients saw each other's cursors
    - no client-visible errors
    - historical worker logs showed `0` `cursor_pull_peer`, `0` `internal_error`, and `0` `server_error_sent` in the observed window
    - repeated `subAck` churn still remained (`11` and `10` `subAck`)
    - the later user-visible `waiting for sync` symptom around `10:23Z` now looks more like tile sync latency than cursor storm:
      - affected `setCell` operations still succeeded
      - but a few writes took `~0.6s` to `~1.1s`
      - tile batch duplicate/replay anomalies were logged on the same window
  - the latest `2026-03-08T13:26Z` paired run strengthens that conclusion:
    - no visible cursor delay was reported during the run
    - client logs showed no `internal` or `server_error`
    - Cloudflare historical worker logs showed `0` `internal_error`, `0` `server_error_sent`, `0` `cursor_pull_peer`, and `0` `cursor_pull_cycle` in the inspected window
    - client `setcell_sync_wait_*` instrumentation showed all observed write waits clearing successfully:
      - one client had `44` starts and `44` clears with `~358ms` median wait and `1299ms` max
      - the other had `64` starts and `64` clears with `~331ms` median wait and `958ms` max
    - the visible `waiting for sync` moments in that run mostly matched short `click_blocked` subscription-rebuild guards rather than stuck writes
    - the only backend anomaly found in the same window was a single `tile_batch_order_anomaly` with `kind: "duplicate_or_replay"` for the same version/op payload
    - the limited tail still showed a few slower `TileOwnerDO setCell` commits (`~556ms`, `~572ms`, `~1010ms`), which now looks like the more likely source of the remaining user-visible sync waits

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
- eliminate recursive pull failure modes across any watched shard topology, from small pairs up to the full shard set
- reduce first-visibility latency after subscribe or rebuild
- stop redundant steady-state resubscribe / `subAck` churn

Code changes:
- ensure pull execution is detached from websocket and cursor-state request ancestry rather than running under active `GET /ws` or `GET /cursor-state` chains
- ensure `/cursor-state` ingress itself never directly starts nested peer pull work before the current request unwinds
- ensure remote cursor application does not reheat peer polling as if it were fresh local activity
- enforce a stricter minimum interval / single-flight guard so timer wakes cannot pile up into near-lockstep recursive pulls across the watched graph
- avoid immediately re-arming pull on unchanged scoped peer results
- add rebuild / resubscribe observability so repeated `subAck` with `changed_count: 0` can be tied to a concrete restart reason
- include request or trace correlation on client-visible internal errors from the pull path

Behavior changes:
- watched peer graphs must not recurse, amplify, or synchronize into storm behavior during normal operation, even as additional peers enter scope
- `A <-> B` and `A/B/C` failures remain useful regression examples, but they are not the design limit
- pull ticks must not inherit websocket or cursor-state request ancestry deeply enough to hit the subrequest limit
- handling an inbound `GET /cursor-state` must not immediately trigger another outbound peer poll burst inside that same request chain
- handling an inbound `GET /cursor-state` must not start timer- or local-activity-driven peer pull work before that request unwinds
- first remote cursor visibility should happen promptly after watch scope and subscription are established
- remote cursor visibility must be prompt in both directions across a watched pair, not only on one side
- stable subscriptions should not emit repeated `subAck` responses with no effective change
- pull-path failures must remain diagnosable server-side without degrading one client's cursor stream

Exit criteria:
- no `Subrequest depth limit exceeded` in scoped pull captures across representative watched topologies, up to the full shard set used in production
- no client-visible `server_error_sent` / `internal` websocket errors caused by `GET /cursor-state`
- first remote `curUp` arrives within a short bounded interval after initial subscribe / rebuild, not about `60s` later
- watched peers do not show one-way success where `A -> B` visibility is prompt but `B -> A` visibility is delayed or fails
- steady-state logs do not show repeated `subAck` churn with `changed_count: 0`
- scoped peer polling remains narrow after reconnect / unsubscribe transitions
- adding more watched peers does not turn narrow pull into synchronized or recursive graph-wide traffic
- raw logs show pull work running from detached background context rather than on long-lived `GET /ws` or nested `GET /cursor-state` request chains

Tests:
- add regression coverage that reciprocal watched peers do not recursively reheat each other
- add regression coverage that a watched three-shard topology does not create recursive pull ancestry through a shared peer
- add regression coverage for wider watched topologies, including star and near-full-shard watch sets, with bounded pull scheduling and no recursive amplification
- add regression coverage that `/cursor-state` ingress does not directly recurse into nested outbound peer polls
- add regression coverage that inbound `/cursor-state` on one side of a watched pair cannot start a reverse-direction pull cycle from timer or local-activity wake in the same request chain
- add coverage that remote cursor ingestion does not count as local activity for pull wake purposes
- add coverage for stricter timer floor / single-flight pull scheduling
- add coverage for detached pull execution so scheduler wake callbacks do not issue peer fetches directly
- add rebuild coverage for suppressing redundant steady-state `subAck`
- add coverage that client-visible internal errors carry usable request or trace correlation

Status:

- implemented in repo
- worker regressions now cover:
  - local cursor reheats coalescing behind the stricter timer floor
  - repeated local cursor activity not stacking immediate pull bursts
  - deferred cursor-pull wake flushing after `/cursor-state` ingress exits
  - short post-ingress suppression of timer-driven reverse pull after inbound pulled `/cursor-state`
  - short post-ingress suppression of local-activity reverse pull after inbound pulled `/cursor-state`
  - detached alarm-backed dispatch before issuing cursor-state peer pulls
  - fallback trace propagation on internal websocket errors without an active cursor trace
- still pending live validation:
  - confirm the new alarm-backed detached dispatch plus post-ingress suppression removes same-request nested reverse pull in raw Cloudflare logs
  - confirm representative watched topologies no longer recurse in raw Cloudflare logs
  - confirm first remote `curUp` latency drops in paired client logs in both directions
  - confirm repeated steady-state `subAck` churn is reduced or at least better explained by the new logs

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
- later hardening may add per-source cursor version watermarks or short-lived per-peer send caches so stale out-of-order remote cursor payloads can be ignored cheaply
- any such cache must remain best-effort only and must not become the primary protection against pull recursion or request-ancestry storms

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
- representative watched topologies up to near-full shard count stay single-flight and non-recursive
- multi-client validation scales beyond the paired-browser case:
  - around `5` concurrent users
  - around `10` concurrent users
  - a higher-stress case approaching `100` concurrent users or the highest practical local test load
- client sync-wait diagnostics stay correlated across:
  - `click_blocked` / UI guard logs
  - client outbox `setcell_sync_wait_*` lifecycle logs
  - worker `setCell_received` and `setCell` result logs
- later hardening: stale remote cursor versions are ignored without reheating pull or replaying older state over newer state

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
- the next priority is breaking scoped recursive pull graphs:
  - stronger single-flight guarantees
  - stricter minimum timer cadence
  - preventing remote-ingress work from masquerading as local reheat
- the raw server logs now add a stricter requirement:
  - pull work must run detached from websocket and cursor-state request ancestry
- rebuild / resubscribe churn now needs the same priority as pull dampening
- client-visible pull-path errors are still a correctness issue, not just an observability gap
- the latest paired run narrows the immediate bug further:
  - `shard-4 -> shard-1` can succeed repeatedly while `shard-1 -> shard-4` recurses in one run, and `shard-4 -> shard-7` can succeed repeatedly while `shard-7 -> shard-4` recurses in another
  - ingress deferral alone was insufficient: inbound `/cursor-state` on `shard-7` still started nested reverse-direction `timer` and `local_activity` pull work inside request `6T6C1TH6HFXZSAXO`
  - no-op `subAck` can still be emitted during `GET /cursor-state`
  - the latest `2026-03-08T07:41Z` paired run improves one thing but confirms two others:
    - client-visible websocket errors can now stay suppressed even when backend pull recursion still happens
    - delayed first remote visibility remains unacceptable (`~60s` / `~72s`)
    - a client can still receive only a short-lived sparse remote cursor stream before visibility drops again
  - the latest `2026-03-08T10:16Z` paired run changes the emphasis:
    - no hidden cursor-pull failures were found in the observed worker-log window
    - both clients saw remote cursors, with first shared visibility beginning once the second window was active
    - the remaining visible problem in that run was slow tile sync/write completion rather than pull recursion
  - confidence boundary:
    - this is encouraging evidence for the paired-client case
    - it is not yet proof that the same fix is stable for `5`, `10`, or `100` concurrent users
    - that still needs explicit multi-client load validation because request volume, shard fanout, and watch-graph shape can change materially with higher concurrency

The practical ordering is now:

1. treat the cursor-storm mitigation as provisionally stable for the paired-client case:
   - same-request nested reverse-direction pull is no longer visible in the recent inspected windows
   - raw worker logs are staying clean of `cursor_pull_peer`, `internal_error`, and `server_error_sent`
2. use the new client sync-wait and worker `setCell_received` logs to capture slow-checkbox / `waiting for sync` episodes end-to-end
3. reduce rebuild / resubscribe churn, since repeated `subAck` and short `click_blocked` rebuild guards are now the main visible annoyance
4. inspect why a small number of `TileOwnerDO setCell` commits still spike into the `~0.5s` to `~1.0s` range even when most writes complete immediately
5. confirm representative watched topologies, including near-full-shard cases, do not recurse or synchronize into storm traffic
6. run explicit multi-client validation beyond the paired-browser case before treating the storm fix as generally proven
7. only then consider deleting more compatibility code

Phase 3 code landed in repo, but the latest Cloudflare logs show that validation is not yet complete. Phase 3b is now the gate before deleting more compatibility code.

### Operational checks after each batch

- capture one limited server tail plus paired normal/private client logs first
- wait about `2 minutes` for Cloudflare historical worker logs to settle before treating query results as complete
- use `pnpm logs:server:query` to pull missing backend detail by time window, `trace_id`, and `requestId`
- check Cloudflare logs for any fresh `Subrequest depth limit exceeded`
- check whether any normal cursor interaction still emits `POST /cursor-batch`
- check whether any `GET /cursor-state` failure surfaced as websocket `internal` / `server_error_sent`
- check whether any watched peer graph, including wider `5`- to `7`-shard scopes, degenerates into recursive or synchronized pull traffic
- check whether repeated `subAck` with `changed_count: 0` is still happening during steady state
- check whether first remote cursor visibility is still delayed after initial subscribe or rebuild
- check whether cursor visibility is asymmetric across the two clients, even if only one side reports errors
- check whether `cursor_pull_peer` is still running under websocket `GET /ws` or nested `GET /cursor-state` request ids
- capture client logs for every `waiting for sync` episode:
  - sync-wait start timestamp
  - sync-wait end timestamp
  - tile
  - op / cid if available
  - whether the local write eventually succeeded, retried, or was superseded
- correlate each slow or stuck write across:
  - client `click_blocked` guard log if the UI refused the action
  - client `setcell_sync_wait_*` lifecycle logs if the action entered the outbox
  - worker `setCell_received` and `setCell` logs
  - tile-owner `setCell` duration and any `tile_batch_order_anomaly`
- verify client CPU drops during idle periods
- verify remote cursors still appear and expire correctly

## Open Questions

- Should watched-peer scope be returned directly by `/watch`, or derived from another hub endpoint?
- Do we want a temporary feature flag for hub publish removal, or is direct cutover acceptable in this environment?
- Is recent-edit activity still worth keeping in `CursorHubDO`, or should that also move out of the hub later?
- Should pull-cycle logging live in `ConnectionShardDO` directly, or in a dedicated cursor pull controller extracted from it?
- Has the storm fix only been validated for paired-browser runs so far, or do we have a practical way to run `5`-, `10`-, and higher-concurrency client simulations against the same logging flow?

## Next Execution Batch

Implement next:

1. keep using the current capture flow now that it is working end-to-end:
   - limited server tail
   - paired normal/private client logs
   - then historical Cloudflare worker queries using the `.env.local`-backed script after the settle delay
2. capture at least one run where `waiting for sync` is clearly noticeable and correlate:
   - client `click_blocked`
   - client `setcell_sync_wait_*`
   - worker `setCell_received`
   - worker / tile-owner `setCell`
   - any `tile_batch_order_anomaly`
3. inspect and reduce rebuild churn, since repeated `subAck` and rebuild guards are still showing up in otherwise healthy runs
4. inspect the occasional slower `TileOwnerDO setCell` commits and determine whether they are cold-start, contention, or duplicate/replay side effects
5. run at least one higher-concurrency validation beyond the paired-browser case before declaring the storm fix broadly stable
6. confirm that scoped peer pulls stay non-recursive across representative watched topologies and that cursor-path worker logs remain clean in those wider runs
7. only if that validation is clean, start Phase 4 and trim the now-redundant push-path tests
