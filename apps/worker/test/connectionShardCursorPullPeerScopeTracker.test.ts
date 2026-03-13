import { describe, expect, it } from "vitest";

import { ConnectionShardCursorPullPeerScopeTracker } from "../src/connectionShardCursorPullPeerScopeTracker";

describe("ConnectionShardCursorPullPeerScopeTracker", () => {
  it("records initial scope age and reports unchanged scope age", () => {
    const tracker = new ConnectionShardCursorPullPeerScopeTracker();

    const initialChange = tracker.replacePeerShards(["shard-1", "shard-2"], 1_000);
    const unchangedChange = tracker.replacePeerShards(["shard-1", "shard-2"], 1_250);

    expect(initialChange).toMatchObject({
      changed: true,
      previousPeerShards: [],
      nextPeerShards: ["shard-1", "shard-2"],
    });
    expect(unchangedChange).toMatchObject({
      changed: false,
      previousPeerShards: ["shard-1", "shard-2"],
      nextPeerShards: ["shard-1", "shard-2"],
      oldestScopeAgeMs: 250,
    });
    expect(tracker.scopeFields("shard-1", 1_400)).toEqual({
      scope_observed_at_ms: 1_000,
      scope_age_ms: 400,
    });
  });

  it("prunes removed peers and starts a new epoch when a peer is re-added", () => {
    const tracker = new ConnectionShardCursorPullPeerScopeTracker();

    tracker.replacePeerShards(["shard-1", "shard-2"], 1_000);
    tracker.replacePeerShards(["shard-2"], 1_100);
    const readdedChange = tracker.replacePeerShards(["shard-1", "shard-2"], 1_300);

    expect(tracker.scopeFields("shard-1", 1_350)).toEqual({
      scope_observed_at_ms: 1_300,
      scope_age_ms: 50,
    });
    expect(tracker.scopeFields("shard-2", 1_350)).toEqual({
      scope_observed_at_ms: 1_000,
      scope_age_ms: 350,
    });
    expect(readdedChange).toMatchObject({
      changed: true,
      previousPeerShards: ["shard-2"],
      nextPeerShards: ["shard-1", "shard-2"],
    });
  });

  it("only marks first visibility once per scope epoch", () => {
    const tracker = new ConnectionShardCursorPullPeerScopeTracker();

    tracker.replacePeerShards(["shard-1"], 1_000);

    expect(tracker.markFirstVisibility("shard-1", 0, false)).toBe(false);
    expect(tracker.markFirstVisibility("shard-1", 2, false)).toBe(false);
    expect(tracker.markFirstVisibility("shard-1", 2, true)).toBe(true);
    expect(tracker.markFirstVisibility("shard-1", 3, true)).toBe(false);

    tracker.replacePeerShards(["shard-1", "shard-2"], 1_200);
    expect(tracker.markFirstVisibility("shard-1", 1, true)).toBe(false);
    expect(tracker.markFirstVisibility("shard-2", 1, true)).toBe(true);

    tracker.replacePeerShards([], 1_300);
    tracker.replacePeerShards(["shard-1"], 1_400);
    expect(tracker.markFirstVisibility("shard-1", 1, true)).toBe(true);
  });

  it("logs distinct pre-visibility outcomes once per scope epoch", () => {
    const tracker = new ConnectionShardCursorPullPeerScopeTracker();

    tracker.replacePeerShards(["shard-1"], 1_000);

    expect(tracker.markPreVisibilityOutcome("shard-1", "empty_snapshot")).toBe(true);
    expect(tracker.markPreVisibilityOutcome("shard-1", "empty_snapshot")).toBe(false);
    expect(tracker.markPreVisibilityOutcome("shard-1", "nonempty_without_delta")).toBe(true);
    expect(tracker.markFirstVisibility("shard-1", 1, true)).toBe(true);
    expect(tracker.markPreVisibilityOutcome("shard-1", "empty_snapshot")).toBe(false);

    tracker.replacePeerShards([], 1_100);
    tracker.replacePeerShards(["shard-1"], 1_200);
    expect(tracker.markPreVisibilityOutcome("shard-1", "empty_snapshot")).toBe(true);
  });

  it("resets all state cleanly", () => {
    const tracker = new ConnectionShardCursorPullPeerScopeTracker();

    tracker.replacePeerShards(["shard-1"], 1_000);
    tracker.markFirstVisibility("shard-1", 1, true);
    tracker.reset();

    expect(tracker.peerShards).toEqual([]);
    expect(tracker.scopeFields("shard-1", 1_100)).toEqual({});
    expect(tracker.oldestScopeAgeMs(["shard-1"], 1_100)).toBeUndefined();
    expect(tracker.markFirstVisibility("shard-1", 1, true)).toBe(false);
    expect(tracker.markPreVisibilityOutcome("shard-1", "empty_snapshot")).toBe(false);
  });
});
