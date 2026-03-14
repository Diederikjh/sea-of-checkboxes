# Scalability Testing Plan

This folder is for planning and building live-backend scalability testing for Sea of Checkboxes.

The target is not only "how many users can connect", but "how the real backend behaves under distinct load shapes" so we can debug failures from logs and reproduce them reliably.

## Goals

- hit the real deployed Worker, Durable Objects, and persistence paths
- simulate `10`, `50`, and `200` concurrent users without requiring `200` real browsers
- keep each run debuggable after the fact with per-bot logs and run-level summaries
- fail safe on operator interrupt so the swarm stops quickly and cannot keep hammering the backend
- make load shapes explicit: hot tile, spread editing, cursor-heavy, reconnect burst, viewport churn
- leave room for human-visible canaries so someone can watch the board and confirm bot behavior looks sane
- support a configurable remote swarm origin so tests run away from normal user activity

## Non-Goals

- replace manual browser testing
- benchmark only browser rendering performance
- hide backend guardrails such as `tile_readonly_hot` or `tile_sub_denied`

## Current Status

Implemented now:

- one live protocol bot CLI at `scripts/swarm/swarm-bot.mjs`
- shared JS protocol, config, metrics, and session helpers in `scripts/swarm/lib/`
- per-bot NDJSON event logs and per-bot summary JSON
- focused tests for the Phase 1 bot path

Current output shape:

- one NDJSON file per bot process:
  - `logs/swarm/<run-id>/bots/<bot-id>.ndjson`
- one summary JSON file per bot process:
  - `logs/swarm/<run-id>/bots/<bot-id>-summary.json`
- coordinator run config and summary may also include a share link for the swarm origin so a human can inspect the board location directly

Every log record also carries `runId` and `botId`, so the writer is identifiable both from the filename and from the file contents.

## Dev-Local Operation Note

For dev-local swarm runs against a local worker, both sides need to run outside the sandbox:

- `pnpm dev:worker` may need unsandboxed execution because `pnpm dlx wrangler` resolves tooling over the network
- `pnpm swarm:run` may need unsandboxed execution because local HTTP and websocket traffic to the dev worker can be blocked in the sandbox
- if either side is sandboxed, the run can fail before useful protocol activity begins:
  - share-link creation can fail
  - bots may never reach `hello`
  - resulting logs are not valid for backend diagnosis

This matters for local cursor investigation work in particular, because the whole point is to correlate swarm timing with captured dev-worker stdout in the same run folder.

## Production Swarm Method

Use this when you want to exercise the real Cloudflare deployment with the swarm bots.

Current production endpoints:

- app: `https://sea-of-checkboxes-web.pages.dev`
- websocket: `wss://sea-of-checkboxes-worker.diederikjhattingh.workers.dev/ws`

Recommended production run shape while investigating cursor behavior:

- `4` to `8` bots
- `30s` to `60s`
- keep the remote origin in the isolated top-right test sector
- do not start with large write-heavy swarms against production

Example command:

```bash
pnpm swarm:run \
  --ws-url wss://sea-of-checkboxes-worker.diederikjhattingh.workers.dev/ws \
  --app-url https://sea-of-checkboxes-web.pages.dev \
  --run-id cursor-probe-prod-30s-b4-sample \
  --bot-count 4 \
  --duration-ms 30000
```

What this produces:

- `logs/swarm/<run-id>/coordinator.log`
- `logs/swarm/<run-id>/summary.json`
- `logs/swarm/<run-id>/bots/<bot-id>.ndjson`
- `logs/swarm/<run-id>/bots/<bot-id>-summary.json`

What it does not produce automatically:

- production worker stdout capture

For production, server-side analysis must come from Cloudflare worker logs queried after the fact.

Practical production-debug flow:

1. run the swarm with an explicit `runId`
2. inspect `summary.json` for slow shards, missing peers, and sparse `remoteCursorCountsByPeer`
3. take `uid`, `shard`, `clientSessionId`, `op`, and timestamps from the bot logs
4. query worker logs for the same time window and shard/client session

Examples:

```bash
pnpm logs:server:query \
  --from 2026-03-13T20:22:50Z \
  --to 2026-03-13T20:23:30Z \
  --filter source.client_session_id:eq:swarm_cursor-probe-prod-30s-b4-sample_bot-004 \
  --format ndjson

pnpm logs:server:query \
  --from 2026-03-13T20:22:50Z \
  --to 2026-03-13T20:23:30Z \
  --shard shard-5 \
  --event cursor_pull_peer \
  --format ndjson
```

