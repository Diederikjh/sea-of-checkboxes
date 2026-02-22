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

Create `CLOUDFLARE_API_TOKEN` with Cloudflare's "Edit Cloudflare Workers" template for your account.
If deployment fails with auth errors and R2 bindings are present, expand the token scopes to include R2 access for the target buckets.

The workflow deploy step runs:

```bash
pnpm dlx wrangler deploy --config apps/worker/wrangler.jsonc
```

## Notes

- Durable Object migrations are declared in `apps/worker/wrangler.jsonc`. When adding/changing DO classes, add a new migration tag before deploying.
- If Pages and Worker are on different hostnames, keep `VITE_WS_URL` and `VITE_API_BASE_URL` explicitly set to the Worker hostname.
