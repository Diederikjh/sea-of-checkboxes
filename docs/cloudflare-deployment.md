# Cloudflare Deployment Runbook

This runbook deploys:
- Worker API/WebSocket backend from `apps/worker`
- Web frontend from `apps/web`

## 1. Prerequisites

- Cloudflare account with Workers, Durable Objects, R2, and Pages enabled
- `pnpm` (project uses `pnpm@10.6.5`)
- Wrangler access (`pnpm dlx wrangler ...`)

From repo root:

```bash
pnpm install --frozen-lockfile
pnpm dlx wrangler login
```

## 2. Configure Worker Names and Buckets

Review `apps/worker/wrangler.jsonc` and set production-safe names:
- `name`
- `r2_buckets[].bucket_name`
- `r2_buckets[].preview_bucket_name`
- `kv_namespaces[]` entry for `SHARE_LINKS` (used by share URLs)

Create the R2 buckets if they do not exist:

```bash
pnpm dlx wrangler r2 bucket create sea-of-checkboxes-tiles
pnpm dlx wrangler r2 bucket create sea-of-checkboxes-tiles-preview
```

Create KV namespaces for share links and add their IDs to `apps/worker/wrangler.jsonc`:

```bash
pnpm dlx wrangler kv namespace create SHARE_LINKS
pnpm dlx wrangler kv namespace create SHARE_LINKS --preview
```

## 3. Set Required Worker Auth Config

Production must set `IDENTITY_SIGNING_SECRET` (do not rely on fallback dev secret):

```bash
pnpm dlx wrangler secret put IDENTITY_SIGNING_SECRET --config apps/worker/wrangler.jsonc
```

Use a long random value (at least 32 bytes of entropy).

This is a runtime hard requirement. If the worker starts without it, the public auth and websocket entrypoints must fail closed instead of silently falling back to a development secret.

Set `FIREBASE_PROJECT_ID` for the worker auth verifier (must match your Firebase project):

```bash
pnpm dlx wrangler secret put FIREBASE_PROJECT_ID --config apps/worker/wrangler.jsonc
```

## 4. Configure Runtime Controls

Review `apps/worker/wrangler.jsonc` and set these worker vars for deploy-time control:

- `APP_DISABLED` (default `0`)
- `READONLY_MODE` (default `0`)
- `ANON_AUTH_ENABLED` (default `1`)
- `SHARE_LINKS_ENABLED` (default `1`)

Recommended meanings:

- `APP_DISABLED=1` stops the app entirely and returns a maintenance-style unavailable response.
- `READONLY_MODE=1` keeps reads available but blocks checkbox writes.
- `ANON_AUTH_ENABLED=0` stops new anonymous account creation while keeping existing anonymous identities valid.
- `SHARE_LINKS_ENABLED=0` disables share-link creation and lookup.

## 5. Validate Before Deploy

```bash
pnpm typecheck
pnpm test
```

## 6. Deploy Worker

```bash
pnpm dlx wrangler deploy --config apps/worker/wrangler.jsonc \
  --var FIREBASE_PROJECT_ID:<project-id> \
  --var APP_DISABLED:0 \
  --var READONLY_MODE:0 \
  --var ANON_AUTH_ENABLED:1 \
  --var SHARE_LINKS_ENABLED:1
```

After deploy, note the Worker host:
- `<worker-name>.<account-subdomain>.workers.dev`

Smoke check:

```bash
curl -sS https://<worker-host>/health
```

Expected JSON includes `{"ok": true, "ws": "/ws"}`.
If `IDENTITY_SIGNING_SECRET` is missing in the deployed worker environment, the runtime should report an auth-unavailable style failure instead of accepting requests with a fallback secret.

## 7. Configure Frontend Environment

The web app needs the backend URLs at build time.

Create `apps/web/.env.production` from `apps/web/.env.example`:

```dotenv
VITE_WS_URL=wss://<worker-host>/ws
VITE_API_BASE_URL=https://<worker-host>
VITE_USE_MOCK=0
VITE_FIREBASE_API_KEY=<firebase-api-key>
VITE_FIREBASE_AUTH_DOMAIN=<project-id>.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=<project-id>
VITE_FIREBASE_APP_ID=<firebase-app-id>
VITE_APP_DISABLED=0
VITE_SHARE_LINKS_ENABLED=1
VITE_ANON_AUTH_ENABLED=1
```

## 8. Deploy Frontend to Cloudflare Pages

### Option A: Pages dashboard

- Framework preset: `Vite`
- Build command: `pnpm --filter sea-of-checkboxes build`
- Build output directory: `apps/web/dist`
- Root directory: repo root
- Environment variables: set the `VITE_*` values above for Production (and Preview if needed)
- The feature flags can be changed here for maintenance builds:
  - `VITE_APP_DISABLED`
  - `VITE_SHARE_LINKS_ENABLED`
  - `VITE_ANON_AUTH_ENABLED`

### Option B: Wrangler CLI

```bash
pnpm --filter sea-of-checkboxes build
pnpm dlx wrangler pages deploy apps/web/dist --project-name sea-of-checkboxes-web
```

## 9. Post-Deploy Verification

- Open Pages URL and confirm the app loads
- Confirm WebSocket connects to `/ws` on the Worker
- Confirm cell updates propagate between two browser sessions
- Confirm `GET /cell-last-edit?tile=0:0&i=0` returns without CORS errors
- If `VITE_APP_DISABLED=1`, confirm the frontend shows the unavailable message and does not boot the app runtime.
- If `VITE_SHARE_LINKS_ENABLED=0`, confirm sharing is hidden or disabled in the UI.

