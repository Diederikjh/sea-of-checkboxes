import { describe, expect, it, vi } from "vitest";

import {
  ConnectionShardCursorPullScheduler,
  type CursorPullWakeReason,
} from "../src/connectionShardCursorPullScheduler";

describe("ConnectionShardCursorPullScheduler", () => {
  it("upgrades a scheduled timer wake to local_activity without changing the earlier deadline", async () => {
    vi.useFakeTimers();
    try {
      const wakes: CursorPullWakeReason[] = [];
      const scheduler = new ConnectionShardCursorPullScheduler({
        nowMs: () => Date.now(),
        maybeUnrefTimer: () => {},
        onTick: (wakeReason) => {
          wakes.push(wakeReason);
          scheduler.markRunStarted();
          scheduler.markRunCompleted();
        },
        minIntervalMs: 75,
        jitterMs: 0,
      });

      scheduler.schedule(100, "timer");
      scheduler.schedule(100, "local_activity");

      await vi.advanceTimersByTimeAsync(99);
      expect(wakes).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(wakes).toEqual(["local_activity"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reschedules to an earlier higher-priority wake when the new request is sooner", async () => {
    vi.useFakeTimers();
    try {
      const wakes: CursorPullWakeReason[] = [];
      const scheduler = new ConnectionShardCursorPullScheduler({
        nowMs: () => Date.now(),
        maybeUnrefTimer: () => {},
        onTick: (wakeReason) => {
          wakes.push(wakeReason);
          scheduler.markRunStarted();
          scheduler.markRunCompleted();
        },
        minIntervalMs: 75,
        jitterMs: 0,
      });

      scheduler.schedule(100, "timer");
      scheduler.schedule(25, "watch_scope_change");

      await vi.advanceTimersByTimeAsync(24);
      expect(wakes).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(wakes).toEqual(["watch_scope_change"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the minimum interval floor for local_activity after a completed run", async () => {
    vi.useFakeTimers();
    try {
      const wakes: CursorPullWakeReason[] = [];
      const scheduler = new ConnectionShardCursorPullScheduler({
        nowMs: () => Date.now(),
        maybeUnrefTimer: () => {},
        onTick: (wakeReason) => {
          wakes.push(wakeReason);
          scheduler.markRunStarted();
          scheduler.markRunCompleted();
        },
        minIntervalMs: 75,
        jitterMs: 0,
      });

      scheduler.schedule(0, "timer");
      await vi.advanceTimersByTimeAsync(0);
      expect(wakes).toEqual(["timer"]);

      scheduler.schedule(0, "local_activity");

      await vi.advanceTimersByTimeAsync(74);
      expect(wakes).toEqual(["timer"]);

      await vi.advanceTimersByTimeAsync(1);
      expect(wakes).toEqual(["timer", "local_activity"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies jitter only to timer wakes", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);
    try {
      const wakes: CursorPullWakeReason[] = [];
      const scheduler = new ConnectionShardCursorPullScheduler({
        nowMs: () => Date.now(),
        maybeUnrefTimer: () => {},
        onTick: (wakeReason) => {
          wakes.push(wakeReason);
          scheduler.markRunStarted();
          scheduler.markRunCompleted();
        },
        minIntervalMs: 75,
        jitterMs: 25,
      });

      scheduler.schedule(100, "timer");
      await vi.advanceTimersByTimeAsync(124);
      expect(wakes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(wakes).toEqual(["timer"]);

      scheduler.schedule(100, "watch_scope_change");
      await vi.advanceTimersByTimeAsync(99);
      expect(wakes).toEqual(["timer"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(wakes).toEqual(["timer", "watch_scope_change"]);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
