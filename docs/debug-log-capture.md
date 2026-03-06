# Debug Log Capture

Use two terminals during manual testing: one for server logs and one for browser client logs.

## 1) Capture server logs (Cloudflare Worker)

```bash
pnpm logs:server:capture
```

The server capture script does not stop immediately on the first `Ctrl+C`.
By default it keeps `wrangler tail` open for another `5000ms` so late-arriving Cloudflare
records still make it into the file. Press `Ctrl+C` a second time to force-stop immediately.

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
4. Stop the server capture with `Ctrl+C` once, then let it settle. Use a second `Ctrl+C` only if you need to force-stop it.
5. Stop the client capture with `Ctrl+C`.
6. Upload the two files from `logs/`.
