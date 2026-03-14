# Scalability Buildout Plan

This document is the execution plan for swarm-based scalability testing.

It is intentionally separate from [README.md](/home/diederik/dev/sea-of-checkboxes/docs/scalability-testing/README.md), which focuses on tooling shape, goals, and architecture.

This plan answers a different question:

- what runs we should execute
- in what order
- what each run is trying to prove
- when a run shape is ready to promote from local to production

## Principles

- climb the ladder one step at a time
- isolate one failure shape before combining several
- do not promote a scenario to production until it is clean locally
- inspect logs after every run before moving up the ladder
- keep production runs conservative until the local ladder is stable

## Promotion Gates

Do not move to the next rung until the current one is acceptable.

Minimum gate:

- `failedBots = 0`
- `forcedKillCount = 0`
- no unexpected reconnects unless the scenario is explicitly `reconnect-burst`
- `setCellResolved` matches `setCellSent` for write scenarios
- remote cursor visibility looks complete for the expected peer count
- no unexpected server errors or persistent `tile_sub_denied` / `tile_readonly_hot`

If a run fails a gate:

- inspect `summary.txt`
- inspect `summary.json`
- inspect the worst bot summaries
- inspect relevant bot NDJSON logs
- for production, correlate with worker logs before changing code or moving up the ladder

## Local Ladder

Run these against the local worker first.

Local setup:

1. start the dev worker
2. run the swarm against `ws://127.0.0.1:8787/ws`
3. inspect the swarm logs after each rung

### Step 1: Smoke

Intent:

- verify the local worker and swarm harness are healthy at the simplest shape

Run:

- `2` bots
- `15s`
- `spread-editing,read-only-lurker`

Command:

```bash
pnpm swarm:run \
  --run-id local-smoke-b2-15s \
  --bot-count 2 \
  --duration-ms 15000 \
  --scenario-pool spread-editing,read-only-lurker
```

### Step 2: Baseline

Intent:

- establish a clean steady-state local baseline before specialized stress

Run:

- `4` bots
- `30s`
- `spread-editing,read-only-lurker`

Command:

```bash
pnpm swarm:run \
  --run-id local-baseline-b4-30s \
  --bot-count 4 \
  --duration-ms 30000 \
  --scenario-pool spread-editing,read-only-lurker
```

### Step 3: Cursor Fanout

Intent:

- stress cursor propagation more than writes

Run:

- `6` bots
- `45s`
- `cursor-heavy,read-only-lurker`

Command:

```bash
pnpm swarm:run \
  --run-id local-cursor-b6-45s \
  --bot-count 6 \
  --duration-ms 45000 \
  --scenario-pool cursor-heavy,read-only-lurker
```

### Step 4: Subscription Churn

Intent:

- stress subscribe / unsubscribe behavior and viewport movement

Run:

- `6` bots
- `45s`
- `viewport-churn,read-only-lurker`

Command:

```bash
pnpm swarm:run \
  --run-id local-viewport-b6-45s \
  --bot-count 6 \
  --duration-ms 45000 \
  --scenario-pool viewport-churn,read-only-lurker
```

### Step 5: Reconnect Handling

Intent:

- verify reconnect recovery under controlled bursts

Run:

- `8` bots
- `60s`
- `reconnect-burst,spread-editing`

Command:

```bash
pnpm swarm:run \
  --run-id local-reconnect-b8-60s \
  --bot-count 8 \
  --duration-ms 60000 \
  --scenario-pool reconnect-burst,spread-editing
```

### Step 6: Hotspot Pressure

Intent:

- stress one hotspot before attempting larger mixed runs

Run:

- `10` bots
- `45s`
- `hot-tile-contention,read-only-lurker`

Command:

```bash
pnpm swarm:run \
  --run-id local-hot-tile-b10-45s \
  --bot-count 10 \
  --duration-ms 45000 \
  --scenario-pool hot-tile-contention,read-only-lurker
```

### Step 7: Multi-Hotspot Pressure

Intent:

- stress several different tiles close to capacity at the same time
- validate multi-user scalability across several active hotspots instead of one

Run:

- `12` bots
- `60s`
- planned future scenario: `multi-hotspot,read-only-lurker`

Planned command once implemented:

```bash
pnpm swarm:run \
  --run-id local-multi-hotspot-b12-60s \
  --bot-count 12 \
  --duration-ms 60000 \
  --scenario-pool multi-hotspot,read-only-lurker
```

Notes:

- this rung is intentionally listed in the ladder before the mixed incident shape
- it is not implemented in the swarm runner yet
- do not promote this rung until a dedicated `multi-hotspot` scenario exists

### Step 8: Mixed Incident Shape

Intent:

- combine several realistic failure shapes without going to maximum duration

Run:

- `12` bots
- `60s`
- `hot-tile-contention,cursor-heavy,viewport-churn,reconnect-burst,read-only-lurker`

Command:

```bash
pnpm swarm:run \
  --run-id local-mixed-b12-60s \
  --bot-count 12 \
  --duration-ms 60000 \
  --scenario-pool hot-tile-contention,cursor-heavy,viewport-churn,reconnect-burst,read-only-lurker
```

### Step 9: Soak

Intent:

- catch slow degradation and long-tail reconnect or visibility drift

Run:

- `8` bots
- `300s`
- `soak,read-only-lurker`

Command:

```bash
pnpm swarm:run \
  --run-id local-soak-b8-300s \
  --bot-count 8 \
  --duration-ms 300000 \
  --scenario-pool soak,read-only-lurker
```

### Step 10: Local Stress Ceiling

Intent:

- find the first clear local scalability limit before moving the ladder upward

Run:

- `16` bots
- `90s`
- `hot-tile-contention,cursor-heavy,viewport-churn,reconnect-burst,read-only-lurker`

Command:

```bash
pnpm swarm:run \
  --run-id local-stress-b16-90s \
  --bot-count 16 \
  --duration-ms 90000 \
  --scenario-pool hot-tile-contention,cursor-heavy,viewport-churn,reconnect-burst,read-only-lurker
```

## Production Ladder

Do not start here. Promote only after the equivalent local shape is stable.

Production websocket:

- `wss://sea-of-checkboxes-worker.diederikjhattingh.workers.dev/ws`

Production app:

- `https://sea-of-checkboxes-web.pages.dev`

### Prod Step 1: Baseline

- `4` bots
- `30s`
- `spread-editing,read-only-lurker`

### Prod Step 2: Cursor Fanout

- `6` bots
- `45s`
- `cursor-heavy,read-only-lurker`

### Prod Step 3: Subscription Churn

- `8` bots
- `60s`
- `viewport-churn,spread-editing,read-only-lurker`

### Prod Step 4: Reconnect Handling

- `8` bots
- `60s`
- `reconnect-burst,spread-editing`

### Prod Step 5: Soak

- `8` bots
- `120s`
- `soak,read-only-lurker`

### Prod Step 6: Limited Hotspot

- `6` bots
- `30s`
- `hot-tile-contention,read-only-lurker`

### Prod Step 7: Multi-Hotspot Pressure

- planned future scenario: `multi-hotspot,read-only-lurker`
- do not promote until the local `multi-hotspot` rung is implemented and stable

Do not start with the mixed incident shape in production.

## Inspection Checklist

Inspect these after every run:

- `logs/swarm/<run-id>/summary.txt`
- `logs/swarm/<run-id>/summary.json`
- `logs/swarm/<run-id>/bots/<bot-id>-summary.json`
- `logs/swarm/<run-id>/bots/<bot-id>.ndjson`

Focus on:

- bot failures
- force kills
- reconnect counts
- unresolved writes
- missing peers
- slow `subscribeAck`
- slow `firstRemoteCursor`
- slow or spiky `setCellSync`
- scenario-specific errors such as hotspot rejection or sub denial

## Current Start Point

We start with:

- local step 1
- `2` bots
- `15s`
- `spread-editing,read-only-lurker`

Only after log inspection do we move to local step 2.

## Run Notes

### 2026-03-14: Local Step 1

Run:

- `local-smoke-b2-15s`

Result:

- passed promotion gate
- `0` failed bots
- `0` force kills
- `0` reconnects
- `4/4` writes resolved
- both bots saw the expected peer

