# Server-Authoritative Share Location Plan

This document describes the work needed to stop share-link creation from trusting client-supplied `x/y/zoom`, and to tighten the related session-location flow so that a caller cannot mint a share link for an arbitrary board position.

It also covers a second hardening step: the session spawn used by the client should be recorded and enforced server-side so that a fresh session cannot immediately "teleport" its authoritative viewport far away from the spawn the backend actually assigned.

## Problem Summary

Today the share-link creation path trusts browser-owned camera state.

- the web app sends `camera.x`, `camera.y`, and `camera.cellPixelSize` in the `POST /share-links` body:
  - [`apps/web/src/shareLinks.js`](../apps/web/src/shareLinks.js)
- the worker parses that body and stores the resulting coordinates directly in KV:
  - [`apps/worker/src/workerFetch.ts`](../apps/worker/src/workerFetch.ts)

That means the current trust boundary is wrong for a share feature. A client can bypass the visible UI flow and create a share link for any clamped location it wants.

There is a related gap around session position authority:

- the websocket session already has a stable `clientSessionId`:
  - [`apps/web/src/clientSessionId.js`](../apps/web/src/clientSessionId.js)
  - [`apps/web/src/transportConfig.js`](../apps/web/src/transportConfig.js)
- but the worker does not currently track an authoritative session viewport
- and while `hello.spawn` is already server-generated, it is sampled from shared hub activity, not stored as a per-session authority anchor:
  - [`apps/worker/src/connectionShardSessionHost.ts`](../apps/worker/src/connectionShardSessionHost.ts)
  - [`apps/worker/src/connectionShardCursorHubActivity.ts`](../apps/worker/src/connectionShardCursorHubActivity.ts)
  - [`apps/worker/src/cursorHubDO.ts`](../apps/worker/src/cursorHubDO.ts)

So there are two distinct problems to fix:

- share-link creation trusts client-posted coordinates
- session location can become "authoritative" without being checked against the server-assigned spawn and plausible movement over time

## Goals

- Make share-link creation use only server-authoritative session viewport state.
- Tie authoritative viewport state to a live websocket session identified by `uid + clientSessionId`.
- Reject impossible session position jumps instead of accepting arbitrary `x/y`.
- Add movement-rate guardrails so session location cannot exceed plausible pan speed.
- Tighten spawn handling so the backend stores the exact spawn assigned to the session and uses it as the initial location anchor.
- Keep the external share URL format unchanged:
  - `?share=<guid>`
- Preserve the current "share a point-in-time view" semantics:
  - a share link still stores a concrete `x/y/zoom`
  - it is just sourced from server-tracked session state

## Non-Goals

- Do not make viewport state globally persistent across browser restarts as part of this work.
- Do not attempt to prove true human input authenticity. The goal is to enforce server-observed session movement bounds, not anti-cheat perfection.
- Do not redesign the share-link lookup format or TTL.
- Do not redesign the cursor hub or world spawn product behavior beyond what is needed to make session spawn authoritative.

## Current State

### Share Creation

Current flow:

1. browser reads local camera state
2. browser posts `{ x, y, zoom }` to `POST /share-links`
3. worker clamps and stores that payload in KV
4. worker returns a GUID share id

That logic lives in:

- [`apps/web/src/shareLinks.js`](../apps/web/src/shareLinks.js)
- [`apps/worker/src/workerFetch.ts`](../apps/worker/src/workerFetch.ts)

### Session Identity

The browser already creates a per-tab `clientSessionId` and attaches it to websocket connect URLs:

- [`apps/web/src/clientSessionId.js`](../apps/web/src/clientSessionId.js)
- [`apps/web/src/transportConfig.js`](../apps/web/src/transportConfig.js)

The worker already stores that value on connected clients:

- [`apps/worker/src/connectionShardDOOperations.ts`](../apps/worker/src/connectionShardDOOperations.ts)
- [`apps/worker/src/connectionShardSessionHost.ts`](../apps/worker/src/connectionShardSessionHost.ts)

This is the right session key to reuse for authoritative share creation.

### Client Viewport Changes

The client currently changes camera state locally only:

- wheel zoom mutates `camera.cellPixelSize`
- drag pan mutates `camera.x/y`
- no viewport message is sent to the worker today

Relevant code:

- [`apps/web/src/inputHandlers.js`](../apps/web/src/inputHandlers.js)
- [`apps/web/src/camera.js`](../apps/web/src/camera.js)

### Spawn Behavior

The backend already chooses `hello.spawn`, but it currently samples from shared recent edit or cursor activity and returns a jittered point:

