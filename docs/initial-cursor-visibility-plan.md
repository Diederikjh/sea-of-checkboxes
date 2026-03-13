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
- shards now renew hub watch on a short probe interval while they have clients but no watched peers, then fall back to the normal renew interval once peer scope is non-empty
- scheduled cursor pull is detached through DO alarms
- ingress suppression and post-ingress suppression are implemented
- client/server trace correlation exists
- alarm-path observability exists
- cursor version tracing is now in repo:
  - local cursor fanout emits monotonic `ver`
  - protocol `curUp` carries `ver`
  - client ignores stale `curUp` versions
  - worker `cursor_pull_peer` logs include `max_seq` for pulled batches
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
- `2026-03-09T19:16Z`:
  - this was a real cross-shard run on `shard-3 <-> shard-4`
  - initial visibility happened in both directions, but subsequent updates were much more reliable in one direction than the other
  - worker logs showed successful `cursor_pull_peer` requests in both directions, with no `internal_error`, `server_error_sent`, or recursion failures
  - the slower side (`shard-4`) did eventually get prompt scope:
    - `cursor_pull_scope` at `2026-03-09T19:16:47.857Z`
    - first `cursor_pull_first_peer_visibility` at `2026-03-09T19:16:50.379Z`
    - about `2.35s` scope-to-first-visibility
  - many later peer pulls on the weaker direction still returned `update_count: 1` but `delta_observed: false`
  - that points away from transport loss and toward snapshot coalescing or stale/unchanged cursor-state snapshots on pull
- `2026-03-09T19:44Z`:
  - this was another real cross-shard run on `shard-4 <-> shard-7`
  - `shard-7 -> shard-4` became visible quickly:
    - `watch_sub` for `shard-7` at `2026-03-09T19:44:28.236Z`
    - first non-empty `cursor_pull_peer` at `2026-03-09T19:44:30.167Z`
    - first client-visible remote cursor on the receiving window at `2026-03-09T19:44:34.225Z`
  - the reverse direction stayed stale much longer:
    - `cursor_pull_scope` on `shard-4` already at `2026-03-09T19:44:32.039Z`
    - first observed `shard-4 -> shard-7` pulls were still empty around `2026-03-09T19:45:01Z`
    - first non-empty `shard-4 -> shard-7` pull only at `2026-03-09T19:45:33.010Z`
    - first remote cursor on the stale client also at `2026-03-09T19:45:33.269Z`
  - versioned pull logs now show:
    - the fast direction reached `max_seq: 62` by about `2026-03-09T19:45:23Z`
    - the slow direction still had long stretches of `update_count: 0`
    - once the slow direction finally became non-empty, it immediately jumped to `max_seq: 121`
  - this suggests the wire path is not simply dropping random frames; instead we still lack proof of where versions are disappearing:
    - source local cursor publish
    - source `/cursor-state` snapshot selection
    - destination ingest/fanout
- `2026-03-10T19:47Z`:
  - this was a local swarm-backed run with `4` protocol bots and captured dev-worker stdout
  - shard placement was:
    - `bot-001` on `shard-4`
    - `bot-002`, `bot-003`, and `bot-004` on `shard-3`
  - `shard-4 -> shard-3` first visibility was fast:
    - `cursor_pull_scope` on `shard-4` at `2026-03-10T19:47:19.588Z`
    - first `cursor_pull_first_peer_visibility` on `shard-4` at `2026-03-10T19:47:20.650Z`
    - about `1.06s`
  - `shard-3 -> shard-4` still lagged:
    - `cursor_pull_scope` on `shard-3` at `2026-03-10T19:47:19.696Z`
    - first `cursor_pull_first_peer_visibility` on `shard-3` at `2026-03-10T19:47:26.561Z`
    - about `6.86s`
  - the stale side already had prompt scope, so this run does not support late hub scope delivery as the main cause
  - the source side was already publishing before first visibility on the stale side:
    - `cursor_local_publish` on `shard-4` at `2026-03-10T19:47:20.604Z`, `21.606Z`, `22.627Z`, `23.611Z`, `24.615Z`, `25.617Z`
  - the first successful reverse pull on the stale side was:
    - `cursor_state_snapshot_served` from `shard-4` at `2026-03-10T19:47:26.557Z` with `update_count: 1`, `max_seq: 6`
    - followed by `cursor_pull_peer` on `shard-3` at `2026-03-10T19:47:26.560Z`
    - `wake_reason: "local_activity"`
  - this points away from late scope discovery and toward stale-side scheduling or wake behavior before first non-empty reverse pull
