# Architecture

This document defines the architectural rules for Sea of Checkboxes.

It is based on:

- [techspec.md](../techspec.md)
- active planning and operational docs in [`docs/`](./)
- the current implementation in [`apps/web`](../apps/web), [`apps/worker`](../apps/worker), [`packages/domain`](../packages/domain), and [`packages/protocol`](../packages/protocol)

When documents and implementation disagree, the running code and tests are the short-term source of truth. The mismatch must then be resolved in the same PR by updating the code, but potentially not immediately.  Comments can be added in the code to explain why this discrepency exists. Example: the tech spec still describes JSON protocol examples, while the current codebase uses binary codecs from `@sea/protocol`.

## System Shape

Sea of Checkboxes is a layered monorepo:

- `packages/domain`: pure world rules, coordinate math, bounds, validation, identity helpers
- `packages/protocol`: wire message formats, framing, snapshot codecs, protocol tests
- `apps/web`: browser client, Pixi rendering, local state, transport, auth/session UX
- `apps/worker`: public HTTP and websocket entrypoints, auth/session exchange, Durable Objects, persistence, observability
- `scripts/swarm`: scalability and incident tooling, not production runtime

At runtime, the main backend topology is:

1. Browser connects to Worker HTTP and websocket routes.
2. Worker resolves identity/auth and routes websocket traffic to a `ConnectionShardDO`.
3. `ConnectionShardDO` owns client sockets, subscriptions, shard-local batching, and cursor coordination.
4. `TileOwnerDO` owns authoritative tile state, ordering, versioning, and snapshot persistence.
5. `CursorHubDO` supports cross-shard cursor discovery and cursor visibility convergence.

## Strict Rules

These are non-negotiable. New code should conform to them unless the architecture itself is being intentionally changed.

### 1. Dependency Direction Is One-Way

- `packages/domain` must stay pure and must not import from `apps/*`.
- `packages/protocol` may depend on shared pure logic, but must not import from `apps/*`.
- `apps/web` may import from shared packages, but must never import worker internals.
- `apps/worker` may import from shared packages, but must never import web internals.
- `scripts/*` are allowed to depend on shared packages, but must not become a hidden production dependency.

Allowed direction:

`domain -> protocol -> app/runtime composition`

Not allowed:

- worker code reaching into web modules
- protocol/domain code depending on Cloudflare, Pixi, DOM, or websocket runtime objects
- circular shared-package dependencies

### 2. Each Layer Has A Single Job

- `packages/domain` owns deterministic rules and validation only.
- `packages/protocol` owns encoding, decoding, framing, and protocol message contracts only.
- `apps/web` owns presentation, client-side simulation/state, and browser transport composition.
- `apps/worker/src/workerFetch.ts` owns public request routing and top-level HTTP/websocket orchestration only.
- `ConnectionShardDO` owns client connections, subscriptions, shard-local fanout, and client-originated message handling.
- `TileOwnerDO` owns tile authority, tile version advancement, op history, and persistence cadence.
- `CursorHubDO` owns cursor discovery and cursor visibility coordination across shards, not checkbox state.

If a module starts owning rendering, networking, persistence, and domain decisions at the same time, it is wrong and should be split.

### 3. Tile State Has One Authoritative Owner

- `TileOwnerDO` is the only place allowed to authoritatively mutate tile checkbox state.
- `TileOwnerDO` is the only place allowed to advance tile version numbers.
- `setCell` requests that do not change state must not bump tile version.
- Clients may optimistically render edits, but server truth wins and clients must converge back to authoritative tile state.
- Cross-shard tile convergence must remain version-based and recovery-friendly.

### 4. Cursor Presence Is Best-Effort And Must Stay Separate From Writes

- Checkbox updates are correctness-critical.
- Cursor updates are lossy and best-effort.
- Cursor traffic must never block, delay, or recursively couple into authoritative tile write paths.
- Under stress, cursor fidelity degrades before checkbox correctness does.
- Any topology change must preserve this separation.

This is a hard-learned rule from the cursor storm incidents. Do not blur the paths again.

### 5. No Synchronous DO Request Cycles

- Do not introduce request chains that can recurse across Durable Objects during one live ingress path.
- Fanout that can amplify must be detached, coalesced, or pull-based.
- Ingress handlers must protect themselves against re-entry where loop risk exists.
- Cross-shard propagation paths must carry trace or hop metadata when loop detection matters.
- Pull-based convergence is preferred over storm-prone push replication for shard-to-shard state visibility.

Any change touching cursor or tile fanout must be reviewed against [`docs/storm-prevention.md`](./storm-prevention.md).

### 6. Shared Contracts Live In Shared Packages

- World constants, tile math, bounds, and validation belong in `@sea/domain`.
- Wire message types, codecs, framing, and snapshot encoding belong in `@sea/protocol`.
- Web and worker code must consume those shared definitions instead of re-declaring parallel logic.
- New protocol fields or message types require tests in `packages/protocol/test`.