Human verification:

- the coordinator creates a share link at run start
- open that link in the deployed app to confirm the bot sector and visually check that writes and cursors are appearing in the expected remote area

## Current Cursor Debug Result

Recent local swarm-backed cursor probes are already useful for debugging the delayed initial cursor problem:

- one run after the shorter empty-scope probe change showed all shards seeing first remote cursors in about `0.9s` to `1.3s`
- a later rerun still showed one shard taking about `10s`, even though peer scope had arrived promptly

Current takeaway:

- the shorter empty-scope probe helped, but it is only a partial fix
- the swarm harness is now good enough to distinguish:
  - late peer discovery
  - prompt peer discovery followed by delayed first useful reverse pull
- the later local burstiness investigation found another scope problem:
  - shards that already had one watched peer could fall back to `60s` watch renews too early
  - if a second peer arrived shortly after, that peer could remain undiscovered for the rest of a `30s` run
- current local mitigation:
  - keep fast watch renews for a short settling window after peer scope changes
  - this improved local `curUp` continuity materially in the latest `v13` run

## Proposed Layout

Current and planned scripts:

- `scripts/swarm/run-swarm.mjs`
  - top-level coordinator
  - starts a run and launches bot processes
  - initial implementation is a small short-duration coordinator for smoke runs
- `scripts/swarm/swarm-bot.mjs`
  - single lightweight protocol bot process
  - connects to the live websocket backend and executes assigned actions
- `scripts/swarm/scenarios/*.mjs`
  - scenario definitions and action generators
- `scripts/swarm/lib/*.mjs`
  - shared protocol, timing, logging, metrics, and orchestration helpers
- `scripts/swarm/report-run.mjs`
  - reads bot logs and produces a concise run summary

Planned output:

- `logs/swarm/<run-id>/run-config.json`
- `logs/swarm/<run-id>/coordinator.log`
- `logs/swarm/<run-id>/summary.json`
- `logs/swarm/<run-id>/bots/<bot-id>.ndjson`
- `logs/swarm/<run-id>/bots/<bot-id>-summary.json`
- optional canary browser logs in `logs/swarm/<run-id>/canary-*.log`
- share-link metadata at run start when the backend supports share-link creation

## Safety Requirements

### 1. Fast cancellation is mandatory

If the coordinator receives `Ctrl+C` or any termination signal, it must stop the swarm quickly.

Required behavior:

- stop scheduling new actions immediately
- broadcast shutdown to every bot immediately
- force-kill any bot that does not exit within a short grace period
- write a partial run summary so we know the shutdown was intentional

This is a safety feature, not a convenience feature. A broken shutdown path could create a runaway event storm against the live backend.

Initial shutdown target:

- graceful stop attempt starts immediately on first signal
- hard kill after a short timeout, likely around `1s` to `3s`
- second `Ctrl+C` skips waiting and kills immediately

### 2. Remote swarm origin is required

Bots should run from a configurable board origin in a remote test sector rather than around normal user activity.

Initial expectation:

- use a far top-right region of the world
- keep all scenario coordinates relative to a configured origin
- allow the coordinator to override the origin per run

The exact coordinate can stay configurable, but the framework should treat it as first-class configuration from the start.

## Test Requirements For The Swarm Tooling

The swarm scripts are test infrastructure, but they still need their own correctness checks.

The goal is not exhaustive coverage. The goal is to cover the failure-prone core behaviors so we can trust the tooling when it reports backend problems.

### Minimum coverage expectations

- argument parsing and run-config normalization
- deterministic scenario selection from a seed
- scenario coordinate generation relative to swarm origin
- protocol message construction for the main bot actions
- bot lifecycle transitions: connect, active, stopping, stopped
- latency measurement and metric rollup logic
- coordinator shutdown behavior on first and second interrupt
- hard-kill escalation when a bot ignores graceful shutdown
- report generation from sample bot logs

### Test layers

#### Unit tests

Use unit tests for:

- scenario generators
- metric aggregation helpers
- log formatting helpers
- seed and randomization helpers
- shutdown state transitions

#### Integration tests

Use integration tests for:

- coordinator spawning one or more fake bots
- signal-driven shutdown and forced termination
- bot behavior against a fake websocket server or stub transport
- end-to-end run summary generation from test logs

#### Non-goal for the first pass

We do not need exhaustive simulation of the full production backend in swarm-tool tests.

