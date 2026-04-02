# App Separate Concerns Plan (Maintainability-First)

## Intent

This plan is a **standalone piece of work** focused on maintainability. We are not changing rendering frameworks or “moving to an engine” for its own sake.

The objective is to reduce orchestration density in `apps/web/src/app.js` by splitting responsibilities into focused runtime modules with clear interfaces and explicit ownership.

---

## Non-goals

- No migration away from PixiJS.
- No ECS rewrite.
- No protocol redesign.
- No behavioral changes to network or render semantics unless required for bug fixes discovered during extraction.

---

## Included baseline work: `protocolTelemetry` extraction

The `apps/web/src/protocolTelemetry.js` extraction is **intentional** and is now part of this plan, not an accidental change.

### Why it belongs here
- It removes protocol/payload summarization concerns from the `app.js` composition root.
- It creates a reusable utility boundary for protocol logging/inspection.
- It is a concrete first move toward app concern separation.

### Responsibility boundary
- `protocolTelemetry` owns payload description and message summarization helpers.
- `app.js` owns orchestration and calls telemetry helpers but does not re-implement them.

### Test requirement for this baseline
- Add and maintain focused tests for `describePayload` and `summarizeMessage` behavior, including edge cases (invalid tile key and cursor/cell batch summary shape).

---

## Current maintainability pain points (scope)

1. `startApp` composes many unrelated concerns (transport lifecycle, outbox replay plumbing, UI status/overlay messaging, window/document lifecycle observers, identity persistence wiring, and teardown).
2. Reconnect/recovery concerns are spread between app-level callbacks and helper modules.
3. Browser lifecycle listeners (focus/pageshow/visibility/network) are embedded in composition code, making ownership unclear.
4. Existing tests validate behavior, but not all runtime boundary contracts are isolated.

---

## Target module split

## 1) `transportRuntime`

**Responsibility**
- Own wire transport lifecycle (`connect`, `send`, `dispose`).
- Track online/offline session state and session telemetry.
- Normalize lifecycle hooks (`onOpen`, `onClose`, `onMessage`).

**Must not own**
- UI status text updates.
- Outbox replay policy.
- DOM event listeners.

**Proposed API (shape-level, not final code)**
- `createTransportRuntime({ wireTransport, perfProbe, logger, encode, decode, telemetry })`
- returns `{ connect, send, dispose, isOnline }`

## 2) `recoveryRuntime`

**Responsibility**
- Bridge setCell outbox sync + reconnect replay policy.
- Provide reconnect callbacks (`handleConnectionOpen`, `handleConnectionLost`).
- Expose pending-op query/drop helpers needed by server message handling.

**Must not own**
- websocket connection internals.
- viewport subscription reconciliation internals.

**Proposed API**
- `createRecoveryRuntime({ outboxSync, scheduleResubscribe, setStatus })`
- returns `{ onOpen, onClose, onConnectionLost, getPendingSetCellOpsForTile, dropPendingSetCellOpsForTile, dispose }`

## 3) `environmentObservers`

**Responsibility**
- Register and teardown browser lifecycle listeners (`focus`, `pageshow`, `visibilitychange`, `online`, `offline`, `resize`).
- Emit normalized callbacks to app orchestrator.

**Must not own**
- transport send logic.
- outbox state.
- render implementation details.

**Proposed API**
- `createEnvironmentObservers({ windowObj, documentObj, callbacks })`
- returns `{ dispose }`

## 4) `uiRuntime` (small adapter)

**Responsibility**
- Status/overlay timers and presentation-only helpers used by orchestration.

**Must not own**
- message protocol decisions.
- websocket state transitions.

---

## Orchestration contract after this plan

`startApp` should be mostly:
1. Create core stores (`camera`, `tileStore`, `heatStore`, `cursors`, render loop).
2. Instantiate runtimes (`transportRuntime`, `recoveryRuntime`, `environmentObservers`, `uiRuntime`).
3. Wire interfaces between runtimes.
4. Return deterministic teardown in reverse dependency order.

If a new feature requires adding >20 lines into `startApp`, that should be treated as a design smell and routed into a runtime module.

---

## Test plan (required for maintainability)

This plan is not done unless tests prove ownership boundaries and regression safety.

## A. Tests to keep (existing coverage)

- `wireTransport` and websocket behavior tests.
- `setCellOutboxSync` behavior tests.
- `renderLoop` behavior tests.
- `app.interactionOverlay` smoke-level behavior tests.

## B. New tests to add (coverage gaps)

### 1) `protocolTelemetry.test.js` (baseline extraction coverage)

Add focused tests for:
- `describePayload` size/tag/head formatting.
- `summarizeMessage` for `setCell`, `cellUpBatch`, cursor messages.
- invalid tile key handling in board-coordinate derivation path.

### 2) `transportRuntime.test.js`

Add focused tests for:
- online state transitions on open/close.
- first-message/session telemetry hooks called once per session where expected.
- `send` behavior while offline for cursor and non-cursor messages (if policy remains split).
- callback ordering contract (`onMessage` not emitted after `dispose`).

### 3) `recoveryRuntime.test.js`

Add focused tests for:
- reconnect path triggers replay scheduling exactly once.
- connection lost path updates status and forwards to outbox runtime.
- pending-op query/drop passthrough contract used by server message handler.

### 4) `environmentObservers.test.js`

Add focused tests for:
- each event listener is registered once and removed on dispose.
- visibility/focus/pageshow callbacks are gated by visibility predicate correctly.
- online/offline callbacks are forwarded without duplicate emissions.

### 5) `app.composition.test.js`

Add a small composition-level contract test for:
- `startApp` wiring: runtime callbacks are connected correctly.
- teardown order avoids use-after-dispose (e.g., no late listener invocation on disposed runtimes).

---

## Suggested PR slicing

1. **PR-1: Baseline docs/tests for `protocolTelemetry` boundary**
   - Document ownership + add focused telemetry tests.
2. **PR-2: Extract `environmentObservers` only**
   - Minimal behavior-preserving extraction + tests.
3. **PR-3: Extract `transportRuntime`**
   - Preserve current callback semantics + tests.
4. **PR-4: Extract `recoveryRuntime` + wiring**
   - Keep outbox behavior stable + tests.
5. **PR-5: Add `app.composition` contract tests + cleanup**
   - Remove dead glue and enforce module boundaries.

Each PR should be small, behavior-preserving, and independently revertible.

---

## Definition of done

- `app.js` is reduced to orchestration (no large embedded lifecycle subsystems).
- Runtime responsibilities are documented in code comments at module boundaries.
- New runtime modules each have focused tests.
- Existing regression suite remains green.
- `protocolTelemetry` extraction remains covered and documented as an intentional boundary.
- No framework migration introduced.

---

## Risk controls

- Keep behavior snapshots before each extraction PR.
- Prefer adapter-first extraction: wrap old logic, then move internals.
- Maintain API compatibility with `createServerMessageHandler` and `createRenderLoop` during extraction.
- Use contract tests to prevent boundary regressions.

---

## Outcome expectation

After this plan, future work should be cheaper because runtime responsibilities are explicit and test-backed. This improves maintainability immediately without committing to deeper engine-pattern migrations.
