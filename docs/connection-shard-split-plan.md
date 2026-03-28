# ConnectionShardDO Split Plan

This document tracks the work required to split [`apps/worker/src/connectionShardDO.ts`](../apps/worker/src/connectionShardDO.ts) into smaller, more cohesive modules without changing external behavior.

## Problem Summary

[`ConnectionShardDO`](../apps/worker/src/connectionShardDO.ts) is currently too large and owns too many responsibilities at once.

As of this plan, it is about `1512` lines and directly handles:

- websocket connect, hello, close, and stale-client replacement
- client payload decode and dispatch
- `setCell` suppression and queuing
- tile batch ingress
- tile watch, snapshot, and ops-since gateway calls
- tile delta polling and snapshot resync
- cursor batch ingress
- cursor-state serving
- cursor pull scheduling and alarm execution
- cursor hub watch state and recent edit activity publication
- cursor trace/error/log correlation
- shard-level logging and error shaping

The architecture rules in [`docs/architecture.md`](./architecture.md) say modules should have a narrow responsibility and that `ConnectionShardDO` should own client connections, subscriptions, and shard-local coordination, not act as the implementation home for every tile, cursor, and transport detail.

## Goals

- Reduce `ConnectionShardDO` to a thin Durable Object composition root.
- Split the current behavior along real runtime seams, not arbitrary file-count goals.
- Preserve all current public routes and protocol behavior:
  - `/ws`
  - `/tile-batch`
  - `/cursor-batch`
  - `/cursor-state`
  - `alarm()`
- Keep storm-prevention guardrails intact.
- Make the extracted units directly testable.
- Ensure refactor work adds or updates tests for the changed code paths.

## Non-Goals

- Do not redesign the websocket or tile protocol.
- Do not change shard topology or cursor/tile ownership semantics as part of this refactor.
- Do not collapse already-good helper modules back into new god objects.
- Do not chase perfect abstractions before reducing the responsibility load in `ConnectionShardDO`.

## Current Responsibility Inventory

The current class is a mix of several distinct concerns:

### 1. Session And Websocket Lifecycle

- parse connect params
- replace existing client
- send `hello`
- attach socket listeners
- disconnect current client
- encode and send server messages
- shape websocket error messages

### 2. Client Message Handling

- decode binary payloads
- detect `setCell`
- queue/suppress client write handling
- build `ConnectionShardDOOperationsContext`
- call [`handleConnectionShardClientMessage`](../apps/worker/src/connectionShardClientMessageHandler.ts)

### 3. Tile Runtime

- `POST /tile-batch`
- tile batch loop guard and ingress handling
- tile version tracking
- local fanout to subscribed clients
- tile watch/snapshot/ops-since/setCell gateway calls
- tile pull scheduling, backoff, and resync

### 4. Cursor Runtime

- `POST /cursor-batch`
- `GET /cursor-state`
- cursor ingress depth and publish suppression windows
- cursor pull orchestrator wiring
- peer polling
- first-visibility and pre-visibility logging
- cursor hub watch refresh and local activity hooks
- `alarm()` handling for scheduled cursor pull

### 5. Shared Infrastructure Glue

- detached task scheduling
- timer cleanup
- shard name resolution
- structured logging
- error field shaping
- recent edit activity publication to cursor hub

## Target Shape

`ConnectionShardDO` should stay as the Durable Object entrypoint, but most behavior should move behind focused collaborators.

Target direction:

- `ConnectionShardDO`
  - owns constructor wiring
  - owns `fetch()` route dispatch
  - owns `alarm()` delegation
  - owns the shared in-memory maps that define shard state, unless and until a dedicated state object is clearly beneficial
- `ConnectionShardSessionHost`
  - websocket connect/disconnect lifecycle
  - `hello` send
  - payload dispatch and socket event wiring
  - server-message/error send helpers
- `ConnectionShardTileRuntime`
  - `/tile-batch`
  - tile version tracking
  - tile gateway calls
  - tile pull scheduler and resync behavior
  - local tile fanout
