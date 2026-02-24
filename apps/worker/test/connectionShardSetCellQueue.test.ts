import { describe, expect, it } from "vitest";

import { ConnectionShardSetCellQueue } from "../src/connectionShardSetCellQueue";

describe("ConnectionShardSetCellQueue", () => {
  it("processes tasks in order for the same uid", async () => {
    const queue = new ConnectionShardSetCellQueue();
    const events: string[] = [];
    let releaseFirst: () => void = () => {
      throw new Error("releaseFirst not initialized");
    };
    let resolveFirstStarted: () => void = () => {
      throw new Error("resolveFirstStarted not initialized");
    };
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue("u_a", async () => {
      events.push("first_start");
      resolveFirstStarted();
      await firstGate;
      events.push("first_end");
    });
    const second = queue.enqueue("u_a", async () => {
      events.push("second");
    });

    await firstStarted;
    expect(events).toEqual(["first_start"]);
    releaseFirst();

    await Promise.all([first, second]);
    expect(events).toEqual(["first_start", "first_end", "second"]);
  });

  it("continues processing after a prior task fails", async () => {
    const queue = new ConnectionShardSetCellQueue();
    let ranAfterFailure = false;

    await expect(
      queue.enqueue("u_a", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    await queue.enqueue("u_a", async () => {
      ranAfterFailure = true;
    });
    expect(ranAfterFailure).toBe(true);
  });

  it("runs tasks for different uids independently", async () => {
    const queue = new ConnectionShardSetCellQueue();
    const events: string[] = [];
    let releaseA: () => void = () => {
      throw new Error("releaseA not initialized");
    };
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const taskA = queue.enqueue("u_a", async () => {
      events.push("a_start");
      await gateA;
      events.push("a_end");
    });
    const taskB = queue.enqueue("u_b", async () => {
      events.push("b_done");
    });

    await taskB;
    expect(events).toContain("b_done");
    expect(events).not.toContain("a_end");
    releaseA();
    await taskA;
    expect(events).toEqual(["a_start", "b_done", "a_end"]);
  });
});