The purpose of these tests is to prove:

- the bots do what we think they do
- the coordinator can stop them quickly
- the measurements and summaries are believable

## Core Design

### 1. Use protocol bots for scale

Most simulated users should be lightweight websocket protocol clients, not browsers.

Reason:

- they still hit the real Worker and Durable Objects
- they are cheaper and easier to run at `50` and `200`
- they let us control timing, jitter, reconnects, and scenario composition precisely

These bots should use the same wire protocol as production clients so the backend path is real.

### 2. Keep a small number of visible canaries

For some runs we should also launch a small number of real browser clients:

- `2` to `5` browser canaries during medium and large runs
- these help validate that the board still looks sane to a human observer
- these reuse the existing client log capture flow from [docs/debug-log-capture.md](/home/diederik/dev/sea-of-checkboxes/docs/debug-log-capture.md)

### 3. Prefer semantic actions over raw mouse replay

Recorded sessions should eventually be stored as semantic actions:

- connect
- subscribe / unsubscribe
- move viewport
- move cursor
- set cell
- idle
- disconnect / reconnect

Reason:

- easier to mutate than raw coordinate streams
- easier to offset spatially
- easier to speed up or slow down
- easier to combine multiple scenarios in one run

Raw pointer replay can still be added later as one source of semantic events.

## Script Plan

### `run-swarm.mjs`

Purpose:

- create a run id
- choose scenario mix
- start bots with assigned roles
- optionally start browser canaries
- collect exit codes and roll up results

Inputs:

- target websocket URL
- bot count
- run duration
- scenario pool
- random seed
- scenario count to combine, initially `2`
- canary browser count
- swarm origin coordinate, for example `originX` and `originY`

Initial implemented defaults:

- `2` bots
- about `10s` duration
- one active Phase 1 bot plus one read-only lurker bot
- small origin offsets per bot so they do not overlap exactly

Measurements:

- planned bot count vs started count
- scenario mix selected
- run start and end timestamps
- bot exit counts
- bot disconnect and reconnect totals
- run-level error counts
- run-level latency aggregates from child summaries
- shutdown duration after interrupt
- number of bots requiring force kill

Coordinator output should be deterministic enough that a failed run can be reproduced with the same seed and config.

Shutdown behavior:

- first signal puts the run into `stopping` state and stops all new work
- coordinator tells bots to exit immediately
- coordinator escalates to hard kill after the grace timeout
- second signal kills child processes immediately and exits

### `swarm-bot.mjs`

Purpose:

- act as one live user over websocket
- subscribe, move, edit, idle, and reconnect according to an assigned scenario plan

Bot behavior should support:

- stable bot identity
- scenario-specific pacing
- randomized jitter
- limited local state for subscribed tiles and recent versions
- structured per-bot log output
- immediate shutdown on coordinator signal
- coordinate generation relative to the configured swarm origin

Implemented now:

- anonymous connect to the real `/ws` endpoint
- token reuse after `hello`
- initial subscribe to the origin tile
- periodic cursor sends
- optional periodic `setCell`
- per-bot NDJSON and summary output

Measurements:

- connect latency
- hello latency
- subscribe request count
- subscribe ack latency
- cursor send count
- setCell send count
- setCell accepted / rejected count
- time from local setCell send to authoritative cell update
- authoritative update count received
- websocket close count
- reconnect count
- max pending in-flight operations
- error message count by code
- stop latency after shutdown command

Each bot log entry should include:

- `runId`
- `botId`
- `scenarioId`
- `phase`
- `ts`
- `event`
- correlation fields like `cid`, `op`, `tile`, `i`
- swarm-origin metadata for spatial debugging

### `report-run.mjs`

Purpose:

- turn many bot logs into one summary we can inspect quickly

Measurements:

- p50 / p95 / p99 edit convergence time
- p50 / p95 subscribe ack time
- rejection counts by reason
- reconnect counts
- error counts by code
- per-scenario totals
- hottest tiles by action volume
- bots with the worst latency or highest error rates

The report should produce:

- machine-readable `summary.json`
- short human-readable console output

## Scenario Plan

We should treat scenarios as composable action generators.

Each scenario definition should declare:

- intent
- user count range
- pacing defaults
- spatial strategy
- reconnect policy
- measurements of interest
- whether the scenario must stay near the swarm origin or may roam farther away

### Scenario: Hot Tile Contention

Intent:

- many users converge on the same tile or same small cluster of cells

Behavior:

