import { describe, expect, it } from "vitest";

import { ConnectionShardCursorPullIngressGate } from "../src/connectionShardCursorPullIngressGate";
import type { CursorPullWakeReason } from "../src/connectionShardCursorPullScheduler";

describe("ConnectionShardCursorPullIngressGate", () => {
  it("flushes only the highest-priority deferred wake after ingress exits", async () => {
    const deferredTasks: Array<() => Promise<void>> = [];
    const flushed: CursorPullWakeReason[] = [];
    const gate = new ConnectionShardCursorPullIngressGate({
      deferDetachedTask: (task) => {
        deferredTasks.push(task);
      },
      onFlush: (wakeReason) => {
        flushed.push(wakeReason);
      },
    });

    gate.defer("timer");
    gate.defer("schedule_refresh");
    gate.defer("watch_scope_change");
    gate.defer("local_activity");
    gate.flushAfterIngressExited();

    expect(deferredTasks).toHaveLength(1);
    expect(flushed).toEqual([]);

    await deferredTasks[0]!();
    expect(flushed).toEqual(["local_activity"]);
  });

  it("upgrades a queued flush when a higher-priority wake arrives before detach runs", async () => {
    const deferredTasks: Array<() => Promise<void>> = [];
    const flushed: CursorPullWakeReason[] = [];
    const gate = new ConnectionShardCursorPullIngressGate({
      deferDetachedTask: (task) => {
        deferredTasks.push(task);
      },
      onFlush: (wakeReason) => {
        flushed.push(wakeReason);
      },
    });

    gate.defer("timer");
    gate.flushAfterIngressExited();
    gate.defer("local_activity");

    expect(deferredTasks).toHaveLength(1);
    await deferredTasks[0]!();
    expect(flushed).toEqual(["local_activity"]);
  });

  it("clears pending deferred wakes on reset", async () => {
    const deferredTasks: Array<() => Promise<void>> = [];
    const flushed: CursorPullWakeReason[] = [];
    const gate = new ConnectionShardCursorPullIngressGate({
      deferDetachedTask: (task) => {
        deferredTasks.push(task);
      },
      onFlush: (wakeReason) => {
        flushed.push(wakeReason);
      },
    });

    gate.defer("watch_scope_change");
    gate.reset();
    gate.flushAfterIngressExited();

    expect(deferredTasks).toHaveLength(0);
    expect(flushed).toEqual([]);
  });
});