- `2026-03-10T20:04Z`:
  - this was a second local swarm-backed run with `4` protocol bots and captured dev-worker stdout
  - shard placement was:
    - `bot-001` on `shard-4`
    - `bot-002` on `shard-1`
    - `bot-003` on `shard-6`
    - `bot-004` on `shard-5`
  - three directions were fast:
    - `bot-001`, `bot-003`, and `bot-004` saw first remote cursors in about `633ms` to `727ms`
  - one direction was still slow:
    - `bot-002` on `shard-1` saw first remote cursors only after about `11.4s` to `11.6s`
  - the weak shard showed two distinct delays:
    - late scope discovery:
      - `ws_connect` on `shard-1` at `2026-03-10T20:04:11.044Z`
      - first `cursor_pull_scope` on `shard-1` only at `2026-03-10T20:04:16.131Z`
      - about `5.1s`
    - then delayed first non-empty reverse pulls after scope was already known:
      - repeated `cursor_pull_local_activity_wake` logs on `shard-1` between `2026-03-10T20:04:17Z` and `2026-03-10T20:04:23Z`
      - first `cursor_pull_first_peer_visibility` on `shard-1` only at `2026-03-10T20:04:23.428Z` to `20:04:23.460Z`
      - `scope_age_ms` about `7288` to `7327`
      - `wake_reason: "local_activity"`
  - after first visibility, the weak direction did continue to receive later cursor updates:
    - for example `shard-1` pulled `next_seq: 14` around `2026-03-10T20:04:25.284Z` to `20:04:25.332Z`
    - and later `next_seq: 29` around `2026-03-10T20:04:40.217Z` to `20:04:40.219Z`
  - but those follow-up updates were still coarse and bursty rather than one-for-one with source moves:
    - the destination often jumped multiple source versions at once, for example `previous_seq: 12 -> next_seq: 14`
    - client-side `curUp` delivery after first visibility came in bursts separated by seconds, not at the source send cadence
  - this run points to a compounded failure mode:
    - first late hub scope discovery
    - then delayed first useful reverse pull even after scope was known
    - then sparse/coalesced follow-up visibility once the peer finally became visible
- `2026-03-10T20:21Z`:
  - this was a third local swarm-backed run with `4` protocol bots and captured dev-worker stdout after reducing the empty-scope hub watch probe interval from `5000ms` to `500ms`
  - shard placement was:
    - `bot-001` on `shard-0`
    - `bot-002` on `shard-7`
    - `bot-003` on `shard-1`
    - `bot-004` on `shard-5`
  - all directions were materially better:
    - all bots saw first remote cursors in about `893ms` to `1292ms`
  - peer scope also arrived quickly:
    - `cursor_pull_scope` on `shard-7` at `2026-03-10T20:21:01.990Z`
    - `cursor_pull_scope` on `shard-1` at `2026-03-10T20:21:01.991Z`
    - `cursor_pull_scope` on `shard-5` at `2026-03-10T20:21:01.992Z`
    - `cursor_pull_scope` on `shard-0` at `2026-03-10T20:21:02.662Z`
  - first peer visibility followed promptly after scope:
    - `cursor_pull_first_peer_visibility` on `shard-5` at about `2026-03-10T20:21:03.299Z`
    - `cursor_pull_first_peer_visibility` on `shard-1` at about `2026-03-10T20:21:03.894Z`
    - `cursor_pull_first_peer_visibility` on `shard-7` at about `2026-03-10T20:21:03.895Z`
    - `cursor_pull_first_peer_visibility` on `shard-0` at about `2026-03-10T20:21:03.895Z` and `20:21:04.233Z`
  - this run is the strongest evidence so far that late empty-scope peer discovery was a real contributor to the delayed initial cursor problem
  - it also confirms the tradeoff of the tactical fix:
    - quiet connected shards with zero peers now renew hub watch state much more often
    - the latency gain is real, but the steady empty-scope watch cost is higher than we want permanently
