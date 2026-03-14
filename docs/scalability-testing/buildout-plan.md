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

### Step 7: Mixed Incident Shape

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

### Step 8: Soak

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

### Step 9: Local Stress Ceiling

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
