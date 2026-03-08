# Debug Log Capture

Use three terminals during manual testing: one for limited server tail, one for the normal browser window, and one for the private browser window.

## 1) Capture limited server tail (Cloudflare Worker)

```bash
pnpm logs:server:capture
```

The server capture script does not stop immediately on the first `Ctrl+C`.
By default it keeps `wrangler tail` open for another `5000ms` so late-arriving Cloudflare
tail records still make it into the file. Press `Ctrl+C` a second time to force-stop immediately.

Important:
- this tail is only the limited first-pass server view
- Cloudflare historical worker logs can still be in flight after the tail stops
- in practice we should allow about `2 minutes` before assuming the stored worker logs are complete enough for targeted historical queries

Optional examples:

```bash
# Tail a specific deployed worker
pnpm logs:server:capture --worker sea-of-checkboxes-worker

# Human-readable output
pnpm logs:server:capture --format pretty

# Wait longer before stopping when tail delivery is laggy
pnpm logs:server:capture --settle-ms 10000

# Pass extra wrangler tail filters
pnpm logs:server:capture -- --status error
```

Default output file: `logs/server-<timestamp>.log`

Default target worker: `sea-of-checkboxes-worker` on Cloudflare (`wrangler tail` remote tail).

## 1b) Query stored worker logs (targeted historical search)

When the limited tail is too broad or misses the exact backend chain you want, query stored
Cloudflare Worker logs directly after the logs have had time to settle:

```bash
pnpm logs:server:query --last 10m --event internal_error
```

Examples:

```bash
# Find one correlated trace
pnpm logs:server:query --last 30m --trace-id ctrace_123

# Narrow to cursor-state pull failures
pnpm logs:server:query --from 2026-03-07T09:52:00Z --to 2026-03-07T09:53:00Z --path /cursor-state --event internal_error

# Dump matching rows as NDJSON
pnpm logs:server:query --last 5m --event cursor_pull_peer --format ndjson

# Pull the full backend chain for a client-visible error trace
pnpm logs:server:query --from 2026-03-07T09:52:00Z --to 2026-03-07T09:53:00Z --trace-id ctrace_50ef5ffb-712b-48d8-9e11-9499acdfb6b5 --format ndjson

# Pull the full request chain once you know the Cloudflare request id
pnpm logs:server:query --from 2026-03-07T09:52:00Z --to 2026-03-07T09:53:00Z --request-id X1ZEYMS33CR1H9KH --format ndjson
```

Required environment:
- preferred: existing `wrangler login`
- preferred dedicated overrides:
  - `CLOUDFLARE_LOG_QUERY_API_TOKEN`
  - `CLOUDFLARE_LOG_QUERY_ACCOUNT_ID`
- fallback overrides:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`

Recommended local setup:

```bash
# .env.local or shell profile
export CLOUDFLARE_LOG_QUERY_API_TOKEN=...
export CLOUDFLARE_LOG_QUERY_ACCOUNT_ID=...
```

## 2) Launch normal-window client and capture browser console logs

```bash
pnpm logs:client:capture
```

Default output file: `logs/client-<timestamp>.log`
Default URL: `https://sea-of-checkboxes-web.pages.dev`

Override URL when needed:

```bash
pnpm logs:client:capture --url https://<your-pages-url>
```

By default the client launcher runs with a persistent browser profile:
- profile dir: `.client-profile/chrome`
- cookies/local storage/session data persist across runs

Recommended normal-window command:

```bash
pnpm logs:client:capture --output logs/client-normal.log
```

### Private mode

Private mode is opt-in and disabled by default:

```bash
pnpm logs:client:capture --private
```

When `--private` is set, an ephemeral profile is used and deleted on exit.

Recommended private-window command:

```bash
pnpm logs:client:capture --private --output logs/client-private.log
```

## 3) Recommended incident flow

1. Start `pnpm logs:server:capture` in terminal A.
2. Start `pnpm logs:client:capture --output logs/client-normal.log` in terminal B.
3. Start `pnpm logs:client:capture --private --output logs/client-private.log` in terminal C.
4. Reproduce the issue.
5. Stop the server capture with `Ctrl+C` once, then let it settle. Use a second `Ctrl+C` only if you need to force-stop it.
6. Stop both client captures.
7. Wait about `2 minutes` for Cloudflare stored worker logs to settle before querying historical data.
8. Read the normal and private client logs first for `trace` ids, timestamps, visible asymmetry, and any `setcell_sync_wait_*` or `click_blocked` sync-guard events.
9. Use the limited server tail as the first coarse server view.
10. Use `pnpm logs:server:query` to fetch the missing backend details by time window, trace id, or request id.
11. For slow or stuck checkbox writes, correlate:
   - client `setcell_sync_wait_*`
   - client `click_blocked` with sync guard `cid`
   - worker `setCell_received`
   - worker / tile-owner `setCell`
   - any `tile_batch_order_anomaly`

## Why this order
- the normal and private client logs tell us whether the failure is symmetric, whether one side never receives remote cursors, and which client-visible traces to pivot on
- the new client sync-wait events let us tell whether the UI blocked the edit, the outbox kept waiting for authority, or the backend accepted the write but completion was slow
- the limited server tail gives a quick first read without waiting for historical indexing
- the historical query script fills in the missing worker-side request chain once Cloudflare has caught up
