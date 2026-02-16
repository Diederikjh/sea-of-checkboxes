import {
  MAX_TILE_ABS,
  SETCELL_BURST_PER_SEC,
  SETCELL_SUSTAINED_PER_SEC,
  SETCELL_SUSTAINED_WINDOW_MS,
  TILE_CELL_COUNT,
} from "@sea/domain";
import {
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  type ClientMessage,
} from "@sea/protocol";
import { describe, expect, it } from "vitest";

import { ConnectionShard } from "../src/local/connectionShard";
import { LocalRealtimeRuntime } from "../src/local/runtime";
import type { ClientSink } from "../src/local/types";

function sendClient(
  shard: ConnectionShard,
  uid: string,
  message: ClientMessage
) {
  shard.receiveFromClient(uid, encodeClientMessageBinary(message));
}

describe("local protocol edge handling", () => {
  it("returns bad_message for invalid payload", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");
    const events: Array<{ t: string; code?: string }> = [];

    shard.connectClient("u_a", "Alice", (payload) => {
      events.push(decodeServerMessageBinary(payload) as { t: string; code?: string });
    });

    shard.receiveFromClient("u_a", Uint8Array.from([255]));

    expect(events.some((event) => event.t === "err" && event.code === "bad_message")).toBe(true);
  });

  it("returns bad_tile for invalid tile keys in sub/setCell/resync", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");
    const events: Array<{ t: string; code?: string }> = [];
    const outOfBoundsTile = `${MAX_TILE_ABS + 1}:0`;

    shard.connectClient("u_a", "Alice", (payload) => {
      events.push(decodeServerMessageBinary(payload) as { t: string; code?: string });
    });

    shard.receiveFromClientJson("u_a", { t: "sub", tiles: [outOfBoundsTile] });
    shard.receiveFromClientJson("u_a", { t: "setCell", tile: outOfBoundsTile, i: 1, v: 1, op: "op_1" });
    shard.receiveFromClientJson("u_a", { t: "resyncTile", tile: outOfBoundsTile, haveVer: 0 });

    const badTileErrors = events.filter((event) => event.t === "err" && event.code === "bad_tile");
    expect(badTileErrors.length).toBe(3);
  });

  it("relays cursor updates to other clients only", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");

    const seenA: Array<{ t: string; uid?: string }> = [];
    const seenB: Array<{ t: string; uid?: string }> = [];

    shard.connectClient("u_a", "Alice", (payload) => {
      seenA.push(decodeServerMessageBinary(payload) as { t: string; uid?: string });
    });
    shard.connectClient("u_b", "Bob", (payload) => {
      seenB.push(decodeServerMessageBinary(payload) as { t: string; uid?: string });
    });

    sendClient(shard, "u_a", { t: "cur", x: 12.5, y: -7.25 });

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
    shard.connectClient("u_a", "Alice", (payload) => {
      events.push(decodeServerMessageBinary(payload) as { t: string; code?: string });
    });

    sendClient(shard, "u_a", { t: "sub", tiles: ["0:0"] });

    for (let index = 0; index < SETCELL_BURST_PER_SEC + 2; index += 1) {
      sendClient(shard, "u_a", {
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

  it("enforces sustained setCell rate limiting", () => {
    let nowMs = 1_000;
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a", {
      nowMs: () => nowMs,
    });

    const events: Array<{ t: string; code?: string }> = [];
    shard.connectClient("u_a", "Alice", (payload) => {
      events.push(decodeServerMessageBinary(payload) as { t: string; code?: string });
    });

    sendClient(shard, "u_a", { t: "sub", tiles: ["0:0"] });

    const sustainedLimit = Math.floor((SETCELL_SUSTAINED_PER_SEC * SETCELL_SUSTAINED_WINDOW_MS) / 1_000);
    for (let index = 0; index < sustainedLimit + 2; index += 1) {
      sendClient(shard, "u_a", {
        t: "setCell",
        tile: "0:0",
        i: index % TILE_CELL_COUNT,
        v: index % 2 === 0 ? 1 : 0,
        op: `op_${index}`,
      });
      nowMs += 150;
    }

    expect(events.some((event) => event.t === "err" && event.code === "setcell_limit")).toBe(true);
  });

  it("treats duplicate sub/unsub as idempotent", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");
    const events: Array<{ t: string; code?: string }> = [];

    shard.connectClient("u_a", "Alice", (payload) => {
      events.push(decodeServerMessageBinary(payload) as { t: string; code?: string });
    });

    sendClient(shard, "u_a", { t: "sub", tiles: ["0:0"] });
    sendClient(shard, "u_a", { t: "sub", tiles: ["0:0"] });
    sendClient(shard, "u_a", { t: "unsub", tiles: ["0:0"] });
    sendClient(shard, "u_a", { t: "unsub", tiles: ["0:0"] });

    const snapshots = events.filter((event) => event.t === "tileSnap");
    const errors = events.filter((event) => event.t === "err");

    expect(snapshots.length).toBe(1);
    expect(errors.length).toBe(0);
  });

  it("disconnect cleanup removes client from fanout", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");

    const seenA: Array<{ t: string }> = [];
    const seenB: Array<{ t: string }> = [];

    const sinkA: ClientSink = (payload) => {
      seenA.push(decodeServerMessageBinary(payload) as { t: string });
    };
    const sinkB: ClientSink = (payload) => {
      seenB.push(decodeServerMessageBinary(payload) as { t: string });
    };

    shard.connectClient("u_a", "Alice", sinkA);
    shard.connectClient("u_b", "Bob", sinkB);

    sendClient(shard, "u_a", { t: "sub", tiles: ["0:0"] });
    sendClient(shard, "u_b", { t: "sub", tiles: ["0:0"] });
    shard.disconnectClient("u_a");

    sendClient(shard, "u_b", {
      t: "setCell",
      tile: "0:0",
      i: 5,
      v: 1,
      op: "op_1",
    });

    expect(seenA.some((event) => event.t === "cellUpBatch")).toBe(false);
    expect(seenB.some((event) => event.t === "cellUpBatch")).toBe(true);
  });

  it("keeps version unchanged when setting same value", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");
    const events: Array<{ t: string; tile?: string }> = [];

    const sink: ClientSink = (payload) => {
      events.push(decodeServerMessageBinary(payload) as { t: string; tile?: string });
    };

    shard.connectClient("u_a", "Alice", sink);
    sendClient(shard, "u_a", { t: "sub", tiles: ["0:0"] });

    sendClient(shard, "u_a", {
      t: "setCell",
      tile: "0:0",
      i: 5,
      v: 1,
      op: "op_1",
    });
    sendClient(shard, "u_a", {
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