Notes:

- first remote cursor visibility was slower than ideal for a tiny local run, around `1.57s` to `1.66s`
- this did not block promotion to local step 2

### 2026-03-14: Local Step 2

Run:

- `local-baseline-b4-30s`

Result:

- mostly healthy, but not promoted yet
- `0` failed bots
- `0` force kills
- `0` reconnects
- `18/18` writes resolved
- all bots saw all `3` expected peers

Failure noted:

- one unexpected `not_subscribed` error occurred during `spread-editing`
- the bot attempted a write on tile `14062502:-14062500` without that tile being subscribed
- this looks like a swarm-harness scenario bug, not a backend scaling failure

Required follow-up before local step 3:

- fix `spread-editing` so its write pattern stays inside the subscribed area, or expand subscriptions to match the write pattern
- rerun local step 2 and require a clean summary before moving up the ladder

### 2026-03-14: Local Step 2 Rerun

Run:

- `local-baseline-b4-30s-rerun`

Result:

- passed promotion gate
- `0` failed bots
- `0` force kills
- `0` reconnects
- `18/18` writes resolved
- all bots saw all `3` expected peers
- no unexpected errors

Fix verified:

- `spread-editing` write placement was tightened to stay inside the subscribed tile
- the previous `not_subscribed` harness error did not recur

Next promotion:

- local step 3 is now unblocked

### 2026-03-14: Local Step 3

Run:

- `local-cursor-b6-45s`

Result:

- passed promotion gate
- `0` failed bots
- `0` force kills
- `0` reconnects
- `12/12` writes resolved
- all `6` bots saw all `5` expected peers
- no unexpected errors

Notes:

- this run shifted the load toward cursor fanout as intended, with `606` cursor sends across `6` bots
- `firstRemoteCursor` remained acceptable for promotion, though bot p50s still ranged up to `1327ms`
- local step 4 is now unblocked

### 2026-03-14: Local Step 4

Run:

- `local-viewport-b6-45s`

Result:

- not promoted yet
- `0` failed bots
- `0` force kills
- `0` reconnects
- `25/27` writes resolved
- all `6` bots saw all `5` expected peers
- no explicit server errors were logged

Failure noted:

- `viewport-churn` did not satisfy the write-drain gate before shutdown
- one active bot finished with a pending `setCell`
- aggregate `setCellSync` max reached roughly `35.9s` on two active bots, which is too high for promotion even though the writes eventually confirmed

Required follow-up before local step 5:

- inspect whether `viewport-churn` is issuing writes too close to tile moves or run shutdown
- decide whether the harness should drain pending writes before stop, reduce write cadence during viewport moves, or both
- rerun local step 4 and require `setCellSent == setCellResolved` with sane `setCellSync` tails before moving up the ladder

### 2026-03-14: Local Step 4 Investigation And Rerun

Runs:

- `local-viewport-b6-45s`
- `local-viewport-b6-45s-rerun`
- `local-viewport-b6-45s-rerun-2`

Root cause:

- pending write tracking only kept one in-flight entry per `tile:index`, so repeated writes to the same cell could overwrite earlier samples
- `viewport-churn` could also unsubscribe from a tile before an in-flight write on that tile had a chance to confirm

Fix:

- pending `setCell` tracking was changed to queue repeated writes per `tile:index` instead of overwriting them
- `viewport-churn` now briefly defers a viewport move when the current tile still has pending writes, then resumes normal churn once those writes confirm
- the swarm tests were extended to cover repeated same-cell writes and deferred viewport moves

Result:

- passed promotion gate on `local-viewport-b6-45s-rerun-2`
- `0` failed bots
- `0` force kills
- `0` reconnects
- `27/27` writes resolved
- all `6` bots saw all `5` expected peers
- active viewport-churn bots each completed `8` viewport moves
- `setCellSync` max dropped to about `2.0s`, with no remaining `35s` tail
- no explicit server errors were logged

Next promotion:

- local step 5 is now unblocked

### 2026-03-14: Local Step 5

Run:

- `local-reconnect-b8-60s`

Result:

- not promoted yet
- `0` failed bots
- `0` force kills
- reconnect scenario triggered, but reconnect recovery did not complete
- `152/108` writes sent vs resolved at the aggregate level
- all `8` bots still saw all `7` expected peers before the reconnect window
- no explicit server errors were logged

Failure noted:

- all `4` `reconnect-burst` bots logged `reconnect_burst_triggered`
- none of those bots logged a follow-up `ws_close`, second `ws_connect_attempt`, second `hello_received`, or any non-zero reconnect latency sample
- each reconnect-burst bot finished with `forcedReconnects: 1`, `connectAttempts: 1`, and `pending.setCell: 11`
- this means the forced reconnect path is not actually completing a disconnect-and-reconnect cycle

Required follow-up before local step 6:

- inspect the forced reconnect implementation and confirm why `socket.close()` is not leading to the normal close handler
- make reconnect-burst prove recovery explicitly with a second `hello`, resubscribe, and resumed writes
- rerun local step 5 and require reconnect-burst bots to show real reconnect samples with no unresolved write accumulation

### 2026-03-14: Local Step 5 Investigation And Rerun

Runs:

- `local-reconnect-b8-60s`
- `local-reconnect-b8-60s-rerun`

Root cause:

- the forced reconnect path depended on the websocket close event to schedule the reconnect timer
- when that close handshake did not complete promptly, reconnect-burst bots never entered the normal reconnect flow

Fix:

- forced reconnect now schedules the reconnect timer directly instead of waiting for the close event
- stale late close events are ignored so they cannot create duplicate reconnect attempts
- the swarm tests now cover reconnect recovery even when `close()` does not emit a close event

Result:

- passed promotion gate on `local-reconnect-b8-60s-rerun`
- `0` failed bots
- `0` force kills
- aggregate `setCellSent == setCellResolved` at `148/148`
- `4` reconnect samples across `4` reconnect-burst bots
- each reconnect-burst bot finished with `connectAttempts: 2`, `helloCount: 2`, `subscribeSent: 2`, `reconnects: 1`, and `pending.setCell: 0`
- all `8` bots saw all `7` expected peers
- no explicit server errors were logged

Next promotion:

- local step 6 is now unblocked

### 2026-03-14: Local Step 6

Run:

- `local-hot-tile-b10-45s`

Result:

- not promoted yet
- `0` failed bots
- `0` force kills
- `0` reconnects
- `181/184` writes resolved
- all `10` bots saw all `9` expected peers
- no explicit server errors were logged

Failure noted:

- `3` hotspot writers finished with `pending.setCell: 1`
- the unresolved writes were sent in the final second of the run and were still in flight at shutdown
- hotspot contention also produced some snapshot-based confirmations where the final cell value did not match the writer's requested value, which is expected to happen under contention and should be tracked separately from transport failure

Required follow-up before local step 7:

- add a short end-of-run write drain for hotspot-heavy scenarios, or delay the final stop until pending writes settle
- consider surfacing contention overwrites as a separate summary signal so they do not get confused with missing confirmations
- rerun local step 6 and require `setCellSent == setCellResolved` before moving up the ladder

### 2026-03-14: Local Step 6 Investigation And Rerun

Runs:

- `local-hot-tile-b10-45s`
- `local-hot-tile-b10-45s-rerun`

Root cause:

- hotspot writers could still have one final in-flight write when the run hit `duration_elapsed`
- the harness stopped immediately instead of allowing a short shutdown drain for pending hotspot writes

Fix:

- added a scenario-level shutdown drain for `hot-tile-contention`
- stop now pauses briefly for pending `setCell` confirmations before final shutdown, then completes immediately once those writes settle
- added regression coverage for draining a pending hotspot write before stop

Result:

- passed promotion gate on `local-hot-tile-b10-45s-rerun`
- `0` failed bots
- `0` force kills
- `0` reconnects
- aggregate `setCellSent == setCellResolved` at `185/185`
- all `10` bots saw all `9` expected peers
- active hotspot bots all finished with `pending.setCell: 0`
- no explicit server errors were logged

Next promotion:

- local step 7 is now unblocked