- `ConnectionShardCursorRuntime`
  - `/cursor-batch`
  - `/cursor-state`
  - cursor ingress and suppression state
  - cursor pull orchestration and alarm handling
  - peer visibility logging
  - hub watch refresh and recent edit activity publication hooks
- small shared utilities or context types only where they reduce coupling cleanly

Important constraint:

- reuse the existing helper modules where they already define a good seam:
  - [`connectionShardClientMessageHandler.ts`](../apps/worker/src/connectionShardClientMessageHandler.ts)
  - [`connectionShardDOOperations.ts`](../apps/worker/src/connectionShardDOOperations.ts)
  - [`connectionShardCursorBatchIngress.ts`](../apps/worker/src/connectionShardCursorBatchIngress.ts)
  - [`connectionShardCursorHubController.ts`](../apps/worker/src/connectionShardCursorHubController.ts)
  - [`connectionShardCursorPullOrchestrator.ts`](../apps/worker/src/connectionShardCursorPullOrchestrator.ts)
  - [`connectionShardSetCellQueue.ts`](../apps/worker/src/connectionShardSetCellQueue.ts)
  - [`connectionShardTileBatchOrder.ts`](../apps/worker/src/connectionShardTileBatchOrder.ts)
  - [`connectionShardTileGateway.ts`](../apps/worker/src/connectionShardTileGateway.ts)

## Refactor Strategy

Split the class in phases. Do not attempt a single giant rewrite.

### Phase 0: Characterize Current Behavior

- [ ] Audit the current route and lifecycle behaviors that must stay stable.
- [ ] Identify missing direct coverage for the highest-risk branches before moving code.
- [ ] Add or tighten characterization tests before extraction starts.

Focus areas to lock down:

- websocket connect, hello, duplicate-client replacement, and disconnect cleanup
- `setCell` suppression behavior during tile batch ingress/cooldown
- `/tile-batch` loop guard and no-local-subscriber behavior
- tile pull gap resync and snapshot fanout behavior
- `/cursor-state` snapshot serving and post-ingress flush behavior
- alarm stale/alarm failure handling

Required testing work:

- keep [`apps/worker/test/worker.connectionShard-websocket.test.ts`](../apps/worker/test/worker.connectionShard-websocket.test.ts) as the main behavior-characterization suite
- add missing integration cases there if any of the above behaviors are not already covered
- update [`apps/worker/test/helpers/connectionShardWebsocketHarness.ts`](../apps/worker/test/helpers/connectionShardWebsocketHarness.ts) only as needed to support characterization, not as speculative cleanup

### Phase 1: Extract Shared Host Context

- [ ] Introduce a narrow internal context interface for shared shard state and services.
- [ ] Move generic send/error/log/timer helpers behind that context or a small host helper.
- [ ] Keep `ConnectionShardDO` behavior unchanged while reducing direct helper sprawl.

Notes:

- this phase should prepare the split, not finish it
- avoid inventing a large "manager" abstraction that simply re-hides the same complexity

Required testing work:

- add unit coverage for any new shared helper module
- update existing integration tests to ensure websocket and error behavior stays unchanged

### Phase 2: Extract Session And Transport Flow

- [ ] Move websocket connect/disconnect lifecycle into a dedicated session host module.
- [ ] Move payload dispatch and `setCell` queue/suppression flow out of the DO class.
- [ ] Keep `ConnectionShardDO` responsible only for routing `/ws` to the session host.

Expected result:

- the DO no longer directly owns socket event listener setup details
- the DO no longer directly owns payload dispatch branching for `setCell` versus non-`setCell`

Required testing work:

- add a focused unit test file for the extracted session host
- keep or expand websocket integration coverage for:
  - hello payloads
  - stale client replacement
  - message decode failures
  - internal error surfacing
  - disconnect cleanup and subscription cleanup

### Phase 3: Extract Tile Runtime

- [ ] Move tile-batch ingress handling into a dedicated tile runtime module.
- [ ] Move tile polling, version tracking, interval/backoff, and snapshot resync into the tile runtime.
- [ ] Keep local tile fanout behavior and ordering anomaly logging in the tile runtime.
- [ ] Keep the route contract unchanged: `POST /tile-batch` still terminates at the DO, but delegates immediately.