- [`apps/worker/src/connectionShardCursorHubActivity.ts`](../apps/worker/src/connectionShardCursorHubActivity.ts)
- [`apps/worker/src/cursorHubDO.ts`](../apps/worker/src/cursorHubDO.ts)

That is better than a client-chosen spawn, but it is still not recorded as an authoritative session anchor that later viewport updates must respect.

## Desired Shape

Introduce an authoritative session-location model with three layers:

1. `session spawn`
   - exact server-assigned spawn sent in `hello`
   - stored on the connected session record
2. `last accepted viewport`
   - last server-accepted `x/y/zoom/timestamp`
   - updated only through validated realtime viewport messages
3. `share-link snapshot`
   - immutable `x/y/zoom` copied from the last accepted viewport at share-create time

High-level flow:

1. session connects over websocket with `uid + clientSessionId`
2. backend computes and stores a per-session spawn
3. backend sends that exact spawn in `hello`
4. client emits viewport updates over websocket as pan/zoom changes
5. shard validates each viewport update against:
   - world bounds
   - zoom bounds
   - maximum allowed movement over elapsed time
   - closeness to the stored session spawn for the initial update window
6. shard stores only accepted viewport updates
7. `POST /share-links` resolves the session shard and reads the last accepted viewport
8. worker stores that viewport in the share-link record

## Core Invariants

The implementation should enforce these invariants:

- share-link creation must not read `x/y/zoom` from the request body
- a share link may only be created for a live authenticated session with a fresh accepted viewport
- the first accepted viewport after connect must be close to the exact server-assigned spawn for that session, unless enough time has elapsed for the session to have plausibly panned there
- later viewport updates must remain within a server-defined movement envelope relative to the last accepted viewport
- the movement envelope must be based on elapsed time, not just absolute delta
- the worker must store the exact spawn it sent in `hello`, not recompute a different sample later

## Movement Guardrails

The server should validate viewport motion as a bounded-rate stream, not as unconstrained snapshots.

### Why A Rate Guard Is Needed

If the first accepted viewport can jump from the server spawn to anywhere in the world, then share creation is still effectively spoofable through the realtime path.

The fix is to make session location advance only at a plausible speed.

### Guard Model

Use the last accepted viewport as the motion anchor.

For each incoming viewport update:

- compute `dtMs = nowMs - previous.updatedAtMs`
- clamp `dtMs` into a sane range so reconnect stalls do not produce effectively infinite allowed travel
- compute `allowedDistanceCells = baseSlackCells + maxViewportSpeedCellsPerSec * (dtMs / 1000)`
- reject the update if planar distance from the previous accepted viewport exceeds `allowedDistanceCells`

The same pattern should apply to zoom:

- `allowedZoomDelta = baseZoomSlack + maxZoomChangePerSec * (dtMs / 1000)`
- reject updates that zoom faster than the server allows

### Choosing The Speed Limit

The user-facing requirement is:

- "When a user changes their `x/y` it can't exceed a specific speed, more or less how fast a user can pan across the board at max zoom out speed."

Implementation direction:

- express the limit in world cells per second
- calibrate it against the fastest plausible drag-pan at `MIN_CELL_PX`
  - [`packages/domain/src/constants.ts`](../packages/domain/src/constants.ts)
- add a small slack constant so normal event jitter or browser coalescing does not create false rejections

Recommended approach:

1. add a named worker constant such as `MAX_VIEWPORT_SPEED_CELLS_PER_SEC`
2. choose a conservative initial value based on max-zoom-out pan behavior
3. log rejected updates with delta and allowed envelope
4. tune only after observing real usage traces

Important constraint:

- this should be a speed guard, not an "accept one giant jump every N seconds" loophole
- cap the maximum `dtMs` that contributes to travel allowance so an idle tab cannot earn effectively unbounded teleport budget

Example validation shape:

```ts
const VIEWPORT_MAX_SPEED_CELLS_PER_SEC = 1200;
const VIEWPORT_BASE_SLACK_CELLS = 16;
const VIEWPORT_MAX_DT_MS = 5000;

function isViewportMovePlausible(previous, next, nowMs) {
  const dtMs = Math.max(0, Math.min(VIEWPORT_MAX_DT_MS, nowMs - previous.updatedAtMs));
  const allowedDistance =
    VIEWPORT_BASE_SLACK_CELLS +
    VIEWPORT_MAX_SPEED_CELLS_PER_SEC * (dtMs / 1000);

  return distance(previous.x, previous.y, next.x, next.y) <= allowedDistance;
}
```

The exact constant values should be finalized during implementation with traces, but the plan should treat the guard as mandatory, not optional.

## Spawn Tightening

### Current Risk

`hello.spawn` is already server-generated, but the session does not currently persist the exact spawn it sent to the client as the starting point for later viewport validation.

