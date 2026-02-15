# Massive Checkbox Canvas — Technical Specification (v0.1)

## 1. Product Overview

### Goal

Build a highly scalable, multiplayer, zoomable checkbox canvas where:

* Users can zoom from “8-bit art” view to normal checkbox size
* Millions of checkboxes exist in a virtual grid
* Only visible tiles are loaded
* Multiple users interact in realtime
* Cursor presence is visible (capped) with username labels
* Checkbox state is globally shared
* Running cost remains very low at scale

---

## 2. Core Requirements

### Functional

* Infinite logical checkbox grid (bounded for safety, see §3.X)
* WebGL rendering (no DOM checkbox nodes)
* Tile-based virtualization (subscribe only to visible tiles)
* Realtime shared checkbox state
* Anonymous users with generated usernames (AdjectiveNoun###)
* Remote cursors visible for users in view (max 10), with name labels
* Spawn near recent activity
* Client-only heat/cooldown visualization (no server feedback required)
* Edit disabled at far zoom (“8-bit mode”)

### Non-Functional

* Thousands of concurrent users
* Responsive rendering (no “all checkboxes in DOM”)
* Cursor updates may be lossy; checkbox updates must converge correctly
* Low operational overhead and low running cost

Absolutely — the cleanest place is a short **Engineering Principles** section early in the doc (right after the requirements), plus a small “layer boundaries” note in the infra section. Here’s the merged insert you can paste in.

---

## 2.1 Engineering Principles and Layer Separation

### Single Responsibility Principle

Each component/module MUST have a clear, narrow responsibility:

* **Renderer (WebGL):** draw only (no networking, no persistence logic)
* **Client State / Simulation:** camera state, tile cache, heat/cooldown, cursor smoothing
* **Network Layer:** WebSocket connect/reconnect, message encode/decode, backpressure handling
* **Domain Layer:** tile math, cell indexing, versioning rules, validation helpers
* **Backend Router (Worker):** identity/spawn + routing only (no tile authority)
* **ConnectionShard DO:** WebSocket ownership + subscription management + fanout only
* **TileOwner DO:** tile authority + ordering + persistence only
* **Storage Layer (R2):** snapshots only (no realtime responsibilities)

Implementations SHOULD avoid “god objects” and mixed concerns (e.g., avoid combining rendering + protocol parsing + cache eviction in one class).

### Separation of Layers (strict boundaries)

Code MUST be organized such that higher-level layers depend on lower-level layers, not vice versa:

1. **Domain (pure):** math, indices, bounds, encodings
2. **State:** tile cache, camera, heat/cooldown, cursor smoothing
3. **Transport:** WebSocket, reconnection, message framing
4. **Presentation:** WebGL draw loop, UI overlay/HUD

Rules:

* Presentation MUST NOT directly call persistence or DO-specific logic.
* Transport MUST NOT contain WebGL rendering code.
* Domain utilities MUST be deterministic and unit-testable (no side effects).

### Testability as a design constraint

Modules MUST be written so that:

* domain + state layers are unit-testable without WebGL or network
* transport can be tested with mocked sockets
* backend DO logic can be tested with local runners using deterministic inputs

---

## 3. World Model

### Coordinate System

* Infinite integer grid `(x, y)`; each cell is a checkbox.
* World is bounded in practice for numeric safety (see §3.1).

### Tile Partitioning

**Constants (initial defaults):**

```
TILE_SIZE = 64            // cells per tile side
TILE_CELL_COUNT = 4096    // 64×64
MIN_CELL_PX = 4           // zoom-out cap (8-bit mode)
EDIT_MIN_CELL_PX = 8      // editing enabled threshold
```

### Tile Key

```
tx = floor(x / TILE_SIZE)
ty = floor(y / TILE_SIZE)
tileKey = `${tx}:${ty}`
```

### Cell Index Within Tile

```
localX = x mod TILE_SIZE
localY = y mod TILE_SIZE
cellIndex = localY * TILE_SIZE + localX
```

---

## 3.1 Numeric Ranges, Overflow Safety, Validation

### Rationale

Prevent crashes, NaNs, GPU jitter, storage abuse, and malicious payloads from extreme coordinates.

### Recommended bounds (default)

```
WORLD_MAX = 1_000_000_000   // 1e9 (adjustable)
MAX_TILE_ABS = floor(WORLD_MAX / TILE_SIZE)
```

### Client requirements

* Camera center MUST be clamped to `[-WORLD_MAX, +WORLD_MAX]` for both axes.
* Client MUST reject/ignore any inbound cursor/tile coordinates that are non-finite.
* WebGL SHOULD render in local space relative to camera center (avoid huge absolute coords in shaders).

### Server requirements

For any inbound message containing coordinates or indices, server MUST validate:

* all numeric fields are finite (not NaN/Infinity)
* `abs(x), abs(y) <= WORLD_MAX` when applicable
* parsed `tx,ty` satisfy `abs(tx), abs(ty) <= MAX_TILE_ABS`
* `cellIndex` is integer and `0 <= i < TILE_CELL_COUNT`
* tileKey parsing is strict (no loose string handling)

---

## 4. Zoom & Interaction Rules

### Zoom Limits

Camera zoom is clamped so:

```
cellPixelSize >= MIN_CELL_PX
```

Default `MIN_CELL_PX = 4` to support 8-bit art aesthetics.

### Edit Gating

Editing allowed only when:

```
cellPixelSize >= EDIT_MIN_CELL_PX
```

Default `EDIT_MIN_CELL_PX = 8`.

When below threshold, client MUST:

* ignore toggle attempts
* not send `setCell`
* show hint: “Zoom in to edit”
* optionally show disabled cursor indicator

Server MAY also reject edits below threshold (defensive), but client gating is required.

---

## 5. Frontend Architecture

### 5.1 Rendering (WebGL)

* Use instanced quads per visible cell.
* Level of Detail (LOD):

| Zoom Level  | Rendering            |
| ----------- | -------------------- |
| Far (8-bit) | solid pixel/block    |
| Mid         | outline + fill       |
| Near        | checkbox + checkmark |

* No DOM checkboxes: only a `<canvas>` plus minimal HUD.

### 5.2 Tile Virtualization

Client maintains:

* `visibleTiles = tiles intersecting viewport + margin`
* `tileCache = LRU cache` of decoded tile bitsets

Client sends subscribe/unsubscribe as viewport moves.

### 5.3 Cursor Rendering, Labels, and Color

* Each remote cursor is drawn in WebGL (or a lightweight overlay) with:

  * a colored pointer/marker
  * the user’s `username` rendered near the cursor (offset from tip)
* Text MUST be readable (outline/shadow) and should avoid overlapping the cursor tip.

**Cursor color generation (client-side, no extra bytes):**

* Client derives a stable color from `uid`:

  * `hue = hash(uid) % 360`
  * use fixed saturation/lightness constants for readability
* The same `uid` always maps to the same color within a session.

**Visibility:**

* Display up to `MAX_REMOTE_CURSORS = 10` remote cursors in view:

  * choose nearest-to-camera or most-recently-seen within viewport

**Smoothing:**

* Apply buffered interpolation (≈100ms) and optional short extrapolation (<150ms).
* Fade/remove cursor after 3–5 seconds without updates.

### 5.4 Client Heat & Cooldown (Local Only)

Per visible cell maintain `heat ∈ [0,1]`.

Defaults:

```
HEAT_BUMP = 0.15
HEAT_TAU  = 10s
HOT_DISABLE_THRESHOLD = 0.8
HOT_DISABLE_MS = 1000
```

On each incoming checkbox update affecting cell `i`:

* `heat[i] = min(1, heat[i] + HEAT_BUMP)`
* visually tint cell based on heat
* if `heat[i] > HOT_DISABLE_THRESHOLD`, locally disable toggling cell `i` for `HOT_DISABLE_MS`

Decay each frame/tick:

* `heat[i] *= exp(-dt / HEAT_TAU)`

This is purely a client UX feature (no server signaling required).

---

## 6. Realtime Protocol (v0.1 JSON)

Transport: WebSocket

### 6.1 Client → Server

**Subscribe tiles**

```json
{ "t":"sub", "tiles":["12:44","12:45"] }
```

**Unsubscribe**

```json
{ "t":"unsub", "tiles":["12:44"] }
```

**Set cell**

```json
{
  "t":"setCell",
  "tile":"12:44",
  "i":1337,
  "v":1,
  "op":"uuid"
}
```

**Cursor update**

```json
{ "t":"cur", "x":1234.5, "y":-88.1 }
```

**Resync tile**

```json
{ "t":"resyncTile", "tile":"12:44", "haveVer":1843 }
```

### 6.2 Server → Client

**Hello (no cursor color included)**

```json
{ "t":"hello", "uid":"u_xxx", "name":"BriskOtter481" }
```

**Tile snapshot**

```json
{
  "t":"tileSnap",
  "tile":"12:44",
  "ver":1842,
  "enc":"rle64",
  "bits":"..."
}
```

**Single cell update**

```json
{
  "t":"cellUp",
  "tile":"12:44",
  "i":1337,
  "v":1,
  "ver":1843
}
```

**Batched updates (preferred)**

```json
{
  "t":"cellUpBatch",
  "tile":"12:44",
  "fromVer":1843,
  "toVer":1851,
  "ops":[[1337,1],[12,0]]
}
```

**Cursor update (name included; client derives color from uid)**

```json
{
  "t":"curUp",
  "uid":"u_xxx",
  "name":"BriskOtter481",
  "x":123,
  "y":456
}
```

---

## 7. Cloudflare Infrastructure (Pattern A)

### 7.1 Components

* Cloudflare Pages / Workers Static Assets — frontend hosting
* Cloudflare Worker — stateless router + APIs + WS upgrade
* Durable Objects:

  * ConnectionShard DO (client-facing sockets)
  * TileOwner DO (authoritative per tile / tile-group)
* Cloudflare R2 — tile snapshot storage

### 7.2 High-Level Architecture Diagram

```
Browser
  │
  │ WebSocket
  ▼
Cloudflare Worker (router + /api/hello)
  │ forwards WS
  ▼
ConnectionShard DO  ──────────────┐
  │ watchTile/register             │ broadcasts
  ▼                               │
TileOwner DO (authoritative) ◄────┘
  │
  ▼
R2 (tile snapshots)
```

* **Layer boundary enforcement:** only Worker handles public HTTP/WS upgrade routing; TileOwner DO MUST NOT be directly client-facing; all client-originating writes pass through ConnectionShard for validation and rate limiting.


---

## 8. Durable Object Roles (Pattern A)

### 8.1 ConnectionShard DO (key: shardId)

**Purpose:** Own the WebSocket connections; manage per-client subscriptions.

Responsibilities:

* Hold WS connections
* Track which tiles each client is subscribed to
* Enforce subscription caps and churn limits
* For each newly subscribed tile:

  * register itself as a watcher with that tile’s TileOwner DO
* Forward `setCell` intents to TileOwner DO
* Receive tile snapshots/deltas from TileOwner and fan out to local clients
* Relay cursor updates best-effort (coalesce/limit)

### 8.2 TileOwner DO (key: tileKey or tile-group)

**Purpose:** Authoritative owner of tile state, ordering, and persistence.

Responsibilities:

* Load tile snapshot from R2 on cold start
* Maintain:

  * tile bitset (checked state)
  * tile version (monotonic)
  * watcher shard set (ConnectionShards currently watching)
  * recent edits ring buffer (for spawn-near-activity)
* Apply incoming `setCell` operations
* Broadcast updates (`cellUpBatch`) to watching ConnectionShards
* Periodically write compressed tile snapshots to R2

### 8.3 Watcher Registration and Fanout Diagram

```
(1) Client viewport changes
      │
      ▼
ConnectionShard subscribes tiles for that client
      │
      ├─ register watcher with TileOwner(tileA)
      ├─ register watcher with TileOwner(tileB)
      ▼
TileOwner(tileX) tracks watchers: {shard1, shard7, shard9}

(2) Any write to tileX
      │
      ▼
TileOwner(tileX) → broadcasts to shard1, shard7, shard9
      │
      ▼
Each ConnectionShard → forwards to its local WS clients subscribed to tileX
```

---

## 9. Persistence Strategy

### 9.1 Snapshot Storage (R2)

Store per tile:

* compressed bitset
* version

Example key:

```
tiles/v1/tx=12/ty=44.bin
```

### 9.2 WAL (Write-Ahead Log)

TileOwner maintains an **in-memory WAL**:

* short list of recent ops used for batching outgoing updates and deciding when to snapshot
* WAL is not durable; durability comes from R2 snapshots

### 9.3 Snapshot Cadence (defaults)

* every 5 seconds OR
* every 500 operations
  (whichever comes first)

---

## 10. Subscription & Abuse Protection

### Limits (initial defaults)

```
MAX_TILES_SUBSCRIBED     = 300
MAX_TILE_CHURN_PER_MIN   = 600
MAX_REMOTE_CURSORS       = 10
SETCELL_BURST            = 20 / sec
SETCELL_SUSTAINED        = 5 / sec
```

Server MUST enforce. Client SHOULD behave conservatively and avoid thrash.

### Hot Tile Protection

If watcher count for a tile becomes very large:

* TileOwner increases batching for that tile
* ConnectionShards may drop/decimate cursor relays first
* Checkbox updates must remain correct and ordered per tile version

---

## 11. Spawn Near Activity

TileOwner maintains recent edit positions (world coords or tile+cell).

On `GET /api/hello`, Worker:

* selects a recent edit location (sample from recent ring buffers)
* adds random jitter
* returns spawn camera `{x,y,zoom}`

---

## 12. Monitoring & Observability

### Required structured logs

Log events (Worker + DOs):

* `ws_connect`, `ws_close`
* `sub`, `unsub` (tile counts, clamped yes/no)
* `setCell` (accepted/rejected)
* `broadcast` (batch size, watcher count)
* `snapshot_read`, `snapshot_write` (bytes, duration, errors)
* `resyncTile` frequency

### Metrics/SLOs

Track:

* tile resync rate (indicator of missed deltas/overload)
* WS disconnect rate
* DO p95 latency for setCell and subscribe flows
* snapshot failures / R2 error rate
* number of “hot” TileOwners active

### Alerts (initial)

* resync rate spike
* error rate > 1%
* any sustained snapshot failure
* WS disconnect spike
* p95 latency above target threshold

---

## 13. Testing Strategy

### Unit tests

* tile math (tileKey, cellIndex, viewport enumeration)
* encoding/decoding snapshots + batches
* cursor smoothing interpolation
* heat/cooldown decay behavior
* bounds/validation helpers

### DO integration tests (local)

Using a local DO-capable runner (e.g., Miniflare/Wrangler):

* multiple ConnectionShards watch same TileOwner → both receive updates
* version jumps trigger resync, client converges
* subscription caps and churn limits enforced

### E2E tests (Playwright)

* two clients see same checkbox updates
* cursor labels visible; smoothing works
* zoom gating prevents edits in 8-bit mode
* no DOM checkbox nodes (canvas only)

### Load tests

Simulate:

* 1k–10k clients
* moderate cursor traffic
* low-to-moderate toggle rate
  Measure:
* broadcast latency p50/p95
* disconnect rate
* correctness (no lost checkbox updates; resync should be rare)