- `2026-03-10T20:30Z`:
  - this was a fourth local swarm-backed run with `4` protocol bots and captured dev-worker stdout after the same `500ms` empty-scope probe change
  - shard placement was:
    - `bot-001` on `shard-7`
    - `bot-002` on `shard-5`
    - `bot-003` on `shard-3`
    - `bot-004` on `shard-0`
  - three shards were still fast:
    - `shard-0` saw first remote cursors in about `605ms` to `645ms`
    - `shard-3` saw first remote cursor in about `796ms`
    - `shard-7` saw first remote cursors in about `798ms` to `831ms`
  - one shard was still slow:
    - `shard-5` saw first remote cursors only after about `9835ms` to `10081ms`
  - the slow shard did not suffer late peer discovery this time:
    - `cursor_pull_scope` on `shard-5` at `2026-03-10T20:30:40.657Z`
    - peer scope already included `shard-0`, `shard-3`, and `shard-7`
  - but first peer visibility on `shard-5` still lagged badly:
    - `cursor_pull_first_peer_visibility` on `shard-5` at `2026-03-10T20:30:50.950Z` to `20:30:50.999Z`
    - `scope_age_ms` about `10241` to `10294`
    - `wake_reason: "local_activity"`
  - this run shows the empty-scope probe fix is not sufficient by itself:
    - fast scope arrival can still be followed by a long wait for first useful reverse pull
    - the remaining delay is now more clearly in stale-side post-scope wake scheduling, suppression, or first useful pull execution
- `2026-03-13T16:53Z`:
  - this was a later local swarm-backed run with `4` protocol bots and captured dev-worker stdout after enabling the one-shot first-post-scope suppression bypass through local worker config
  - the local worker finally showed the experiment binding loaded, and the worker logs included `bypass_enabled: true`
  - shard placement was:
    - `bot-001` on `shard-2`
    - `bot-002` on `shard-0`
    - `bot-003` on `shard-4`
    - `bot-004` on `shard-1`
  - client-side first remote cursor timings were materially better than the earlier bad runs:
    - `shard-0` saw first remote cursors in about `609ms`
    - `shard-4` saw first remote cursors in about `609ms`
    - `shard-1` saw first remote cursors in about `609ms` to `610ms`
    - `shard-2` saw first remote cursors in about `1332ms` to `1333ms`
  - the key worker-side confirmation was on `shard-2`:
    - `cursor_pull_scope` arrived at `2026-03-13T16:53:23.131Z`
    - `cursor_pull_first_post_scope_decision` logged `action: "started_with_suppression_bypass"` at `2026-03-13T16:53:24.065Z`
    - `bypass_enabled: true`
    - `suppression_remaining_ms: 191`
    - first peer visibility followed immediately after at `2026-03-13T16:53:24.067Z` to `16:53:24.069Z`
    - `scope_age_ms` about `934` to `937`
  - this run is the first direct evidence that stale-side suppression can delay the first useful post-scope pull, and that bypassing that suppression once can restore prompt first visibility for that run shape
  - this run does not prove the whole cursor problem is solved:
    - it is one successful sample
    - it still needs repeat validation against more shard placements and more runs