Without that, the first session viewport can still become authoritative without being checked against the server-assigned start position.

### Required Tightening

On websocket connect:

- resolve the spawn once
- store it on the connected session record
- send that exact stored spawn in `hello`

Then, when viewport updates arrive:

- if this is the first accepted viewport for the session, validate it against the stored spawn
- if it is too far from spawn for the elapsed time since connect, reject it

This closes the "fresh session teleports instantly, then creates a share link" path.

### Fallback Behavior

The session should always have a backend-defined starting point.

Preferred order:

1. sampled spawn from cursor hub activity
2. safe deterministic fallback spawn if the hub has no sample

That fallback should also be stored as the authoritative session spawn.

### Relation To Share Links

This work matters because the share-link endpoint should trust only `last accepted viewport`.

If initial viewport acceptance is too loose, share-link hardening becomes incomplete.

## Protocol Changes

Add a new websocket client message for viewport state.

Proposed message shape:

```ts
type ViewportClientMessage = {
  t: "viewport";
  x: number;
  y: number;
  zoom: number;
};
```

Update:

- [`packages/protocol/src/messages.ts`](../packages/protocol/src/messages.ts)
- [`packages/protocol/src/binary.ts`](../packages/protocol/src/binary.ts)

Client emission points:

- wheel zoom in [`apps/web/src/inputHandlers.js`](../apps/web/src/inputHandlers.js)
- drag pan in [`apps/web/src/inputHandlers.js`](../apps/web/src/inputHandlers.js)
- optionally once on websocket open so the server learns the initial visible viewport quickly

The message is not part of share-link creation itself. It is how the server learns the session viewport authoritatively.

## Worker State Changes

Extend the connected session record in:

- [`apps/worker/src/connectionShardDOOperations.ts`](../apps/worker/src/connectionShardDOOperations.ts)

Proposed shape:

```ts
interface SessionSpawnState {
  x: number;
  y: number;
  assignedAtMs: number;
}

interface SessionViewportState {
  x: number;
  y: number;
  zoom: number;
  updatedAtMs: number;
}

interface ConnectedClient {
  uid: string;
  clientSessionId?: string;
  sessionSpawn?: SessionSpawnState | null;
  lastViewport?: SessionViewportState | null;
}
```

The shard should own this state in memory. It does not need KV persistence for every pan/zoom event.

## Internal Worker APIs

The public worker needs a way to ask the owning shard for a session viewport.

Add an internal DO route such as:

- `GET /session-viewport?uid=...&clientSessionId=...`

Behavior:

- return `404` when the session is not connected or the session id does not match
- return `409` when the viewport is missing or stale
- return the accepted `x/y/zoom` when present and fresh

This route should stay internal to worker-to-DO communication.

## Share Endpoint Changes

Update [`apps/worker/src/workerFetch.ts`](../apps/worker/src/workerFetch.ts):

- stop parsing share-link coordinates from request JSON
- require:
  - valid bearer token
  - `x-sea-client-session-id` header
- derive the shard from authenticated `uid`
- fetch the authoritative viewport from that shard
- create the share-link record from the returned viewport

The share-link body can become empty or unused.

New failure modes should be explicit:

- `401` invalid or missing auth
- `409` no fresh server-side viewport for this session
- `503` share infrastructure unavailable

## Client Changes

### Share Creation

Update [`apps/web/src/shareLinks.js`](../apps/web/src/shareLinks.js):

- stop sending `camera.x/y/zoom`
- send `x-sea-client-session-id`
- keep bearer token support

### Viewport Emission

Update [`apps/web/src/inputHandlers.js`](../apps/web/src/inputHandlers.js):

- emit `viewport` after pan
- emit `viewport` after zoom
- consider emitting a debounced initial viewport after app boot or websocket open

### Boot And Reconnect

On reconnect, the client should re-send its current viewport quickly so the server regains authoritative state without waiting for the next manual pan/zoom.

## Security Notes

This change improves the trust boundary substantially, but it is important to state the exact security model:

- the server will no longer trust arbitrary share-link HTTP payloads
- the server will only trust session viewport state it has accepted under movement-rate limits
- this does not prove a human dragged the screen
- it does prevent trivial "POST any coordinate and mint a share URL" spoofing
- it also prevents immediate spawn-to-anywhere teleporting if the initial viewport anchor is enforced against the stored server spawn

## Phased Implementation Plan

### Phase 0: Characterize And Instrument

- [ ] Add a dedicated plan-backed implementation issue or ticket list if needed.
- [ ] Add logging for share-link creation attempts including `uid`, `clientSessionId`, and success/failure reason.
- [ ] Add logging for viewport acceptance/rejection reasons and envelope metrics.
- [ ] Confirm current reconnect and session replacement behavior for `clientSessionId`.

