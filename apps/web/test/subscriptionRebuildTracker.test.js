import { describe, expect, it, vi } from "vitest";

import { createSubscriptionRebuildTracker } from "../src/subscriptionRebuildTracker";

function createHarness() {
  const logEvent = vi.fn();
  const scheduleReplay = vi.fn();
  let currentMs = 1_000;

  const tracker = createSubscriptionRebuildTracker({
    nowMs: () => currentMs,
    logEvent,
    scheduleReplay,
  });

  return {
    tracker,
    logEvent,
    scheduleReplay,
    advanceTime(ms) {
      currentMs += ms;
    },
  };
}

describe("subscription rebuild tracker", () => {
  it("logs completion and schedules pending replay after matching ack", () => {
    const { tracker, logEvent, scheduleReplay, advanceTime } = createHarness();

    tracker.begin("transport_reconnect");
    tracker.markReplayPending();
    tracker.onDispatch({ cid: "c_sub_1", tiles: ["0:0", "0:1"] }, "transport_reconnect");

    advanceTime(250);
    tracker.onAck({
      cid: "c_sub_1",
      requestedCount: 2,
      changedCount: 2,
      subscribedCount: 2,
    });

    expect(logEvent).toHaveBeenCalledWith("ws subscription_rebuild_dispatched", {
      reason: "transport_reconnect",
      cid: "c_sub_1",
      tileCount: 2,
    });
    expect(logEvent).toHaveBeenCalledWith("ws subscription_rebuild_complete", {
      reason: "transport_reconnect",
      source: "sub_ack",
      durationMs: 250,
      cid: "c_sub_1",
      tileCount: 2,
      ackRequestedCount: 2,
      ackChangedCount: 2,
      ackSubscribedCount: 2,
    });
    expect(scheduleReplay).toHaveBeenCalledWith(0);
    expect(tracker.getSetCellGuard()).toBeNull();
  });

  it("keeps rebuild active and logs ignored ack when cid does not match", () => {
    const { tracker, logEvent, scheduleReplay } = createHarness();

    tracker.begin("focus");
    tracker.onDispatch({ cid: "c_sub_expected", tiles: ["0:0"] }, "focus");
    tracker.onAck({
      cid: "c_sub_other",
      requestedCount: 1,
      changedCount: 0,
      subscribedCount: 1,
    });

    expect(logEvent).toHaveBeenCalledWith("ws subscription_rebuild_ack_ignored", {
      reason: "focus",
      expectedCid: "c_sub_expected",
      cid: "c_sub_other",
    });
    expect(scheduleReplay).not.toHaveBeenCalled();
    expect(tracker.getSetCellGuard()).toEqual({
      reason: "subscription_rebuild",
      message: "Waiting for tile subscriptions to resync...",
      trigger: "focus",
      cid: "c_sub_expected",
    });
  });

  it("completes as noop when rebuild is skipped", () => {
    const { tracker, logEvent } = createHarness();

    tracker.begin("visibilitychange");
    tracker.onSkipped("visibilitychange", {
      visibleTileCount: 3,
    });

    expect(logEvent).toHaveBeenCalledWith("ws subscription_rebuild_complete", {
      reason: "visibilitychange",
      source: "noop",
      durationMs: 0,
      visibleTileCount: 3,
    });
    expect(tracker.getSetCellGuard()).toBeNull();
  });

  it("reports whether a rebuild is currently active", () => {
    const { tracker } = createHarness();

    expect(tracker.isActive()).toBe(false);
    tracker.begin("focus");
    expect(tracker.isActive()).toBe(true);
    tracker.onSkipped("focus");
    expect(tracker.isActive()).toBe(false);
  });
});
