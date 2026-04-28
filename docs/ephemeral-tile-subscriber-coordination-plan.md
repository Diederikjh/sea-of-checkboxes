# Ephemeral Tile Subscriber Coordination Plan

## Context

Cloudflare logs on 2026-04-28 showed `TileOwnerDO` resets caused by Durable Object storage timeouts on `POST /watch`.
That path stores tile subscriber shard membership before returning the watch response. Subscription rebuilds after long idle sessions can fan out many `/watch` calls, so a slow Durable Object storage operation can block live coordination and reset the object.

Tile snapshots and cell edit metadata are durable application state. Subscriber shard membership is live coordination state and can be reconstructed by active `ConnectionShardDO` instances.

## Goal

Remove Durable Object storage from the `TileOwnerDO` subscriber coordination critical path while preserving tile snapshot durability and client convergence after a `TileOwnerDO` eviction/restart.

## Behavioral Contract

- `TileOwnerDO` keeps `subscriberShards` in memory only.
- `/watch` updates in-memory subscriber membership and returns without writing subscriber state to Durable Object storage.
- `TileOwnerDO` re-instantiation forgets previous subscriber membership.
- Existing active `ConnectionShardDO` instances remain subscribed locally and continue polling `/ops-since` for their visible tiles.
- A visible/focus/pageshow subscription rebuild can reassert `/watch` membership, but correctness must not depend on persisted subscriber state.
- Tile snapshots, versions, and cell last-edit metadata remain durable through the existing snapshot persistence path.

## Expected Effects

- `/watch` no longer fails because a subscriber-state storage write exceeds the Cloudflare Durable Object storage timeout.
- `watcherCount`, `tile_readonly_hot`, and `tile_sub_denied` become based on currently observed in-memory watcher membership and may undercount immediately after a tile owner eviction.
- Active subscribers still converge through shard-local subscriptions and `ops-since` polling.
- Stale subscribers no longer survive object eviction through persisted coordination state.

## Test Plan

- Unit-level `TileOwnerDO` tests:
  - subscriber membership does not persist across re-instantiation
  - legacy stored `subscribers` records are ignored
  - `/watch` succeeds even if storage `put("subscribers")` would fail
  - injected persistence adapters are not asked to save subscriber state

- Swarm-style worker test:
  - simulate an active client subscribed through `ConnectionShardDO`
  - reset/evict the tile owner stub's in-memory watcher state
  - inject a tile edit after the reset
  - confirm the shard still polls `/ops-since` and fans the update out to the subscribed client

## Rollout Notes

After landing, use worker logs to watch for:

- fewer `TileOwnerDO POST /watch` exceptions
- no increase in client-visible `not_subscribed` errors after focus or reconnect
- continued successful `setCell` and `ops-since` activity after idle wake