## 10. Ongoing Release Flow

For each release:

1. `pnpm typecheck && pnpm test`
2. `pnpm dlx wrangler deploy --config apps/worker/wrangler.jsonc --var FIREBASE_PROJECT_ID:<project-id> --var APP_DISABLED:0 --var READONLY_MODE:0 --var ANON_AUTH_ENABLED:1 --var SHARE_LINKS_ENABLED:1`
3. Deploy `apps/web` to Pages (dashboard or CLI)
4. Run post-deploy verification checks

## 11. GitHub Actions Worker Deploy

Repository workflow: `.github/workflows/deploy-worker.yml`

Trigger behavior:
- Manual run: `workflow_dispatch`
- Auto-run on `main` push when worker/runtime files change

Required GitHub repository secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Required GitHub repository variables:
- `VITE_FIREBASE_PROJECT_ID` (used for worker deploy and web build)

Optional GitHub repository variables:
- `APP_DISABLED` (defaults to `0`)
- `READONLY_MODE` (defaults to `0`)
- `ANON_AUTH_ENABLED` (defaults to `1`)
- `SHARE_LINKS_ENABLED` (defaults to `1`)

Create `CLOUDFLARE_API_TOKEN` as a User API token scoped to this account with permissions for:
- Workers Scripts (Edit)
- Workers R2 Storage (Edit)
- Cloudflare Pages (Edit) (needed for Pages deploy workflow)
- Account Settings (Read)
- User Memberships (Read)
- User Details (Read)

The workflow deploy step runs:

```bash
pnpm dlx wrangler deploy --config apps/worker/wrangler.jsonc \
  --var FIREBASE_PROJECT_ID:${VITE_FIREBASE_PROJECT_ID} \
  --var APP_DISABLED:${APP_DISABLED:-0} \
  --var READONLY_MODE:${READONLY_MODE:-0} \
  --var ANON_AUTH_ENABLED:${ANON_AUTH_ENABLED:-1} \
  --var SHARE_LINKS_ENABLED:${SHARE_LINKS_ENABLED:-1}
```

Note: this workflow can validate repo variables, but it cannot prove a Cloudflare-managed worker secret exists unless that secret is also sourced into GitHub Actions.

## 12. GitHub Actions Pages Deploy

Repository workflow: `.github/workflows/deploy-pages.yml`

Trigger behavior:
- Manual run: `workflow_dispatch`
- Auto-run on `main` push when frontend/runtime files change

Required GitHub repository secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Required GitHub repository variables:
- `VITE_WS_URL` (example: `wss://sea-of-checkboxes-worker.<account-subdomain>.workers.dev/ws`)
- `VITE_API_BASE_URL` (example: `https://sea-of-checkboxes-worker.<account-subdomain>.workers.dev`)
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`

Optional GitHub repository variables:
- `CLOUDFLARE_PAGES_PROJECT` (defaults to `sea-of-checkboxes-web`)
- `VITE_USE_MOCK` (defaults to `0`)
- `VITE_APP_DISABLED` (defaults to `0`)
- `VITE_SHARE_LINKS_ENABLED` (defaults to `1`)
- `VITE_ANON_AUTH_ENABLED` (defaults to `1`)
- `WS_DISABLED` (worker websocket kill switch; defaults to `0`)

The workflow runs:

```bash
VITE_USE_MOCK="${VITE_USE_MOCK:-0}" \
VITE_APP_DISABLED="${VITE_APP_DISABLED:-0}" \
VITE_SHARE_LINKS_ENABLED="${VITE_SHARE_LINKS_ENABLED:-1}" \
VITE_ANON_AUTH_ENABLED="${VITE_ANON_AUTH_ENABLED:-1}" \
pnpm --filter sea-of-checkboxes build
pnpm dlx wrangler pages deploy apps/web/dist --project-name "${CLOUDFLARE_PAGES_PROJECT:-sea-of-checkboxes-web}" --branch "${GITHUB_REF_NAME}"
```

Before first workflow run, create the Pages project once (dashboard or CLI):

```bash
pnpm dlx wrangler pages project create sea-of-checkboxes-web
```

## Notes

- Durable Object migrations are declared in `apps/worker/wrangler.jsonc`. When adding/changing DO classes, add a new migration tag before deploying.
- If Pages and Worker are on different hostnames, keep `VITE_WS_URL` and `VITE_API_BASE_URL` explicitly set to the Worker hostname.
- Emergency websocket kill switch:
  - Disable websocket forwarding (returns `503` on `/ws` and avoids DO calls): `pnpm dlx wrangler deploy --config apps/worker/wrangler.jsonc --var FIREBASE_PROJECT_ID:${VITE_FIREBASE_PROJECT_ID} --var WS_DISABLED:1`
  - Re-enable websocket forwarding: `pnpm dlx wrangler deploy --config apps/worker/wrangler.jsonc --var FIREBASE_PROJECT_ID:${VITE_FIREBASE_PROJECT_ID} --var WS_DISABLED:0`
- If you want the GitHub worker workflow itself to fail on a missing `IDENTITY_SIGNING_SECRET`, that secret must be managed in GitHub and validated there; otherwise the hard fail belongs at runtime.
