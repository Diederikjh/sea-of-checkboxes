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

Create the R2 buckets if they do not exist:

```bash
pnpm dlx wrangler r2 bucket create sea-of-checkboxes-tiles
pnpm dlx wrangler r2 bucket create sea-of-checkboxes-tiles-preview
```

## 3. Set Required Secret

Production must set `IDENTITY_SIGNING_SECRET` (do not rely on fallback dev secret):

```bash
pnpm dlx wrangler secret put IDENTITY_SIGNING_SECRET --config apps/worker/wrangler.jsonc
```

Use a long random value (at least 32 bytes of entropy).

## 4. Validate Before Deploy

```bash
pnpm typecheck
pnpm test
```

## 5. Deploy Worker

```bash
pnpm dlx wrangler deploy --config apps/worker/wrangler.jsonc
```

After deploy, note the Worker host:
- `<worker-name>.<account-subdomain>.workers.dev`

Smoke check:

```bash
curl -sS https://<worker-host>/health
```

Expected JSON includes `{"ok": true, "ws": "/ws"}`.

## 6. Configure Frontend Environment

The web app needs the backend URLs at build time.

Create `apps/web/.env.production` from `apps/web/.env.example`:

```dotenv
VITE_WS_URL=wss://<worker-host>/ws
VITE_API_BASE_URL=https://<worker-host>
VITE_USE_MOCK=0
```

## 7. Deploy Frontend to Cloudflare Pages

### Option A: Pages dashboard

- Framework preset: `Vite`
- Build command: `pnpm --filter sea-of-checkboxes build`
- Build output directory: `apps/web/dist`
- Root directory: repo root
- Environment variables: set the three `VITE_*` values above for Production (and Preview if needed)

### Option B: Wrangler CLI

```bash
pnpm --filter sea-of-checkboxes build
pnpm dlx wrangler pages deploy apps/web/dist --project-name sea-of-checkboxes-web
```

## 8. Post-Deploy Verification

- Open Pages URL and confirm the app loads
- Confirm WebSocket connects to `/ws` on the Worker
- Confirm cell updates propagate between two browser sessions
- Confirm `GET /cell-last-edit?tile=0:0&i=0` returns without CORS errors

## 9. Ongoing Release Flow

For each release:

1. `pnpm typecheck && pnpm test`
2. `pnpm dlx wrangler deploy --config apps/worker/wrangler.jsonc`
3. Deploy `apps/web` to Pages (dashboard or CLI)
4. Run post-deploy verification checks

## 10. GitHub Actions Worker Deploy

Repository workflow: `.github/workflows/deploy-worker.yml`

Trigger behavior:
- Manual run: `workflow_dispatch`
- Auto-run on `main` push when worker/runtime files change

Required GitHub repository secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Create `CLOUDFLARE_API_TOKEN` as a User API token scoped to this account with permissions for:
- Workers Scripts (Edit)
- Workers R2 Storage (Edit)
- Cloudflare Pages (Edit) (needed for Pages deploy workflow)
- Account Settings (Read)
- User Memberships (Read)
- User Details (Read)

The workflow deploy step runs:

```bash
pnpm dlx wrangler deploy --config apps/worker/wrangler.jsonc
```

## 11. GitHub Actions Pages Deploy

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

Optional GitHub repository variables:
- `CLOUDFLARE_PAGES_PROJECT` (defaults to `sea-of-checkboxes-web`)
- `VITE_USE_MOCK` (defaults to `0`)

The workflow runs:

```bash
VITE_USE_MOCK="${VITE_USE_MOCK:-0}" pnpm --filter sea-of-checkboxes build
pnpm dlx wrangler pages deploy apps/web/dist --project-name "${CLOUDFLARE_PAGES_PROJECT:-sea-of-checkboxes-web}" --branch "${GITHUB_REF_NAME}"
```

Before first workflow run, create the Pages project once (dashboard or CLI):

```bash
pnpm dlx wrangler pages project create sea-of-checkboxes-web
```

## Notes

- Durable Object migrations are declared in `apps/worker/wrangler.jsonc`. When adding/changing DO classes, add a new migration tag before deploying.
- If Pages and Worker are on different hostnames, keep `VITE_WS_URL` and `VITE_API_BASE_URL` explicitly set to the Worker hostname.
