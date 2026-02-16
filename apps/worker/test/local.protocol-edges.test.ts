import { MAX_TILE_ABS, SETCELL_BURST_PER_SEC, TILE_CELL_COUNT } from "@sea/domain";
import { describe, expect, it } from "vitest";

import { ConnectionShard } from "../src/local/connectionShard";
import { LocalRealtimeRuntime } from "../src/local/runtime";
import type { ClientSink } from "../src/local/types";

describe("local protocol edge handling", () => {
  it("returns bad_message for invalid payload", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");
    const events: Array<{ t: string; code?: string }> = [];

    shard.connectClient("u_a", "Alice", (message) => {
      events.push(message as { t: string; code?: string });
    });

    shard.receiveFromClient("u_a", { not: "a_valid_message" });

    expect(events.some((event) => event.t === "err" && event.code === "bad_message")).toBe(true);
  });

  it("returns bad_tile for invalid tile keys in sub/setCell/resync", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");
    const events: Array<{ t: string; code?: string }> = [];
    const outOfBoundsTile = `${MAX_TILE_ABS + 1}:0`;

    shard.connectClient("u_a", "Alice", (message) => {
      events.push(message as { t: string; code?: string });
    });

    shard.receiveFromClient("u_a", { t: "sub", tiles: [outOfBoundsTile] });
    shard.receiveFromClient("u_a", { t: "setCell", tile: outOfBoundsTile, i: 1, v: 1, op: "op_1" });
    shard.receiveFromClient("u_a", { t: "resyncTile", tile: outOfBoundsTile, haveVer: 0 });

    const badTileErrors = events.filter((event) => event.t === "err" && event.code === "bad_tile");
    expect(badTileErrors.length).toBe(3);
  });

  it("relays cursor updates to other clients only", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");

    const seenA: Array<{ t: string; uid?: string }> = [];
    const seenB: Array<{ t: string; uid?: string }> = [];

    shard.connectClient("u_a", "Alice", (message) => {
      seenA.push(message as { t: string; uid?: string });
    });
    shard.connectClient("u_b", "Bob", (message) => {
      seenB.push(message as { t: string; uid?: string });
    });

    shard.receiveFromClient("u_a", { t: "cur", x: 12.5, y: -7.25 });

    expect(seenA.some((event) => event.t === "curUp")).toBe(false);
    expect(seenB.some((event) => event.t === "curUp" && event.uid === "u_a")).toBe(true);
  });

  it("enforces setCell burst rate limiting", () => {
    let nowMs = 1_000;
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a", {
      nowMs: () => nowMs,
    });

    const events: Array<{ t: string; code?: string }> = [];
    shard.connectClient("u_a", "Alice", (message) => {
      events.push(message as { t: string; code?: string });
    });

    shard.receiveFromClient("u_a", { t: "sub", tiles: ["0:0"] });

    for (let index = 0; index < SETCELL_BURST_PER_SEC + 2; index += 1) {
      shard.receiveFromClient("u_a", {
        t: "setCell",
        tile: "0:0",
        i: index % TILE_CELL_COUNT,
        v: index % 2 === 0 ? 1 : 0,
        op: `op_${index}`,
      });
      nowMs += 10;
    }

    expect(events.some((event) => event.t === "err" && event.code === "setcell_limit")).toBe(true);
  });

  it("keeps version unchanged when setting same value", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");
    const events: Array<{ t: string; tile?: string }> = [];

    const sink: ClientSink = (message) => {
      events.push(message as { t: string; tile?: string });
    };

    shard.connectClient("u_a", "Alice", sink);
    shard.receiveFromClient("u_a", { t: "sub", tiles: ["0:0"] });

    shard.receiveFromClient("u_a", {
      t: "setCell",
      tile: "0:0",
      i: 5,
      v: 1,
      op: "op_1",
    });
    shard.receiveFromClient("u_a", {
      t: "setCell",
      tile: "0:0",
      i: 5,
      v: 1,
      op: "op_2",
    });

    const owner = runtime.getTileOwner("0:0");
    const batchCount = events.filter((event) => event.t === "cellUpBatch").length;

    expect(owner.getVersion()).toBe(1);
    expect(batchCount).toBe(1);
  });
});