- `2026-03-13T19:28Z`:
  - this was the first pairwise confirmation run after leaving the first-post-scope suppression bypass enabled in local worker config
  - the worker again showed `bypass_enabled: true`, and one shard used `action: "started_with_suppression_bypass"` promptly
  - shard placement was:
    - `bot-001` on `shard-0`
    - `bot-002` on `shard-6`
    - `bot-003` on `shard-6`
    - `bot-004` on `shard-4`
  - the result was mixed:
    - `shard-4` saw first remote cursors quickly, about `211ms`
    - `shard-0` and `shard-6` still saw first remote cursors only after about `3.9s` to `4.4s`
  - the key worker-side detail is that the slower paths were not waiting on stale-side suppression anymore:
    - `cursor_pull_first_post_scope_decision` on `shard-0` logged `action: "started"` with `suppression_remaining_ms: 0`
    - `cursor_pull_first_post_scope_decision` on `shard-6` logged `action: "started_with_suppression_bypass"`
  - but the early snapshots from those peers were empty:
    - `cursor_state_snapshot_served` from `shard-0` and `shard-6` initially returned `update_count: 0`
    - first visible remote cursor state from those peers only appeared once their local cursor state started publishing later
  - this run weakens the idea that every remaining multi-second delay is stale-side scheduling:
    - some of the "slow" first-visibility cases are actually first pulls against empty peer snapshots
- `2026-03-13T19:30Z`:
  - this was the second pairwise confirmation run under the same bypass-enabled local config
  - shard placement was:
    - `bot-001` on `shard-3`
    - `bot-002` on `shard-2`
    - `bot-003` on `shard-1`
    - `bot-004` on `shard-3`
  - this run was healthy end-to-end:
    - all bots saw first remote cursors in about `306ms` to `1373ms`
    - scope discovery was prompt
    - first post-scope pull decisions all logged `action: "started"` with `bypass_enabled: true`
  - no multi-second or `10s` initial cursor stall reappeared in this sample
  - this run supports keeping the bypass enabled for ongoing investigation, but it does not yet justify treating the bypass as the whole fix
- `2026-03-13T19:38Z`:
  - this was the first local swarm run after adding `cursor_pull_pre_visibility_observation`
  - shard placement was:
    - `bot-001` on `shard-4`
    - `bot-002` and `bot-004` on `shard-5`
    - `bot-003` on `shard-0`
  - the slower path in this sample was `shard-4`, which saw first remote cursors in about `1687ms` to `2095ms`
  - the useful new signal is that all pre-visibility observations in this run were:
    - `cursor_pull_pre_visibility_observation`
    - `outcome: "empty_snapshot"`
  - there were no observed `nonempty_without_delta` cases in this sample
  - worker evidence showed:
    - first-post-scope decisions still started promptly
    - the stale side pulled peers early
    - but those peers initially served `update_count: 0`
    - first visibility arrived only after those peer shards produced their first local cursor publish
  - this narrows the lead for this run shape:
    - the delay is not destination ingest with a non-empty snapshot
    - it is source-side time-to-first-local-cursor
  - this also exposed a swarm-harness artifact:
    - bots were waiting a full `cursorIntervalMs` before sending their first `cur`
    - with the default `1000ms` interval, early `empty_snapshot` pulls were expected even when the backend was healthy
  - the swarm harness should send an immediate bootstrap cursor on startup so future runs isolate backend delay instead of bot startup delay
- `2026-03-13T19:48Z`:
  - this was the next local swarm run after changing the swarm harness to send a bootstrap cursor immediately instead of waiting one full `cursorIntervalMs`
  - shard placement was:
    - `bot-001` on `shard-7`
    - `bot-002` and `bot-004` on `shard-3`
    - `bot-003` on `shard-6`
  - first local cursor publishes were prompt on every source shard:
    - `cursor_first_local_publish` on `shard-3` at connection age about `156ms` and `159ms`
    - `cursor_first_local_publish` on `shard-6` at connection age about `158ms`
    - `cursor_first_local_publish` on `shard-7` at connection age about `178ms`
  - the resulting first remote cursor timings were materially better:
    - `shard-3` bots saw first remote cursors in about `368ms` to `623ms`
    - `shard-6` saw first remote cursor at about `619ms`
    - `shard-7` saw first remote cursors at about `1270ms` to `1271ms`
  - importantly, this run did not produce early `cursor_pull_pre_visibility_observation` rows for `empty_snapshot`
  - the worker log instead showed prompt first post-scope decisions and prompt first peer visibility with `max_seq: 1`
  - this confirms the earlier `empty_snapshot` lead was at least partly a swarm artifact:
    - waiting a full interval before the first bot cursor send was injecting avoidable startup delay into the experiment
  - after removing that artifact, the remaining cursor latency is still worth tracking, but it is much closer to the scheduler / scope timing we actually care about

