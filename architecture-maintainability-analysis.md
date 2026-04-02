# Game-Engine Lens: Maintainability + Refactor ROI (April 2026)

This is a fresh pass on the **current** codebase and asks a practical question:

> If we push this architecture toward a game-engine style implementation, is the refactor worth it?

Short answer: **partially yes**. The backend authority model is already game-server-like and strong. The biggest ROI now is on the **web runtime composition model** and **explicit state transitions**, not a full ECS rewrite.

---

## 1) What you already have that is game-engine-ish

### 1.1 Server authority topology is already “engine-grade”
- `TileOwnerDO` = authoritative simulation/persistence per tile.
- `ConnectionShardDO` = connection/session orchestration + fanout + anti-loop protections + pull/reconcile control.
- Cursor distribution has graduated from simple relay to a hub-aware model (`cursorHub`, pull cadence, suppression windows).

**Interpretation:** You already have the equivalent of a distributed simulation server with region ownership and relay infrastructure.

### 1.2 Client has a real frame loop with partial redraw policy
- `renderLoop` tracks dirty regions, full vs patch render, cursor smoothing, heat decay, and subscription reconciliation.

**Interpretation:** This resembles a lightweight engine main loop with update+render phases, even if it is still module-oriented rather than system-oriented.

### 1.3 Reliability mechanics look like a netcode layer
- Identity token flow and `setCell` outbox sync introduce reconnection/replay behavior instead of “fire-and-forget websocket UI”.

**Interpretation:** You are already beyond typical app architecture and closer to multiplayer runtime semantics.

---

## 2) Delta: current architecture vs “engine-style” target

| Area | Current state | Engine-style target | Delta severity |
|---|---|---|---|
| Runtime composition | `app.js` remains a broad composition root with transport lifecycle, reconnection UX, outbox, event wiring, and orchestration | Explicit runtime subsystems (`TransportSystem`, `RecoverySystem`, `UiSystem`, `InputSystem`, `RenderSystem`) | **High** |
| Frame model | Update and render concerns are colocated in `renderLoop` | Explicit phase contract (`preUpdate`, `fixedUpdate`, `lateUpdate`, `render`) | **Medium** |
| State transitions | Many callback-driven transitions (open/close/offline/visibility/focus/replay) | Finite state machines for session/recovery/replay | **High** |
| Network reconciliation | Strong, but spread across multiple modules and timers | Centralized replication pipeline (`ingest -> validate -> apply -> ack/reconcile`) | **Medium** |
| Data ownership clarity | Good on backend, mixed in frontend orchestration | Hard ownership boundaries per subsystem + test harness per boundary | **Medium** |
| Tooling guardrails | Better tests, but architecture constraints are mostly convention | Lint rules + architecture tests to prevent cross-layer drift | **Medium** |

---

## 3) Existing web game framework options: should we adopt one?

Short answer: **yes, but selectively**.

You already use PixiJS for rendering. That means you already have the right rendering backbone; the gap is orchestration/runtime structure, not raw draw API capability.

### Option matrix

| Option | Fit for this project | Integration difficulty | Likely payoff |
|---|---|---|---|
| Keep PixiJS + add lightweight runtime framework patterns (FSM + subsystems) | **Best fit** | **Low–Medium** | **High** |
| Adopt Phaser as full game framework | Medium (great scene/input stack, but your custom netcode + tile authority model does not map cleanly to Phaser scenes) | Medium–High | Medium |
| Adopt an ECS lib (`bitecs`, `ecsy`) only for client runtime state | Medium | Medium | Medium |
| Move to full 3D engine stack (Babylon/Three scene architecture) | Low fit for checkbox-canvas product | High | Low |

### Recommendation

Do **not** replace PixiJS. Instead, layer in “engine architecture” on top of current Pixi usage:
1. FSM for connection/recovery/replay.
2. Runtime subsystem registry (`transport`, `recovery`, `input`, `render`).
3. Explicit frame phases within existing render loop.

This gives most of the maintainability benefit with low migration risk.

---

## 4) What you would win by refactoring (and what you would not)

## Wins with clear ROI

1. **Lower change-risk for multiplayer behavior**
   - Explicit connection/recovery FSMs reduce edge-case regressions around reconnect, visibility changes, replay timing, and suppression windows.

2. **Faster feature work in core runtime**
   - Subsystem boundaries let you add features (spectator mode, throttling policies, diagnostics overlays, reconnect strategies) without inflating `app.js`.

3. **Better operability and incident debugging**
   - Engine-style phase boundaries make metrics/traces easier to attribute (“which phase caused jitter/backlog?”).

4. **Higher confidence through targeted tests**
   - Each runtime subsystem can be tested with deterministic fixtures instead of broad integration-only confidence.

## Wins that are likely *not* worth full rewrite cost right now

1. **Full ECS conversion of web client**
   - Overkill at current scale/complexity; would add conceptual overhead for modest practical gain.

2. **Rigid fixed-timestep everything**
   - Useful for deterministic sims, but your current mixed rendering/network cadence is acceptable for this product style.

3. **Massive protocol/persistence redesign**
   - Backend already has strong authority and convergence patterns; incremental improvements beat rewrite risk.

---

## 5) Recommended refactor plan (incremental, high-value)

### Phase A — Composition split (highest ROI, low behavior risk)
- Detailed implementation plan: `app-separate-concerns-plan.md`.
- Extract from `app.js`:
  - `transportRuntime` (ws lifecycle + session metrics + on/offline)
  - `recoveryRuntime` (outbox replay + reconnect resubscribe policy)
  - `environmentObservers` (focus/pageshow/visibility/network events)
- Keep `startApp()` as a thin assembler.

### Phase B — State machines for runtime transitions
- Introduce small FSMs:
  - `ConnectionState`: disconnected → connecting → open → degraded/recovering
  - `ReplayState`: idle → buffering → replaying → reconciled
- Use explicit transitions/events for all lifecycle callbacks.

### Phase C — Frame contract hardening
- Keep existing render loop but separate methods by phase internally:
  - `updateSimulation(dt)`
  - `syncSubscriptions()`
  - `renderFrame()`
- This preserves behavior while preparing for future scalability.

### Phase D — Architecture guardrails
- Add lint/structure rules that prevent “engine drift” back into giant orchestration files.
- Add small architecture tests for forbidden cross-layer imports.

---

## 6) Practical “worth it?” verdict

- **Do the refactor:** yes, but **incrementally** and focused on runtime composition + explicit state transitions.
- **Do not do:** full engine rewrite/ECS migration now.
- **Expected payoff:** better maintainability and safer multiplayer evolution with moderate effort and low migration risk.

If you want, next I can draft a concrete PR-by-PR plan (5–8 PRs) with exact module boundaries and test additions per phase, plus a “framework adoption starter PR” that introduces the FSM scaffolding without changing behavior.
