# Log Sampling Plan

This document captures the next observability pass for reducing routine log volume without losing useful incident data.

It covers:

- deterministic worker log sampling by `clientSessionId`
- preserving all errors and anomaly logs regardless of sampling
- expanding `client_session_id` propagation for worker events that belong to one and only one client
- a client-driven way to raise one session back to the current `reduced` logging level
- an optional higher-verbosity path for difficult bugs
- frontend logging behavior
- swarm-script defaults so load-test runs remain debuggable

## Current State

Today the worker already has a coarse global mode switch in [`../apps/worker/src/observability.ts`](../apps/worker/src/observability.ts):

- `verbose`
- `reduced`
- `sampled`

Current deployed default in [`../apps/worker/wrangler.jsonc`](../apps/worker/wrangler.jsonc):

- `WORKER_LOG_MODE = "sampled"`
- `WORKER_LOG_SAMPLE_RATE = "0.01"`
- `WORKER_LOG_FORCE_SESSION_PREFIXES = "swarm_"`
- `WORKER_LOG_ALLOW_CLIENT_VERBOSE = "false"`

That existing `reduced` mode already does the most important thing we want:

- it keeps errors and notable anomalies
- it suppresses a large amount of routine success chatter

The frontend logger in [`../apps/web/src/logger.js`](../apps/web/src/logger.js) already supports:

- build-time category flags via `VITE_LOG_PROTOCOL`, `VITE_LOG_UI`, `VITE_LOG_OTHER`
- URL flags via `?logs=protocol,ui,other`
- URL flags via `?log_protocol=1`, `?log_ui=1`, `?log_other=1`

The app already creates a stable browser-session correlation id in [`../apps/web/src/clientSessionId.js`](../apps/web/src/clientSessionId.js), and the worker already receives it on websocket connect through [`../apps/worker/src/workerFetch.ts`](../apps/worker/src/workerFetch.ts).

The swarm scripts already generate stable `clientSessionId` values like `swarm_<runId>_<botId>` in [`../scripts/swarm/lib/config.mjs`](../scripts/swarm/lib/config.mjs), and production debugging guidance already relies on querying worker logs by that field in [`scalability-testing/README.md`](scalability-testing/README.md).

## Implementation Status

This plan is now partly implemented.

Implemented:

- worker `sampled` mode and deterministic per-session sampling
- `WORKER_LOG_SAMPLE_RATE`
- `WORKER_LOG_FORCE_REDUCED_SESSION_IDS`
- `WORKER_LOG_FORCE_VERBOSE_SESSION_IDS`
- `WORKER_LOG_FORCE_SESSION_PREFIXES`
- `WORKER_LOG_ALLOW_CLIENT_VERBOSE`
- emitted `log_policy` on structured worker logs
- server-side `log_override_expired` event
- client-requested `?debug_logs=reduced|verbose|off` persistence with a `15 minute` cap
- websocket propagation of client debug logging state
- `/auth/session` propagation of `clientSessionId` and client debug logging headers
- broader `client_session_id` propagation for single-client worker paths
- default `swarm_` prefix forcing to reduced logging

Implemented but intentionally disabled by config:

- client-requested backend `verbose`
  - code path exists
  - current default worker config keeps `WORKER_LOG_ALLOW_CLIENT_VERBOSE = "false"`

Still outstanding / not yet validated operationally:

- broader production validation of actual sampled session rate under live traffic
- local and production runbook validation that swarm sessions show reduced-level server logs by default
- any future admin or remote-control layer beyond deploy-time flags

## Goals

- Lower routine worker log volume substantially in normal production traffic.
- Keep all worker errors and anomaly signals regardless of sampling outcome.
- Sample by stable session identity, not by individual log line.
- Expand `client_session_id` coverage for worker logs when one and only one client session is honestly responsible for the work.
- Let one affected browser session opt back in to at least the current worker `reduced` level when a user hits a problem.
- Provide an optional path to temporarily enable more verbose logging for a hard-to-reproduce bug.
- Keep the frontend logging controls simple and URL-driven for manual debugging.
- Ensure swarm runs default to logging-enabled behavior so their output remains useful.

## Non-Goals

- Do not build a general-purpose remote config service in this pass.
- Do not sample Cloudflare platform metadata such as `$metadata.requestId`; that remains query-time data, not the primary in-app sampling key.
- Do not redesign the existing structured event taxonomy in the same change.

## Why `clientSessionId`

Sampling should be deterministic per client session rather than random per emitted event.

Reasons:

- a sampled-in session gives us a coherent story across connect, subscribe, write, and close events
- a sampled-out session stays quiet instead of producing fragmented partial traces
- the id already exists in the app and already propagates to the worker
- swarm bots already use stable `clientSessionId` values, so the same mechanism works for load testing