Interpretation:

- the stale shard can still be slow, but the newest run shows the larger delay is upstream of pull scheduling
- in at least one representative bad run, the stale shard simply did not learn about the new peer until about the watch-renew timescale
- this is now primarily a hub watch-scope propagation problem, with scheduler behavior as a secondary concern once scope actually arrives
- in newer runs where scope arrives and pull succeeds, the remaining issue looks more like coarse snapshot semantics than dropped cursor messages
- the newest versioned run strengthens that last point: the current version logs tell us the pulled snapshot sometimes jumps from empty to a much higher latest version, but they still do not tell us whether:
  - the source was publishing those versions continuously
  - `/cursor-state` was omitting them until later
  - or the destination was ingesting only some of the newer versions
- the `2026-03-10T19:47Z` local swarm run adds a second important pattern:
  - scope can arrive promptly on the stale side
  - source local publish can also be prompt
  - yet first reverse visibility can still wait until a later `local_activity` wake
  - that shifts suspicion toward stale-side wake scheduling, wake coalescing, or delayed first non-empty reverse pull after scope is already known
- the `2026-03-10T20:04Z` local swarm run adds a third pattern:
  - late scope discovery and delayed first useful reverse pull can happen in the same run
  - once the stale shard finally starts seeing peers, visibility is better than before first discovery, but it is still bursty and version-coalesced
  - that means "peer discovered" is not the whole fix; it improves reliability, but it does not restore prompt per-move visibility
- the `2026-03-10T20:21Z` local swarm run adds the first strong mitigation result:
  - reducing the empty-scope watch probe interval removed the multi-second peer-discovery stall in that run shape
  - that makes late empty-scope hub discovery a confirmed bug, not just a hypothesis
  - but the current `500ms` probe is a tactical setting, not the desired final design
  - we should keep the discovery win while reducing idle cost, ideally with adaptive probing or an event-driven peer-appearance signal instead of permanent fast polling
- the `2026-03-10T20:30Z` local swarm run narrows the remaining problem:
  - the same `500ms` probe can produce a fast run for most shards and still leave one shard waiting about `10s`
  - in that run, peer scope on the slow shard was already prompt
  - so the residual delay is no longer explained by empty-scope discovery
  - this makes stale-side post-scope scheduling or first useful reverse-pull behavior the primary remaining lead
- the `2026-03-13T16:53Z` local swarm run adds the first successful scheduler-path experiment result:
  - the worker logged a real `started_with_suppression_bypass` decision with `bypass_enabled: true`
  - first peer visibility on that shard followed immediately afterward, rather than waiting for the suppression window to expire
  - that is strong evidence that suppression on the stale-side first post-scope pull is at least one real contributor to the delayed initial cursor problem
  - this still needs repeat validation, but the suppression-bypass experiment now looks like a credible causal lead rather than only a hypothesis
- the `2026-03-13T19:28Z` and `2026-03-13T19:30Z` confirmation runs refine that conclusion:
  - the bypass remains useful and should stay enabled during investigation
  - but it is not the whole story
  - at least one of the mixed "slow" samples was explained by early pulls against empty peer snapshots, not by stale-side suppression
  - that means the next debugging gap is distinguishing:
    - source peer has not published a local cursor yet
    - source snapshot is non-empty but destination has no new delta
    - destination finally ingests and fans out a real first visible cursor
  - worker logging should now make that distinction explicit, instead of inferring it by hand from separate `cursor_state_snapshot_served` and `cursor_remote_ingest` rows
