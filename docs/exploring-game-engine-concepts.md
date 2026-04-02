# Exploring Game-Engine Concepts For Sea of Checkboxes (April 2026)

This note is no longer primarily about generic maintainability. It is an exploration of how to incorporate game-engine concepts into the app without forcing a full engine rewrite.

The practical question is:

> Which game-engine concepts fit this product, which ones do not, and how much progress have we already made?

Short answer:

- the app already has several engine-like traits
- the best fit is to adopt engine concepts as structure and vocabulary, not as a wholesale framework migration
- **Phase A has already started landing**: `app.js` has been split into more explicit runtime modules and now behaves more like a composition root than a giant mixed-responsibility file

---

## 1. Why A Game-Engine Lens Fits This App

Sea of Checkboxes is not a traditional form-based web app.

It has:

- a persistent shared world
- authoritative server state
- continuous input and rendering
- reconciliation after network disruption
- lossy and non-lossy traffic classes
- a frame loop with partial redraw and smoothing

That pushes it closer to a multiplayer simulation client than to a standard CRUD frontend.

So the useful question is not "should this become a game?" It is:

> which game-engine concepts help organize the runtime we already have?

---

## 2. Concepts That Map Well

### 2.1 Main Loop / Frame Phases

The client already has a real loop in `renderLoop.js`:

- update heat decay
- smooth cursors
- refresh subscriptions
- choose full render vs partial patch render
- update cursor labels

That is already close to an engine loop. The next step is not replacing it. The next step is naming the phases more explicitly:

- input collection
- network ingest / reconciliation
- simulation update
- render preparation
- render

This would make timing, instrumentation, and debugging easier.

### 2.2 Systems / Subsystems

Game engines usually separate runtime responsibilities into systems. That pattern fits this app well.

Current good candidates:

- transport system
- recovery / replay system
- UI/HUD system
- input system
- render system
- subscription visibility system

The point is not ECS purity. The point is explicit runtime ownership.

### 2.3 Authoritative Simulation Boundary

The backend already looks engine-like:

- `TileOwnerDO` is authoritative world ownership for tile state
- `ConnectionShardDO` is connection/session orchestration
- `CursorHubDO` is a best-effort presence distribution service

This is already much closer to multiplayer server architecture than to a typical request/response backend.

### 2.4 State Machines

A lot of the fragile frontend behavior is really state-transition behavior:

- disconnected -> connecting -> open -> recovering
- replay idle -> pending -> replaying -> reconciled
- visible -> hidden -> resumed

These are better expressed as explicit state machines than as scattered callback behavior.

### 2.5 Event-Driven Runtime Coordination

The app already reacts to:

- websocket lifecycle events
- browser offline/online
- focus / pageshow / visibilitychange
- server acks and snapshots

That is effectively an event-driven engine runtime. Formalizing those events would reduce ambiguity.

---

## 3. Concepts That Probably Do Not Fit Well

### 3.1 Full ECS Rewrite

A full ECS migration is not justified right now.

Reasons:

- most complexity is in runtime orchestration and network convergence, not large-scale entity behavior
- the app has a relatively constrained world model
- ECS would add abstraction cost before it adds much practical leverage

Some ECS-style thinking is useful. A full ECS architecture is probably not.

### 3.2 Scene Graph As Primary Runtime Model

Pixi already gives rendering primitives. But the hard architectural problems here are not scene management problems. They are:

- authority boundaries
- reconnection
- synchronization
- visibility/subscription logic

So a larger rendering framework is unlikely to solve the right problem.

### 3.3 Fixed-Timestep Deterministic Simulation Everywhere

Some engine architectures rely heavily on fixed-timestep deterministic simulation. That is not the main need here.

The authoritative backend already owns correctness. The client mainly needs:

- responsive rendering
- clear reconciliation
- robust recovery

So full deterministic client simulation is unnecessary.

---

## 4. Current Codebase Through An Engine Lens

| Area | Current shape | Engine-style interpretation | Next improvement |
|---|---|---|---|
| `apps/worker` authority | DO ownership split by responsibility | server-side simulation ownership | keep hard boundaries and observability |
| `renderLoop.js` | mixed update/render/subscription work | lightweight engine main loop | make phases more explicit |
| `app.js` | runtime composition entrypoint | engine bootstrap / assembler | keep shrinking orchestration details out of it |
| `setCellOutboxSync.js` | replay / reconciliation helper | client netcode reliability layer | connect more clearly to explicit replay state |
| `serverMessages.js` | ingest/apply/reconcile message handling | replication ingest pipeline | keep authority/recovery semantics centralized |
| browser lifecycle hooks | focus/offline/visibility handling | runtime environment event layer | formalize as engine events / states |