- subscribe to one hotspot
- perform repeated edits on a narrow cell set
- include some idle watchers who only observe
- hotspot is chosen relative to the configured swarm origin

Measurements:

- `tile_readonly_hot` rate
- `tile_sub_denied` rate
- accepted vs rejected writes
- edit convergence latency under contention
- watcher count inferred from server responses and errors

### Scenario: Spread Editing

Intent:

- represent healthier distributed load

Behavior:

- assign each bot a different tile neighborhood
- pan occasionally
- edit at moderate rates
- neighborhoods are distributed relative to the configured swarm origin

Measurements:

- successful write rate
- snapshot and subscription latency
- cross-tile throughput
- whether any single tile still becomes a hotspot unexpectedly

### Scenario: Read-Only Lurker

Intent:

- validate the passive observer experience for users who mostly watch and do not edit

Behavior:

- subscribe to one or more active areas
- send little or no edit traffic
- use occasional cursor motion or none at all, depending on the recipe
- remain connected for longer steady-state observation windows
- optionally pan slowly between nearby active regions relative to the configured swarm origin

Measurements:

- connect and hello latency
- snapshot and subscription latency
- time to first visible remote cursor for cursor-capable lurkers
- authoritative update receipt rate while observing active editors
- websocket stability over longer idle periods
- unexpected errors or disconnects while mostly idle

### Scenario: Cursor Heavy

Intent:

- stress cursor fanout and pull paths more than cell writes

Behavior:

- frequent cursor movement
- light editing
- periodic viewport moves
- cursor paths stay inside a bounded area around the configured swarm origin unless a run explicitly allows wider roaming

Measurements:

- cursor send rate
- remote cursor update receipt rate
- websocket error count
- any correlated server-side `cursor_pull_peer`, `internal_error`, or `server_error_sent`

### Scenario: Viewport Churn

Intent:

- stress subscribe / unsubscribe and rebuild behavior

Behavior:

- move viewport across tile boundaries on a schedule
- maintain moderate cursor traffic
- perform light edits after each move
- movement starts from the configured swarm origin and expands outward by scenario rules

Measurements:

- subscribe and unsubscribe counts
- subAck latency
- repeated `subAck` with no effective change
- local periods where edits fail because subscription state lags movement

### Scenario: Reconnect Burst

Intent:

- stress reconnect handling and replay behavior

Behavior:

- force a slice of bots offline together
- reconnect them in a narrow time window
- resume prior scenario actions
- resume near the same origin-relative area unless the scenario says otherwise

Measurements:

- reconnect completion time
- websocket close reasons
- pending action replay counts
- post-reconnect edit latency
- duplicate or dropped action indicators

### Scenario: Soak

Intent:

- catch slow degradation and persistence issues

Behavior:

- long duration
- moderate mixed activity
- mild random reconnects

Measurements:

- latency drift over time
- error rate over time
- reconnection accumulation
- whether hot tiles emerge naturally

## Scenario Selection

Initial coordinator behavior:

1. choose `2` scenarios at random from an allowed pool
2. assign each bot a primary scenario
3. optionally reserve a small percentage of bots as observers or canaries
4. add timing and spatial jitter so all bots do not synchronize on exact same milliseconds

Later expansions:

- weighted scenario selection
- fixed named run recipes
- time-phased runs where the active scenario mix changes mid-run

## Logging Plan

The swarm must be debuggable from logs first.

### Bot logs

Use NDJSON for easy filtering and aggregation.

Each bot should log:

- lifecycle events
- outbound protocol actions
- inbound protocol messages relevant to correlation
- latency checkpoints
- local metric flushes
- final summary
- shutdown start and shutdown completion

### Run logs

The coordinator should log:

- run config
- random seed
- selected scenarios
- child process assignments
- child failures
- final summary location
- signal handling and shutdown escalation events

### Server correlation

We should continue to use:

- `pnpm logs:server:capture`
- `pnpm logs:server:query`

from [docs/debug-log-capture.md](/home/diederik/dev/sea-of-checkboxes/docs/debug-log-capture.md).

Bot-generated correlation ids should make it easy to pivot from:

- a bot log event
- to a websocket error or latency spike
- to matching server `setCell_received`, `setCell`, or cursor-path logs

### Cursor visibility evidence requirements

For the slow initial cursor visibility problem, generic bot logs are not enough by themselves.

This requirement applies only to cursor-focused scenarios or runs explicitly marked for cursor investigation. It does not need to be covered by every swarm scenario.

