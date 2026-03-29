# Security Runtime Controls Plan

This document captures the next hardening pass for test-audience safety, abuse resistance, and cost control.

It covers:

- fail-closed handling for missing `IDENTITY_SIGNING_SECRET`
- a global read-only mode for load shedding
- a flag to allow or block new anonymous account creation
- a flag to disable share-location / share-link functionality
- a full app-disabled mode that renders a simple unavailable screen on the frontend

The requested scope is build-time / deploy-time flags for now:

- worker behavior controlled by Worker vars in `apps/worker/wrangler.jsonc`
- frontend behavior controlled by `VITE_*` build vars in `apps/web`

## Current State

### GitHub Actions secret validation gap

Today the worker deploy workflow does **not** fail when `IDENTITY_SIGNING_SECRET` is missing from the deployed Cloudflare Worker environment.

Current behavior:

- `.github/workflows/deploy-worker.yml` validates only `VITE_FIREBASE_PROJECT_ID`
- the workflow does not validate `IDENTITY_SIGNING_SECRET`
- the runtime currently falls back to a development secret when the worker env is missing that value

Important nuance:

- the current GitHub Action cannot reliably prove whether Cloudflare already has the Worker secret configured, because that secret is not currently sourced from GitHub Actions
- so there is no existing build-time failure for this condition

That means we need a **runtime hard failure** regardless of what we later decide to do in CI.

## Goals

- Missing `IDENTITY_SIGNING_SECRET` must fail closed in production-style runtime paths.
- Load shedding must support a fast read-only mode without taking the full app down.
- Anonymous account creation must be explicitly controllable for test audiences.
- Share links must be explicitly controllable, and the frontend must reflect when they are disabled.
- A full app-disabled mode must render:
  - `Sea of checkboxes is unavailable for now`
- The first implementation should use simple deploy/build flags rather than an admin panel.

## Non-Goals

- Do not build a live runtime config service in this pass.
- Do not build per-user or per-request override rules in this pass.
- Do not redesign auth or sharing flows beyond the minimum needed for the flags below.

## Proposed Flags

### Worker flags

- `APP_DISABLED`
  - default: `0`
  - when `1`, public routes fail closed and websocket ingress is disabled

- `READONLY_MODE`
  - default: `0`
  - when `1`, read traffic remains available but checkbox writes are rejected

- `ANON_AUTH_ENABLED`
  - default: `1`
  - when `0`, the app must not mint new anonymous app identities

- `SHARE_LINKS_ENABLED`
  - default: `1`
  - when `0`, share-link create and resolve endpoints are disabled

### Frontend build flags

- `VITE_APP_DISABLED`
  - default: `0`
  - when `1`, the frontend renders only the unavailable screen and does not start the app runtime

- `VITE_SHARE_LINKS_ENABLED`
  - default: `1`
  - when `0`, the share button is hidden/disabled and share-link UI does not present sharing as available

- `VITE_ANON_AUTH_ENABLED`
  - default: `1`
  - when `0`, the frontend should not bootstrap anonymous auth automatically

## Behavior Plan

### 1. Missing `IDENTITY_SIGNING_SECRET` hard failure

Add an explicit worker guard that treats a missing signing secret as a fatal configuration error outside local/dev-only test paths.

Desired behavior:

- `/ws` returns `503`
- `/auth/session` returns `503`
- any route that verifies or creates identity tokens also returns `503`
- `/health` reports the worker as unhealthy when this config is missing
- no fallback development secret is used in deployed environments

Response shape can stay simple:

- code: `auth_unavailable`
- message: configuration missing

Operational note:

- this runtime guard is mandatory even if we later add stronger CI checks

CI follow-up:

- if we want the GitHub Action itself to fail early, we need to manage the secret from GitHub as well, or add an explicit Cloudflare-secret sync/check step during deploy
- that is a separate deployment-model decision from the runtime guard

## 2. Read-only mode

Add a worker-level write gate controlled by `READONLY_MODE`.

Desired behavior:

- reads still work:
  - websocket connect
  - subscriptions
  - snapshots
  - cursor presence
  - inspect / last-edit lookups
- writes fail:
  - `setCell`

Implementation shape:

- gate writes before they reach `TileOwnerDO`
- return a stable rejection reason such as `app_readonly`
- keep current hot-tile readonly behavior intact; this new flag is a broader top-level override

Frontend behavior:

- no dedicated build flag required
- existing server-error handling should surface the readonly state
- if needed, add a clearer status/overlay message for `app_readonly`

