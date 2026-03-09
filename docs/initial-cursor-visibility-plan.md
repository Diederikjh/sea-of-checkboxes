# Initial Cursor Visibility Plan

This is the active plan for the remaining cursor issue: remote cursors sometimes appear much later than expected on some cross-shard paths, even when the storm and recursion failures are otherwise under control.

Historical storm-mitigation work now lives in [historical-problems/cursor-storm-plan.md](./historical-problems/cursor-storm-plan.md).

## Problem Summary

The main cursor-storm failure mode has improved materially, but live multi-window runs still show a separate correctness problem:

- some cross-shard cursor directions become visible quickly
- the reverse direction can arrive tens of seconds later, or only briefly
- this can happen even when there are:
  - `0` `internal_error`
  - `0` `server_error_sent`
  - `0` visible pull-recursion failures

So the active problem is no longer "storm or no storm". It is initial remote cursor visibility latency on real multi-shard paths.

## Goal

Keep the current pull-based design and get initial remote cursor visibility down to about `20s` or better in representative multi-shard runs, without adding pair-specific hacks or reintroducing push-era complexity.

## Non-Goals

- Do not overfit to one paired-browser case or one shard pair.
- Do not add bespoke "A talks to B faster" rules.
- Do not compromise the detached pull design just to reduce latency in one direction.
- Do not regress the storm protections already in place.

## Current Status

What is already true in repo:

- watched-peer scoping is implemented
- scheduled cursor pull is detached through DO alarms
- ingress suppression and post-ingress suppression are implemented
- client/server trace correlation exists
- alarm-path observability exists
- stale-side scope-to-wake instrumentation is now in repo:
  - `cursor_pull_scope`
  - `cursor_pull_scope_unchanged`
  - `cursor_pull_watch_scope_wake`
  - `cursor_pull_alarm_armed`
  - `cursor_pull_alarm_fired`
  - `cursor_pull_peer` with `scope_observed_at_ms` and `scope_age_ms`
  - `cursor_pull_first_peer_visibility`

What still happens in live runs:

- same-shard runs can look healthy and do not prove cross-shard correctness
- some cross-shard runs are also healthy
- other cross-shard runs remain asymmetric, where one shard pulls promptly and the stale side only pulls much later

Recent concrete evidence:

- `2026-03-08T13:54Z`:
  - `shard-3 -> shard-4` started promptly
  - `shard-4 -> shard-3` did not begin until about `61.9s` later
  - no stored `internal_error` or `server_error_sent`
- `2026-03-08T19:23Z`:
  - `shard-1` saw `shard-4` quickly
  - `shard-4` only saw a single `shard-1` cursor update about `108.5s` after `hello`
  - `shard-1 -> shard-4` started immediately after `watch_scope_change`
  - first observed `shard-4 -> shard-1` pull did not happen until much later, after `local_activity`
- `2026-03-09T18:28Z`:
  - private-window client saw the normal-window cursor quickly:
    - `hello` at `2026-03-09T18:28:47.474Z`
    - first remote tag `105` at `2026-03-09T18:28:50.171Z`
    - about `2.7s`
  - normal-window client saw the private-window cursor much later:
    - `hello` at `2026-03-09T18:28:46.891Z`
    - first remote tag `105` at `2026-03-09T18:29:53.837Z`
    - about `66.9s`
  - the fast side (`shard-4`) entered scope immediately:
    - `cursor_pull_scope` at `2026-03-09T18:28:47.282Z`
    - `cursor_pull_first_peer_visibility` at `2026-03-09T18:28:47.833Z`
    - about `0.5s` scope-to-first-visibility
  - the stale side (`shard-0`) did not enter scope until much later:
    - `cursor_hub_do.watch_sub` at `2026-03-09T18:28:46.698Z`
    - first `cursor_pull_scope` only at `2026-03-09T18:29:46.693Z`
    - about `60s` after its own watch subscribe
  - once `shard-0` finally entered scope, first visibility followed much sooner:
    - `cursor_pull_first_peer_visibility` at `2026-03-09T18:29:53.632Z`
    - about `6.9s` after scope arrival
  - this strongly suggests the main delay was late peer-scope delivery, not failure to pull promptly after scope was known

Interpretation:

- the stale shard can still be slow, but the newest run shows the larger delay is upstream of pull scheduling
- in at least one representative bad run, the stale shard simply did not learn about the new peer until about the watch-renew timescale
- this is now primarily a hub watch-scope propagation problem, with scheduler behavior as a secondary concern once scope actually arrives

## Working Hypotheses

For the stale shard in an asymmetric run, one of these is likely true:

1. `cursor_pull_scope` is arriving late because existing shards do not learn about new watched peers until a later hub watch refresh.
2. `watch_scope_change` wake is requested, but coalesced behind older pending work after scope is finally known.
3. the alarm is armed later than intended, or fired later than intended after scope is finally known.
4. early reverse pulls are happening but returning no updates until later.

The newest evidence makes `1` the leading hypothesis.

## Investigation Flow

For each asymmetric run:

1. Capture normal-window client log, private-window client log, and limited server tail.
2. Wait about `2 minutes` for Cloudflare worker logs to settle.
3. Use `pnpm logs:server:query` on the stale shard and trace this pipeline:
   - `cursor_pull_scope`
   - `cursor_pull_watch_scope_wake`
   - `cursor_pull_alarm_armed`
   - `cursor_pull_alarm_fired`
   - first reverse-direction `cursor_pull_peer`
   - `cursor_pull_first_peer_visibility`
4. Also compare hub membership timing:
   - `cursor_hub_do.watch_sub` for the stale shard
   - `cursor_hub_do.watch_sub` for the newly active peer
   - first `cursor_pull_scope` on the stale shard
5. Compare those timestamps with:
   - stale client `hello`
   - first remote tag `105`
   - any relevant `local_activity`
6. Decide whether the real delay is:
   - late scope delivery from the hub
   - delayed wake/alarm after scope delivery
   - delayed first non-empty peer snapshot after scope delivery

## Immediate Next Steps

1. Focus the next investigation on hub watch-scope propagation, not just stale-shard pull scheduling.
2. Confirm whether existing subscribed shards only learn about newly active peers on the watch-renew cadence.
3. If so, change the watch-membership flow so stale shards learn about new peers sooner than the current renew interval, without reintroducing push fanout complexity.
4. Only if scope already arrives promptly should we return to scheduler priority/coalescing work for fresh `watch_scope_change`.
5. Keep validating that any latency fix preserves:
   - no client-visible pull-path internal errors
   - no hidden recursive `/cursor-state` storm

## Acceptance Criteria

- Initial remote cursor visibility is about `20s` or better in representative multi-shard runs.
- The result holds across representative watched topologies, not just one shard pair.
- We do not need a later `local_activity` event to "kick" the stale shard into first visibility.
- Existing shards learn about newly active watched peers promptly, rather than only on a later renew cycle.
- Cursor latency improvements do not regress storm protections or reintroduce client-visible pull failures.

## Representative Validation Cases

- paired normal/private windows on different shards
- a wider watched set where more than two shards are active
- at least one run where the previously stale side is verified through worker logs, not just client feel

## Later Work

These are not part of the immediate latency fix, but may help later hardening:

- best-effort stale remote payload suppression via per-source version watermarks
- further reduction of steady-state `subAck` churn
- broader higher-concurrency cursor validation after the latency issue is understood