No ad-hoc tile parsing, cell-index math, or message shape duplication in app code.

### 7. Validation Happens At Every Trust Boundary

- Public HTTP and websocket inputs must be validated before use.
- Durable Object HTTP endpoints must validate payloads independently, even if callers already validate.
- Numeric inputs must be finite and clamped or rejected according to domain rules.
- Tile keys and cell indices must be parsed with shared helpers, not loose string logic.
- Invalid or partial cursor/tile payloads must fail safely.

### 8. Persistence Is A TileOwner Concern

- Snapshot reads and writes go through tile-owner persistence abstractions.
- Other worker modules must not directly write tile snapshots.
- Persistence failure handling must not corrupt in-memory authority.
- Retry behavior must be explicit and observable.

### 9. Observability Is Part Of The Architecture

- New distributed flows must emit structured logs with enough fields to correlate client, shard, tile, and trace.
- Internal errors that can reach users should expose an actionable trace id when possible.
- If a flow becomes asynchronous, the logging must still show cause and effect across hops.
- Missing observability is an architecture bug, not just a tooling gap.

### 10. Architecture Changes Require Matching Tests And Docs

- Domain and protocol changes require focused unit tests.
- Worker topology and fanout changes require regression tests for the affected failure mode.
- Client transport/sync changes require tests for convergence and stale-update handling.
- Architectural changes must update this file and any now-stale spec or planning docs in the same PR.

## Codebase Guidelines

These are strong defaults. Break them only with a clear reason.

### Module Placement

- Put pure logic in shared packages first when both client and worker need it.
- Keep browser-only concerns in `apps/web/src`.
- Keep Cloudflare/runtime-only concerns in `apps/worker/src`.
- Keep worker logic that can run without Cloudflare bindings in `apps/worker/src/local` when possible.
- Keep auth code inside `apps/web/src/auth` and `apps/worker/src/auth` instead of scattering auth checks through unrelated modules.

### File Design

- Prefer small modules with one obvious responsibility.
- Use composition modules to wire dependencies together, not to hide business logic.
- If a file name could reasonably contain the word "and", it probably wants splitting.
- Prefer explicit function inputs over hidden singleton state.

### Frontend Guidance

- `app.js` should remain a composition root, not a dumping ground for every feature.
- Rendering concerns stay near `renderer.js`, `renderLoop.js`, and cursor render helpers.
- DOM/HUD logic stays near `dom.js`.
- Transport encoding, decoding, and websocket concerns stay near `wireTransport.js`, `webSocketTransport.js`, and `serverMessages.js`.
- Client-only UX state such as heatmaps, smoothing, and outbox retry stays on the client side unless there is a strong server need.

### Worker Guidance

- Keep `worker.ts` and `workerFetch.ts` thin.
- Put reusable DO behavior in dedicated modules instead of growing single giant DO files.
- Prefer explicit gateway or controller modules for cross-DO coordination.
- Keep Durable Object endpoints small, validated, and easy to trace in logs.
- When a runtime behavior also needs deterministic tests, factor the core logic away from platform glue.

### State And Concurrency Guidance

- Prefer monotonic versions, idempotency, and replay-safe handlers over timing assumptions.
- Design for reconnect, duplicate delivery, and stale delivery as normal conditions.
- Use pull, snapshot, and resync paths as first-class recovery tools, not as afterthoughts.
- For best-effort traffic, prefer coalescing over "send every intermediate state".

### Testing Guidance

- Every shared math or codec rule should have direct unit coverage.
- Every incident-derived guardrail should have a regression test close to the module that enforces it.
- Refactors should add or update test coverage around the changed code paths so the new structure is still exercised.
- For worker changes, test both happy-path correctness and failure containment.
- For scalability work, do not promote scenarios to production until the local ladder is clean and logs have been inspected.

The current swarm expectations are documented in:

- [`docs/scalability-testing/README.md`](./scalability-testing/README.md)
- [`docs/scalability-testing/buildout-plan.md`](./scalability-testing/buildout-plan.md)

### Documentation Guidance

- The tech spec defines product and architectural intent.
- This file defines codebase rules and implementation boundaries.
- Historical incident docs capture how specific failures happened and what guardrails were added.
- Active investigation plans should stay clearly marked as active.
- Completed plans should be moved or summarized in [`docs/done`](./done) once they are no longer the active working plan.

## Review Checklist

Use this before merging any meaningful architectural change:

1. Does the change preserve the dependency direction and package boundaries?
2. Does it keep authoritative tile state separate from best-effort cursor presence?
3. Could it introduce a synchronous DO request cycle or fanout storm?
4. Are shared rules implemented in `@sea/domain` or `@sea/protocol` instead of duplicated?
5. Are validation, logging, and traceability good enough for incident debugging?
6. Are the relevant tests and docs updated in the same change?