## 3. Anonymous account creation flag

Add `ANON_AUTH_ENABLED` on the worker and `VITE_ANON_AUTH_ENABLED` on the frontend.

Desired behavior when enabled:

- current behavior remains unchanged

Desired behavior when disabled:

- frontend does not auto-create an anonymous Firebase session
- worker does not mint a generated legacy identity on `/ws` when no valid token is provided
- worker rejects anonymous Firebase auth-session bootstrap for new anonymous access

Recommended semantics:

- existing anonymous identities continue to work
- existing non-anonymous sessions continue to work
- Google-linked sign-in continues to work
- anonymous sign-out back to a fresh anonymous session is disabled

Reason for frontend flag:

- without FE awareness, the page would still try to bootstrap anonymous auth and degrade into confusing failures

User-facing fallback when anonymous auth is disabled:

- show a clear status such as:
  - `Anonymous access is disabled right now`
- keep the Google sign-in path available if configured

## 4. Share links enabled flag

Add `SHARE_LINKS_ENABLED` on the worker and `VITE_SHARE_LINKS_ENABLED` on the frontend.

Desired behavior when disabled on the worker:

- `POST /share-links` returns `503`
- `GET /share-links/:id` returns `503`
- preflight handling remains predictable

Desired behavior when disabled on the frontend:

- hide or disable the share button
- do not present share creation as available
- if the page is loaded with `?share=...`, show a clear status that share links are currently disabled

This frontend awareness is specifically requested so the UI does not look broken when sharing is intentionally off.

## 5. Full app-disabled mode

Add `APP_DISABLED` on the worker and `VITE_APP_DISABLED` on the frontend.

Frontend behavior when disabled:

- do not bootstrap auth
- do not connect websocket
- do not start Pixi app runtime
- render a minimal static screen with:
  - `Sea of checkboxes is unavailable for now`

Worker behavior when disabled:

- `/ws` returns `503`
- public API routes return `503`
- `/health` reports disabled / unhealthy state

This gives us both:

- a user-facing maintenance screen
- a backend-side traffic stop for cost protection

## Routing Priority

The worker should evaluate the top-level flags in this order:

1. `APP_DISABLED`
2. missing required secrets / fatal config
3. per-feature flags such as `SHARE_LINKS_ENABLED`
4. route-specific logic

`READONLY_MODE` should be evaluated inside write paths after top-level app availability has been checked.

## Files Likely To Change

Worker:

- `apps/worker/src/doCommon.ts`
- `apps/worker/src/workerFetch.ts`
- `apps/worker/src/identityToken.ts`
- `apps/worker/src/auth/authSessionService.ts`
- `apps/worker/wrangler.jsonc`

Frontend:

- `apps/web/src/app.js`
- `apps/web/src/auth/bootstrap.js`
- `apps/web/src/auth/firebaseAuthProvider.js`
- `apps/web/src/shareLinks.js`
- `apps/web/index.html`
- `apps/web/.env.example`

Deployment docs / workflow follow-up:

- `.github/workflows/deploy-worker.yml`
- `.github/workflows/deploy-pages.yml`
- `docs/cloudflare-deployment.md`

## Testing Plan

Add focused coverage for:

- missing `IDENTITY_SIGNING_SECRET` returns `503` on auth/ws paths
- `READONLY_MODE=1` rejects `setCell` and preserves read flows
- `ANON_AUTH_ENABLED=0` blocks anonymous bootstrap paths
- `SHARE_LINKS_ENABLED=0` disables create and resolve routes
- `VITE_SHARE_LINKS_ENABLED=0` hides/disables share UI
- `VITE_APP_DISABLED=1` renders the unavailable screen and skips app bootstrap

## Rollout Order

1. Add runtime hard failure for missing `IDENTITY_SIGNING_SECRET`
2. Add `APP_DISABLED`
3. Add `READONLY_MODE`
4. Add `SHARE_LINKS_ENABLED` plus FE awareness
5. Add `ANON_AUTH_ENABLED` plus FE awareness
6. Update deploy docs and GitHub Actions validation strategy

## Acceptance Criteria

- A missing signing secret no longer silently falls back to a development secret.
- We can deploy a read-only build without removing read access.
- We can deploy a build that blocks new anonymous entry.
- We can deploy a build with sharing disabled and a non-confusing UI.
- We can deploy a full-maintenance build that renders only the unavailable message on the frontend.
