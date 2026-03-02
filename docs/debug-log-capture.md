# Debug Log Capture

Use two terminals during manual testing: one for server logs and one for browser client logs.

## 1) Capture server logs (Cloudflare Worker)

```bash
pnpm logs:server:capture
```

Optional examples:

```bash
# Tail a specific deployed worker
pnpm logs:server:capture --worker sea-of-checkboxes-worker

# Human-readable output
pnpm logs:server:capture --format pretty

# Pass extra wrangler tail filters
pnpm logs:server:capture -- --status error
```

Default output file: `logs/server-<timestamp>.log`

Default target worker: `sea-of-checkboxes-worker` on Cloudflare (`wrangler tail` remote tail).

## 2) Launch test client and capture browser console logs

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

### Private mode

Private mode is opt-in and disabled by default:

```bash
pnpm logs:client:capture --private
```

When `--private` is set, an ephemeral profile is used and deleted on exit.

## Typical debugging flow

1. Start `pnpm logs:server:capture` in terminal A.
2. Start `pnpm logs:client:capture` in terminal B.
3. Reproduce the issue.
4. Stop both commands with `Ctrl+C`.
5. Upload the two files from `logs/`.