---

## 5. Best Direction: Engine Concepts Without Engine Replacement

The best fit for this project is:

1. keep PixiJS
2. keep the authoritative backend topology
3. adopt engine concepts as architectural structure

That means:

- explicit subsystem boundaries
- explicit lifecycle states
- explicit frame/update phases
- clearer event vocabulary
- stronger orchestration rules around simulation vs presentation vs transport

This gets most of the value without paying the cost of replacing the stack.

---

## 6. Proposed Incorporation Plan

### Phase A — Composition And Runtime Boundary Split

Goal:

- move the client bootstrap closer to an engine-style composition root

Target ideas:

- `app.js` assembles subsystems
- subsystem internals live in dedicated runtime modules
- transport/recovery/UI/environment concerns stop accumulating in one file

### Phase A Progress

Status: **partially complete**

What is already done:

- `app.js` has already been split to use explicit runtime modules such as:
  - `transportRuntime.js`
  - `recoveryRuntime.js`
  - `uiRuntime.js`
  - `environmentObservers.js`
  - `protocolTelemetry.js`
- `startApp()` now behaves much more like a composition root / bootstrap layer
- dedicated tests were added around the extracted runtime helpers

Why this matters in engine terms:

- this is the first concrete move from "one big app file" toward "bootstrap plus subsystems"
- the runtime now has clearer ownership seams
- this lowers the risk of future state-machine and phase work

What is still incomplete in Phase A:

- the runtime boundaries are better, but not yet expressed consistently as a named subsystem model
- `renderLoop.js`, `serverMessages.js`, and the input path still carry some cross-cutting orchestration responsibilities
- lifecycle semantics are still callback-driven rather than fully modeled

### Phase B — Explicit Runtime State Machines

Goal:

- replace ambiguous lifecycle coupling with explicit runtime states

Likely machines:

- connection state
- replay/recovery state
- subscription rebuild state
- auth/session transition state

Expected value:

- safer reconnect changes
- clearer diagnostics
- easier regression testing

### Phase C — Frame Contract

Goal:

- make the frame loop more engine-like without changing product behavior

Possible internal phases:

- `ingestNetwork()`
- `updateRuntime()`
- `syncVisibilityAndSubscriptions()`
- `prepareRender()`
- `render()`

Expected value:

- cleaner mental model
- better metrics by phase
- easier performance analysis

### Phase D — Runtime Event Vocabulary

Goal:

- standardize the client around explicit events rather than ad hoc callbacks

Examples:

- `transport_open`
- `transport_closed`
- `recovery_started`
- `recovery_completed`
- `subscription_rebuild_started`
- `subscription_rebuild_completed`
- `visibility_resumed`

Expected value:

- simpler orchestration
- cleaner logs
- more coherent tests

### Phase E — Guardrails

Goal:

- prevent drift back into mixed-responsibility runtime code

Possible guardrails:

- architecture linting for forbidden imports
- rules around what `app.js` may own
- boundary tests around transport/recovery/render responsibilities

---

## 7. Concrete Recommendations

### Do

- continue treating `app.js` as the composition root
- keep extracting subsystem-level runtime logic from orchestration-heavy files
- introduce small explicit state machines before adding more callback paths
- make the frame/update phases more visible in `renderLoop.js`
- use engine language internally where it sharpens ownership: subsystem, lifecycle, phase, recovery, authority

### Do Not

- replace PixiJS just to look more "game-like"
- do a full ECS rewrite
- force all runtime behavior into a fixed-timestep model
- collapse authoritative and best-effort traffic into one conceptual path

---

## 8. Practical Verdict

Game-engine concepts are a good fit for this project, but only when applied surgically.

The useful path is:

- keep the existing stack
- keep the authoritative backend model
- keep evolving the client toward explicit subsystems, lifecycle states, and frame phases

The good news is that this has already started. Phase A is not hypothetical anymore. The `app.js` split is real progress toward an engine-style runtime composition model.

The next high-value step is Phase B: explicit lifecycle state machines on top of the subsystem boundaries that now exist.