`requestId` is still useful later when querying Cloudflare logs, but it is not a good primary key for emission-time sampling:

- websocket-related behavior can span multiple request chains
- the browser does not know the eventual Cloudflare `requestId`
- one browser session may need correlation across several backend request ids

## Proposed Worker Modes

Add one new effective mode while keeping the two existing concepts:

- `verbose`
  - current behavior
  - emit all structured worker logs

- `reduced`
  - current behavior
  - emit errors, anomalies, and the reduced allowlist

- `sampled`
  - new default candidate for production
  - emit all errors and anomalies
  - emit normal `reduced` logs only for sampled-in sessions

Recommended production direction:

- local dev can still use `verbose`
- production should move from global `reduced` to global `sampled`

## Proposed Worker Controls

### Base env vars

- `WORKER_LOG_MODE`
  - allowed values: `verbose`, `reduced`, `sampled`
  - recommended production default after rollout: `sampled`

- `WORKER_LOG_SAMPLE_RATE`
  - decimal between `0` and `1`
  - example: `0.01` for `1%` of client sessions
  - only used when `WORKER_LOG_MODE=sampled`

### Explicit debug overrides

- `WORKER_LOG_FORCE_REDUCED_SESSION_IDS`
  - comma-separated exact `clientSessionId` values
  - always emit `reduced` logs for those sessions even if they hash out of the sample

- `WORKER_LOG_FORCE_VERBOSE_SESSION_IDS`
  - comma-separated exact `clientSessionId` values
  - emit full verbose logs only for those sessions
  - intended for short-lived incident debugging

- `WORKER_LOG_FORCE_SESSION_PREFIXES`
  - comma-separated prefixes
  - recommended initial value includes `swarm_`
  - keeps test harness sessions logged without hand-curating every bot id

- `WORKER_LOG_ALLOW_CLIENT_VERBOSE`
  - default: `0`
  - when `1`, the worker may honor a client request for per-session `verbose`
  - this is an explicit guardrail so accidental public URL sharing does not silently push production into verbose logging

Operational note:

- after this feature exists in code, client-requested backend `verbose` still requires the worker config to allow it
- in the current repo model that means changing worker env/config and deploying that configuration
- client-requested `reduced` does not need a second emergency redeploy once the feature itself is shipped

## Sampling Decision Model

The worker should make one deterministic sampling decision per `clientSessionId`.

Recommended behavior:

1. If the event is an error or anomaly already preserved by the current `reduced` logic, always log it.
2. If the effective global mode is `verbose`, log everything.
3. If the effective global mode is `reduced`, apply the current reduced filter and log the surviving events.
4. If the effective global mode is `sampled`:
   - if the session is explicitly forced to `verbose`, log everything for that session
   - else if the session is explicitly forced to `reduced`, apply the current reduced filter and log the surviving events
   - else if the session matches a forced prefix such as `swarm_`, apply the current reduced filter and log the surviving events
   - else if the session hashes into the sample, apply the current reduced filter and log the surviving events
   - else suppress routine non-error session-scoped logs

Important details:

- the hash must be stable across requests and worker instances
- the hash must not depend on event name or timestamp
- if an event has no usable `clientSessionId`, keep current non-session behavior rather than pretending it belongs to a sampled-out session

That last point matters because some worker events do not naturally belong to one browser session.

Typical examples:

- DO alarms and timer-driven work
- pull cycles or persistence work that may serve several clients at once
- backend coordination events where there is no single honest client owner

For those events, inventing a `clientSessionId` would be misleading.

Recommended policy:

- if an event already has a real `client_session_id`, use it for sampling
- if an event is a direct consequence of one client action and we can propagate the session id without ambiguity, we should pass it through and log it with that `client_session_id`
- if an event is backend-owned or many-to-many, leave it as backend/system scoped and keep current reduced behavior

Recommended fallback for events without `clientSessionId`:

- preserve current `reduced` behavior for backend/system events
- only apply session sampling to logs that actually carry `client_session_id`

## Expanding `client_session_id` Coverage

This plan should explicitly include a pass to add `client_session_id` to more worker events wherever the ownership is unambiguous.

Rule:

- if one and only one client session is involved, pass that `client_session_id` through
- if more than one client session could honestly claim the event, do not pick one arbitrarily

Good candidates:

- websocket connect and close follow-up logs
- client-originated message handling
- validation and rejection logs for one client message
- one-client setCell enqueue, suppression, acceptance, rejection, and response-path logs
- one-client subscription change logs
- one-client error reply logs

Poor candidates:

- DO alarms
- persistence flushes
- peer pull cycles
- shared fanout work
- hub or shard coordination that aggregates several clients

Implementation expectation:

- the first implementation should include a targeted pass over worker log callsites to thread through `client_session_id` when a single client object or single client-derived context is already available
- this is not a request to invent synthetic ownership for backend-only work
- when propagation is cheap and honest, we should do it now rather than leaving it as a vague follow-up

## Client-Driven Recovery To `reduced`

This is the minimum user-visible recovery path requested for real incidents.

Goal:

- if a user sees a bug, they should have a practical way to reload the page and get their session back to the same worker logging level we currently call `reduced`

Recommended behavior:

- add a frontend URL flag such as `?debug_logs=reduced`
- when present, the client stores a short-lived debug logging preference in `sessionStorage`
- the client stores and sends an expiry no more than `15 minutes` from enable time
- the stored preference is attached to websocket and relevant HTTP requests for that browser session
- the worker treats that session as `forced reduced`

Why `sessionStorage`:

- it is scoped to the current tab/session rather than persisting across days
- it maps well to the existing `clientSessionId` lifecycle
- it avoids relying on users to keep the URL parameter on every navigation

Recommended UX:

- `?debug_logs=reduced` enables the current browser tab for the remainder of that tab session
- the override also expires after `15 minutes`, even if the tab remains open
- `?debug_logs=off` clears the stored override

Required expiry behavior:

- expiry must be enforced server-side, not only in the browser
- when a previously requested debug override has expired, the worker should emit a server-side structured event such as `log_override_expired`
- that event should include the `client_session_id`, the requested level that expired, and the resulting `log_policy`

Reason:

- when we are debugging later, we should be reminded that the session was no longer under the temporary override

Recommended backend trust model:

- do not trust arbitrary client requests for unrestricted `verbose`
- do allow arbitrary clients to request `reduced` for their own session, because that restores only the current baseline observability level rather than exceeding it

## Optional Client-Driven `verbose`

For difficult bugs we may still want a deeper one-session trace.

Recommended shape:

- URL flag: `?debug_logs=verbose`
- frontend stores the request in `sessionStorage`
- worker only honors it when `WORKER_LOG_ALLOW_CLIENT_VERBOSE=1`

This gives us two useful behaviors:

- safe default: user can self-escalate only to `reduced`
- controlled debugging mode: we can temporarily allow user-triggered per-session `verbose` without flipping the whole deployment

## Frontend Logging Behavior

The frontend should remain separate from worker structured logging, but the controls should feel consistent.

Recommended additions:

- keep existing category flags for `protocol`, `ui`, and `other`
- add a simple alias URL flag such as `?debug=1`
- `?debug=1` should enable all current client log categories
- `?debug_logs=reduced` should also imply local client logging on the current page, so backend and browser evidence are captured together

This means the practical incident flow becomes simple:

- reload the page with `?debug_logs=reduced`
- reproduce the bug
- capture both browser logs and worker logs for the same `clientSessionId`

Optional frontend build flag:

- `VITE_DEBUG_LOG_ALIAS_ENABLED`
  - if we want a hard switch to completely disable URL-driven verbose helpers in production builds

That build flag is optional. The more important backend guard is still `WORKER_LOG_ALLOW_CLIENT_VERBOSE`.

## Swarm Script Defaults

Swarm runs should default to logging-enabled behavior.

This is important because the whole point of the swarm harness is to produce debuggable runs, and the current production-debug workflow already pivots on bot `clientSessionId` values.

Recommended requirement:

- any `clientSessionId` beginning with `swarm_` should automatically be treated as `forced reduced`

Why this should be the default:

- the swarm scripts already generate stable ids with that prefix
- production swarm runs are rare and intentional
- a sampled-out swarm run would make the harness materially less useful
- the extra log volume from swarm bots is bounded and attributable

Optional future refinement:

- instead of a prefix rule, the swarm coordinator could append a dedicated debug param on bot websocket connects
- prefix-based inclusion is still the simpler first step because it works with the ids already emitted today

Documentation follow-up for the swarm docs:

- explicitly state that swarm sessions default to worker `reduced` logging even when production is in `sampled` mode

## Implementation Shape

### Worker

Add a small observability policy layer near [`../apps/worker/src/observability.ts`](../apps/worker/src/observability.ts) that can answer:

- what the global mode is
- whether this event is always-loggable because it is an error or anomaly
- whether the current session is forced `verbose`
- whether the current session is forced `reduced`
- whether the current session hashes into the sample
- what `log_policy` should be attached to emitted events

Suggested separation:

- keep the existing reduced-event filtering logic
- add a separate session-sampling decision helper
- feed both decisions into one final `shouldLogStructuredEvent` path

### Frontend

Add a small runtime resolver near [`../apps/web/src/logger.js`](../apps/web/src/logger.js) and [`../apps/web/src/runtimeFlags.js`](../apps/web/src/runtimeFlags.js) to handle:

- reading `debug_logs` and `debug` URL params
- persisting the session-scoped debug preference
- attaching the chosen debug level to websocket and auth/session requests
- clamping the client-advertised expiry to at most `15 minutes`

The worker-facing debug level should be explicit and narrow:

- `off`
- `reduced`
- `verbose`

### Transport propagation

Use the existing websocket connection path as the primary carrier, because most of the important runtime logs are websocket-driven.

Possible carriers:

- websocket query param
- request header on regular HTTP calls

The exact carrier is less important than consistency. Query params are acceptable here because:

- this app already carries `clientSessionId` in the websocket URL
- the value is operational rather than sensitive

Recommended worker-emitted log metadata:

- add `log_policy` to emitted structured events
- expected initial values:
  - `always_error`
  - `reduced_global`
  - `sampled_in`
  - `forced_reduced`
  - `forced_verbose`
  - `backend_reduced_no_session`
  - `override_expired`

## Rollout Plan

### Phase 1: Worker-only sampling foundation

- add `sampled` mode
- add stable hashing by `clientSessionId`
- keep errors/anomalies always logged
- expand `client_session_id` propagation for single-client worker paths
- keep events without `clientSessionId` on current `reduced` behavior

Status:

- implemented

Success criteria:

- worker log volume drops materially under normal traffic
- existing error visibility does not regress

### Phase 2: Client recovery to `reduced`

- add `?debug_logs=reduced`
- persist it in `sessionStorage`
- attach it on websocket connect
- cap it at `15 minutes`
- honor it on the worker as per-session `forced reduced`
- emit a server-side expiry log when that override expires

Status:

- implemented

Success criteria:

- a single browser can reproduce a bug and reliably restore current baseline worker logging for that session

### Phase 3: Controlled per-session `verbose`

- add `?debug_logs=verbose`
- guard it behind `WORKER_LOG_ALLOW_CLIENT_VERBOSE`
- document the intended temporary-use workflow

Status:

- implemented in code path
- disabled by default in worker config

Success criteria:

- deep incident traces are possible without flipping the whole worker to verbose

### Phase 4: Swarm default inclusion

- force `swarm_` sessions to `reduced`
- update swarm docs accordingly

Status:

- forcing `swarm_` sessions to reduced is implemented in worker config
- doc and runbook validation still worth checking in practice

Success criteria:

- swarm output remains actionable even after production moves to sampled logging

## Test Plan

### Worker tests

Add unit coverage for:

- sampled-out normal event is suppressed
- sampled-in normal event follows `reduced` rules
- errors and anomalies always log in sampled mode
- forced reduced session bypasses sampling
- forced verbose session bypasses both sampling and reduced filtering
- single-client worker paths include `client_session_id` when context is available
- events without `client_session_id` continue following current reduced behavior
- `swarm_` prefix sessions default to reduced logging
- expired client-requested reduced overrides fall back cleanly and emit a server-side expiry event
- emitted logs include the expected `log_policy`

### Frontend tests

Add coverage for:

- `debug_logs=reduced` persists for the current tab session
- `debug_logs=reduced` carries a max `15 minute` expiry
- `debug_logs=off` clears the persisted override
- `debug=1` enables all client log categories
- request wiring carries the chosen debug level alongside `clientSessionId`

### Swarm tests

Add or update coverage for:

- default swarm `clientSessionId` values continue using the `swarm_` prefix
- docs and run-config output make the implied logging behavior clear

## Decisions From Review

- Client-requested `reduced` logging should expire after `15 minutes` even if the tab remains open.
- That expiry should be logged server-side so later debugging makes the loss of the temporary override obvious.
- Per-session sampling is sufficient for this pass; no separate event-family sample rates are planned now.
- Emitted worker logs should carry a dedicated `log_policy` field for later analysis.
- The implementation should expand `client_session_id` propagation across worker paths where one and only one client session is involved.

## Recommended First Cut

The first implementation should be the smallest version that solves the operational problem:

- production worker mode becomes `sampled`
- deterministic sampling key is `clientSessionId`
- all errors and anomalies remain unsampled
- `?debug_logs=reduced` restores one session to the current worker `reduced` level for at most `15 minutes`
- `swarm_` sessions default to `reduced`
- emitted worker logs carry `log_policy`

That gets the main cost and signal benefits without committing the whole system to per-session verbose logging on day one.