For cursor-investigation runs, the swarm plan should explicitly capture the evidence needed to answer:

- did the source bot publish cursor movement continuously
- did the source shard include that movement in `/cursor-state`
- did the destination shard ingest newer cursor versions
- did the destination fan out the update to its client

For those runs, we should require:

- bot-side timestamp for first local cursor send after connect
- bot-side timestamp for first remote cursor receipt per peer
- bot-side counts of remote cursor updates per peer over time
- run tagging that marks the scenario as cursor-investigation capable
- server-log queries correlated to:
  - `cursor_pull_scope`
  - `cursor_pull_watch_scope_wake`
  - `cursor_pull_alarm_armed`
  - `cursor_pull_alarm_fired`
  - `cursor_pull_peer`
  - `cursor_pull_first_peer_visibility`

And, if not already in repo, we should add the next cursor-stage logs called for by the cursor-visibility plan:

- source local cursor publish sequence log
- source `/cursor-state` snapshot contents or max sequence log
- destination remote ingest and client-fanout decision log

## Measurement Plan

Every script should have explicit metrics, not just logs.

### Minimum metrics common to all scripts

- run duration
- action counts by type
- successful vs failed action counts
- websocket reconnect counts
- latency histograms or percentile-ready samples
- error counts by code
- shutdown latency

### Bot-level latency measurements

- connect start -> hello received
- subscribe sent -> subAck received
- setCell sent -> authoritative cell update received
- forced disconnect -> socket reopened
- first local cursor send -> first remote cursor receipt per peer

### Run-level rollups

- p50 / p95 / p99 for core latencies
- worst `N` bots by error rate
- worst `N` bots by convergence latency
- tiles with highest contention
- scenarios with highest rejection rate
- whether shutdown required force kills
- cursor first-visibility latency per direction for cursor-focused runs

## Build Phases

### Phase 1: Minimal live bot

Deliverables:

- websocket bot that can connect, subscribe, send cursor updates, send setCell, and log results
- per-bot NDJSON log
- one basic summary

Exit criteria:

- one bot can run against the deployed backend reliably
- we can correlate a bot edit with worker logs

### Phase 2: Scenario library

Deliverables:

- hot tile
- spread editing
- read-only lurker
- cursor heavy
- viewport churn
- reconnect burst

Exit criteria:

- each scenario can run standalone
- each scenario emits its own measurements

### Phase 3: Coordinator

Deliverables:

- multi-bot orchestration
- random selection of `2` scenarios
- run config and seed persistence
- fast interrupt handling and bot teardown

Exit criteria:

- one command launches `10`, `50`, or `200` bot runs reproducibly
- one `Ctrl+C` stops the swarm quickly enough to avoid lingering backend load

### Phase 4: Reporting

Deliverables:

- summary generator
- percentile rollups
- hotspot and failure summaries

Exit criteria:

- failed or degraded runs can be triaged from summary plus logs
- cursor-focused runs can highlight asymmetric first-visibility latency

### Phase 5: Browser canaries

Deliverables:

- optional browser capture integration
- human-observable canary sessions during swarm runs

Exit criteria:

- a human can watch the board during a run and compare visible behavior with bot logs

### Phase 6: Recorded session replay

Deliverables:

- semantic session recorder
- semantic replay with offset and speed adjustment

Exit criteria:

- recorded behavior can be replayed as one scenario source among the synthetic scenarios

### Phase 7: Swarm tool verification

Deliverables:

- focused unit tests for core scenario and metrics helpers
- integration tests for coordinator shutdown and bot termination
- fixture-based tests for summary generation

Exit criteria:

- the main swarm control path is covered well enough that we trust it during live backend incidents

## Open Questions

- should the first bot implementation run as one process per bot, or many bot sessions inside one process
- do we want auth coverage in the first phase, or only anonymous identities first
- how many browser canaries are practical on the current dev machine
- should run summaries also emit CSV in addition to JSON
- do we want explicit server-side dashboards later, or keep analysis file-based first
- what default remote origin should we choose for the first live runs in the top-right quadrant

## Recommended First Build Slice

Build the smallest thing that still teaches us something:

1. one protocol bot script
2. one hot-tile scenario
3. one spread scenario
4. one coordinator that picks one of those two for each bot
5. per-bot NDJSON logs
6. one run summary with latency percentiles and rejection counts

That is enough to start learning from `10`- and `50`-bot runs without overbuilding the framework.