### Phase 1: Add Authoritative Session Spawn

- [ ] Extend `ConnectedClient` with stored `sessionSpawn` and `lastViewport`.
- [ ] Resolve spawn once on connect and store it before sending `hello`.
- [ ] Ensure the exact stored spawn is what goes into `hello`.
- [ ] Add a deterministic fallback spawn when no hub sample exists.

Required tests:

- [ ] websocket connect stores and sends the exact same spawn
- [ ] reconnect/replacement resets session anchor correctly
- [ ] fallback spawn path works when hub sample is unavailable

### Phase 2: Add Viewport Realtime Protocol

- [ ] Add `viewport` to client message schemas and binary codecs.
- [ ] Emit viewport updates from the web client.
- [ ] Handle `viewport` in shard message dispatch.
- [ ] Clamp and validate `x/y/zoom` before storing.

Required tests:

- [ ] protocol encode/decode coverage for `viewport`
- [ ] client-side send coverage for pan and zoom updates
- [ ] shard-side viewport acceptance coverage

### Phase 3: Enforce Movement Envelope

- [ ] Introduce speed and zoom-rate constants on the worker.
- [ ] Validate each viewport update against the previous accepted viewport.
- [ ] Validate the initial accepted viewport against the stored session spawn.
- [ ] Cap `dtMs` used for allowance so idle time cannot buy unbounded travel.
- [ ] Log rejection reasons with enough fields to tune safely.

Required tests:

- [ ] accepts small plausible moves
- [ ] rejects impossible large jumps
- [ ] rejects immediate far-from-spawn initial viewport
- [ ] accepts larger travel only when enough time has elapsed within capped limits
- [ ] rejects impossible zoom jumps

### Phase 4: Change Share Creation To Use Session Viewport

- [ ] Add internal shard lookup for `uid + clientSessionId`.
- [ ] Require bearer token plus `x-sea-client-session-id` on `POST /share-links`.
- [ ] Remove request-body coordinate authority from the endpoint.
- [ ] Return clear status codes for missing, stale, or mismatched session viewport state.

Required tests:

- [ ] share creation succeeds from stored authoritative viewport
- [ ] posted `x/y/zoom` is ignored or rejected
- [ ] wrong `clientSessionId` fails
- [ ] stale viewport fails
- [ ] unauthenticated share creation fails

### Phase 5: Reconnect And UX Hardening

- [ ] Re-send viewport after websocket reconnect.
- [ ] Show a clear user-facing status if share creation fails because the server has no fresh viewport yet.
- [ ] Decide whether one accepted viewport is enough after reconnect or whether a short freshness window is required.

Required tests:

- [ ] reconnect then share works after viewport refresh
- [ ] reconnect without viewport refresh fails cleanly

## Testing Inventory

Likely files to update:

- [`packages/protocol/test/messages.client.test.ts`](../packages/protocol/test/messages.client.test.ts)
- [`packages/protocol/test/codec.test.ts`](../packages/protocol/test/codec.test.ts)
- [`apps/web/test/shareLinks.test.js`](../apps/web/test/shareLinks.test.js)
- [`apps/web/test/inputHandlers.cursorEmit.test.js`](../apps/web/test/inputHandlers.cursorEmit.test.js)
- [`apps/worker/test/worker.connectionShard-websocket.test.ts`](../apps/worker/test/worker.connectionShard-websocket.test.ts)
- [`apps/worker/test/worker.fetch-routing.test.ts`](../apps/worker/test/worker.fetch-routing.test.ts)

Additional focused tests may be warranted for movement-envelope helpers if the validation logic is extracted into a pure helper module.

## Open Questions

- What exact initial value should `MAX_VIEWPORT_SPEED_CELLS_PER_SEC` use?
- Should zoom-rate enforcement be symmetric for zoom-in and zoom-out, or separately tuned?
- Should the share endpoint require a currently connected session, or is a recently disconnected but still-fresh viewport acceptable?
- Should anonymous sessions be allowed to create share links under this stricter model, or should authenticated sessions be required?
- If the cursor hub has no spawn sample, what deterministic fallback is best:
  - world origin
  - per-session hash-based spawn
  - last known recent edit fallback from another backend source

## Recommended Default Decisions

To keep the implementation bounded:

- require bearer auth for authoritative share creation
- require active or very recent session viewport state
- store exact server-assigned spawn on connect
- reject impossible first-hop viewport jumps
- treat movement-rate validation as mandatory, not as best-effort telemetry

That gives a coherent security story:

- backend chooses spawn
- backend tracks session viewport under bounded motion
- backend creates share links from that tracked viewport only