Expected result:

- tile concerns are isolated from cursor concerns
- tile pull scheduling can be tested without loading the full websocket/cursor runtime

Required testing work:

- add a focused test file for the extracted tile runtime
- ensure direct coverage for:
  - tile batch ingress loop guard
  - no-local-subscriber short-circuit
  - local fanout to subscribed clients
  - version recording
  - ops-since paging behavior
  - gap-triggered snapshot resync
  - pull interval/backoff reset
- keep relevant integration coverage in [`worker.connectionShard-websocket.test.ts`](../apps/worker/test/worker.connectionShard-websocket.test.ts)

### Phase 4: Extract Cursor Runtime

- [ ] Move cursor-batch ingress handling, cursor-state serving, and ingress suppression state into a dedicated cursor runtime module.
- [ ] Move cursor pull peer polling and visibility logging into the cursor runtime.
- [ ] Move `alarm()` execution logic behind the cursor runtime while keeping the DO alarm entrypoint.
- [ ] Keep existing storm-protection and trace behavior intact.

Expected result:

- cursor flow becomes testable as a cohesive runtime
- the highest-risk storm-prevention code no longer lives inside a 1500-line DO class

Required testing work:

- add a focused test file for the extracted cursor runtime
- preserve and update existing tests for:
  - re-entrant cursor ingress protection
  - publish suppression windows
  - `/cursor-state` response behavior
  - alarm stale handling
  - alarm failure logging
  - first peer visibility and pre-visibility logging
  - best-effort failure containment for peer pulls
- keep existing specialized unit tests in place:
  - [`connectionShardCursorBatchIngress.test.ts`](../apps/worker/test/connectionShardCursorBatchIngress.test.ts)
  - [`connectionShardCursorHubController.test.ts`](../apps/worker/test/connectionShardCursorHubController.test.ts)
  - [`connectionShardCursorPullScheduler.test.ts`](../apps/worker/test/connectionShardCursorPullScheduler.test.ts)
  - [`connectionShardCursorTrace.test.ts`](../apps/worker/test/connectionShardCursorTrace.test.ts)

### Phase 5: Shrink The DO To A Thin Composition Root

- [ ] Reduce `ConnectionShardDO` to wiring, route dispatch, and delegation.
- [ ] Remove now-dead private helpers from the DO.
- [ ] Re-check naming and file placement after extraction.
- [ ] Update docs if the final module boundaries differ from this plan.

Target outcome:

- `ConnectionShardDO` is substantially smaller and readable as an entrypoint
- the extracted runtimes own the logic they are named after
- the final layout reflects architectural responsibilities, not temporary migration compromises

Required testing work:

- run the full worker test suite after the final extraction
- keep end-to-end behavior coverage for the full route surface
- ensure each new runtime/helper has direct tests, not just indirect coverage through the DO

## Test Policy For This Refactor

This split is not complete unless tests move with it.

Minimum expectations:

- every extracted module gets direct tests for its core behavior
- existing integration tests remain in place for public route and websocket behavior
- if a refactor changes control flow, matching tests must be added or updated for the changed paths
- no extraction step should reduce storm-prevention regression coverage

The key principle is:

- preserve broad behavior coverage at the DO/integration level
- add narrower tests at the new module boundary
- do both during the split, not later

## Risks And Watchpoints

- Cursor flow is the highest-risk area because of prior storm and delayed-visibility incidents.
- The websocket harness may need careful adjustment if constructor dependencies shift.
- It is easy to accidentally move shared state ownership into the wrong place and create hidden coupling.
- A "split" that merely moves large chunks into similarly bloated helpers does not solve the problem.

## Exit Criteria

This plan is complete when:

- `ConnectionShardDO` is a thin entrypoint and composition root
- tile and cursor runtime responsibilities are separated
- extracted modules have direct tests
- existing websocket and route integration behavior is still covered
- [`docs/architecture.md`](./architecture.md) still matches the resulting structure