- the `2026-03-13T19:38Z` run narrows the next step again:
  - in that sample, the remaining delay was entirely explained by `empty_snapshot`
  - that makes source-side first local cursor publish latency the main lead for that run shape
  - it also means swarm startup behavior has to be corrected before using those early empty pulls as backend evidence
- the `2026-03-13T19:48Z` run validates that correction:
  - once bots publish a bootstrap cursor immediately, the artificial startup `empty_snapshot` gap largely disappears
  - that means future swarm runs are more trustworthy for backend diagnosis
  - it also raises the bar for any remaining delay: if we still see slow first visibility now, it is less likely to be caused by the harness itself

## Working Hypotheses

For the stale shard in an asymmetric run, one of these is likely true:

1. `cursor_pull_scope` is arriving late because existing shards do not learn about new watched peers until a later hub watch refresh.
2. `watch_scope_change` wake is requested, but coalesced behind older pending work after scope is finally known.
3. the alarm is armed later than intended, or fired later than intended after scope is finally known.
4. early reverse pulls are happening but returning no updates until later.
5. repeated peer pulls are succeeding, but the destination often sees no effective delta because cursor-state is a latest-snapshot pull and intermediate moves are being coalesced away.
6. the remaining observability gap is between source local publish, snapshot assembly, destination ingest, and stale-side wake scheduling; we still cannot prove which of those stages is causing the long empty or sparse periods.

The newest evidence splits the likely causes by run shape:

- when scope itself arrives late, `1` remains the leading hypothesis
- when scope arrives promptly but first visibility still waits for later `local_activity`, `2`, `3`, and `4` become stronger candidates
- when both happen in the same run, the likely shape is late scope delivery first, then `2`, `3`, or `4` before the first useful reverse pull
- `5` remains the leading hypothesis for sparse follow-up visibility after the first cursor appears
- after the `2026-03-13T16:53Z` bypass run, `2` and `4` are stronger than `3` for the first-useful-pull delay:
  - stale-side suppression and scheduling policy now have a positive experimental signal
  - alarm timing alone is a weaker lead than before
- after the `2026-03-13T19:28Z` confirmation run, `4` needs to be split in two:
  - `4a`: early reverse pulls are happening, but the source peer snapshot is still empty because no local cursor has been published yet
  - `4b`: early reverse pulls are happening, the source peer snapshot is non-empty, but the destination still sees no effective delta
- after the `2026-03-13T19:38Z` pre-visibility run, `4a` is now directly observed in worker logs rather than inferred

## Swarm Debug Method

We now have a promising local debug loop using the swarm harness plus captured dev-worker logs.

Important operational note:

- for dev-local reproduction, both the local worker and the local swarm coordinator need to run outside the sandbox
- sandboxed runs can fail before the useful part of the experiment:
  - `pnpm dev:worker` may fail because `pnpm dlx wrangler` needs network access
  - `pnpm swarm:run` may fail because local HTTP and websocket traffic to the dev worker is blocked
- if either side stays sandboxed, the run may never reach `hello`, share-link creation can fail, and the resulting logs are not valid for cursor diagnosis

Recommended local workflow:

1. Start the local worker outside the sandbox and capture stdout to a file.
2. Run a longer swarm outside the sandbox against the local `/ws` endpoint with enough bots to increase cross-shard placement probability, for example `4` bots for `30s`.
3. Inspect the swarm per-bot summaries first:
   - shard placement
   - first remote cursor latency
   - remote cursor counts by peer
4. If the run is same-shard only, discard it for cursor-latency diagnosis and rerun.
5. If the run is cross-shard and asymmetric, pivot immediately to the worker log and trace:
   - `cursor_pull_scope`
   - `cursor_pull_watch_scope_wake`
   - `cursor_pull_local_activity_wake`
   - `cursor_pull_alarm_armed`
   - `cursor_pull_alarm_fired`
   - `cursor_pull_peer`
   - `cursor_pull_first_peer_visibility`
   - `cursor_local_publish`
   - `cursor_state_snapshot_served`
   - `cursor_remote_ingest`

Why this is useful:

- it gives deterministic bot identities, shard placement, and timing without needing manual paired-browser choreography
- it lets us capture the full worker stdout chain in one local file
- it is good at separating:
  - late scope discovery
  - prompt scope but delayed first non-empty reverse pull
  - prompt pull with stale or unchanged snapshots

Current artifact shape from a useful local run:

- swarm summary and per-bot logs in `logs/swarm/<run-id>/`
- captured worker stdout copied into the same folder as `worker.log`

## Investigation Flow

For each asymmetric run:

1. Capture normal-window client log, private-window client log, and limited server tail.
2. Wait about `2 minutes` for Cloudflare worker logs to settle.
3. Use `pnpm logs:server:query` on the stale shard and trace this pipeline:
   - `cursor_pull_scope`
   - `cursor_pull_watch_scope_wake`
   - `cursor_pull_local_activity_wake`
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
   - delayed `watch_scope_change` or `local_activity` wake after scope delivery
   - delayed first non-empty peer snapshot after scope delivery
   - repeated unchanged snapshots after pull succeeds
7. If versioned pull logs still show late empty-to-high-version jumps, inspect the missing internal stages:
   - source local cursor publish sequence
   - source `/cursor-state` snapshot contents
   - destination ingest/fanout decision

## Immediate Next Steps

1. Treat the empty-scope probe change and the first-post-scope suppression bypass as partial fixes, not complete resolution:
   - it removes one discovery failure mode
   - the bypass experiment improves one stale-side scheduling failure mode
   - neither result is yet validated enough to call the problem closed
2. Repeat the enabled-bypass local probe across a few more cross-shard runs and compare it directly with the no-bypass baseline.
3. If the bypass keeps improving first visibility, decide whether to:
   - keep it as a narrow first-post-scope special case
   - or replace it with a more principled scheduler rule for the first useful reverse pull
4. Replace the fixed `500ms` empty-scope probe with an adaptive policy, for example:
   - probe quickly for the first few seconds after connect or local cursor activity
   - then back off toward a slower cadence if peer scope stays empty
5. Explore an event-driven alternative to repeated empty-scope polling:
   - when the hub sees a newly active watched peer, emit a lightweight "peer appeared" nudge to existing empty-scope watchers
   - use that nudge to force an immediate watch refresh or pull wake on the stale shard
   - evaluate whether this can preserve fast first visibility with less idle hub traffic than continuous short probes
6. Add the next layer of versioned cursor observability:
   - source local cursor publish log with `uid`, `seq`, `tileKey`, and shard
   - source `/cursor-state` snapshot log with included cursor `uid`s and max local seq
   - destination remote ingest log with previous seq, new seq, and whether client fanout happened
   - stale-side local-activity wake scheduling log with scheduler state and action
7. Use those logs on the weak direction to determine whether the problem is:
   - source cursor movement not being published
   - `/cursor-state` exposing stale or empty snapshots
   - destination discarding or not fanning newer versions
8. If late scope delivery still happens while peer scope is already non-empty, investigate hub membership propagation beyond the empty-scope case.
9. Now that the bypass experiment has produced one successful positive result, prioritize scheduler priority, suppression, and first useful reverse-pull behavior for fresh `watch_scope_change`.
10. Keep validating that any latency fix preserves:
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

- bounded empty-scope hub probing, for example:
  - probe quickly for a small number of empty renews after first client attach
  - then relax back toward a slower cadence such as `30s` if no peers ever appear
  - this would preserve faster peer discovery without keeping quiet single-client shards on a permanent short renew loop
- hub-driven peer-appearance notifications, so empty-scope watchers can react to membership changes without depending only on repeated watch polling
- hybrid discovery, where short adaptive probing covers the first few seconds and a hub event path covers later peer arrivals more efficiently
- best-effort stale remote payload suppression via per-source version watermarks
- if version tracing confirms snapshot coalescing is the main issue, revisit whether cursor-state should expose a slightly richer freshness signal than a bare latest snapshot
- further reduction of steady-state `subAck` churn
- broader higher-concurrency cursor validation after the latency issue is understood
