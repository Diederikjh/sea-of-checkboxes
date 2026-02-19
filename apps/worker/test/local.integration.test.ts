import { TILE_CELL_COUNT } from "@sea/domain";
import {
  decodeRle64,
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  type ClientMessage,
  type ServerMessage,
} from "@sea/protocol";
import { describe, expect, it } from "vitest";

import { ConnectionShard } from "../src/local/connectionShard";
import { LocalRealtimeRuntime } from "../src/local/runtime";
import type { ClientSink } from "../src/local/types";

function collectMessages() {
  const messages: ServerMessage[] = [];
  const sink: ClientSink = (payload) => {
    messages.push(decodeServerMessageBinary(payload));
  };
  return { messages, sink };
}

function sendClient(
  shard: ConnectionShard,
  uid: string,
  message: ClientMessage
) {
  shard.receiveFromClient(uid, encodeClientMessageBinary(message));
}

describe("local ConnectionShard + TileOwner integration", () => {
  it("fans out updates to multiple shards watching the same tile", () => {
    const runtime = new LocalRealtimeRuntime();
    const shardA = new ConnectionShard(runtime, "shard-a");
    const shardB = new ConnectionShard(runtime, "shard-b");

    const clientA = collectMessages();
    const clientB = collectMessages();

    shardA.connectClient("u_a", "Alice", clientA.sink);
    shardB.connectClient("u_b", "Bob", clientB.sink);

    sendClient(shardA, "u_a", { t: "sub", tiles: ["0:0"] });
    sendClient(shardB, "u_b", { t: "sub", tiles: ["0:0"] });

    sendClient(shardA, "u_a", {
      t: "setCell",
      tile: "0:0",
      i: 10,
      v: 1,
      op: "op_1",
    });

    const aHasBatch = clientA.messages.some((message) => message.t === "cellUpBatch");

    const bHasBatch = clientB.messages.some((message) => message.t === "cellUpBatch");

    expect(aHasBatch).toBe(true);
    expect(bHasBatch).toBe(true);
  });

  it("resync recovers from a dropped update and converges", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");

    const uid = "u_client";
    let droppedFirstBatch = false;
    let localVersion = 0;
    let localBits: Uint8Array<ArrayBufferLike> = new Uint8Array(TILE_CELL_COUNT);

    const sink: ClientSink = (payload) => {
      const message = decodeServerMessageBinary(payload);
      if (message.t === "tileSnap") {
        localBits = decodeRle64(message.bits, TILE_CELL_COUNT);
        localVersion = message.ver;
        return;
      }

      if (message.t !== "cellUpBatch") {
        return;
      }

      if (!droppedFirstBatch) {
        droppedFirstBatch = true;
        return;
      }

      if (message.fromVer !== localVersion + 1) {
        sendClient(shard, uid, {
          t: "resyncTile",
          tile: message.tile,
          haveVer: localVersion,
        });
        return;
      }

      for (const [index, value] of message.ops) {
        localBits[index] = value;
      }
      localVersion = message.toVer;
    };

    shard.connectClient(uid, "Client", sink);
    sendClient(shard, uid, { t: "sub", tiles: ["0:0"] });

    sendClient(shard, uid, {
      t: "setCell",
      tile: "0:0",
      i: 1,
      v: 1,
      op: "op_1",
    });
    sendClient(shard, uid, {
      t: "setCell",
      tile: "0:0",
      i: 2,
      v: 1,
      op: "op_2",
    });

    expect(localVersion).toBe(2);
    expect(localBits[1]).toBe(1);
    expect(localBits[2]).toBe(1);
  });

  it("enforces subscription cap and churn limits", () => {
    let nowMs = 1_000;
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a", {
      nowMs: () => nowMs,
    });

    const messages: Array<{ t: string; code?: string }> = [];
    shard.connectClient("u_a", "Alice", (payload) => {
      messages.push(decodeServerMessageBinary(payload) as { t: string; code?: string });
    });

    for (let index = 0; index < 300; index += 1) {
      sendClient(shard, "u_a", { t: "sub", tiles: [`${index}:0`] });
    }

    sendClient(shard, "u_a", { t: "sub", tiles: ["300:0"] });

    for (let index = 0; index < 300; index += 1) {
      sendClient(shard, "u_a", { t: "unsub", tiles: [`${index}:0`] });
      sendClient(shard, "u_a", { t: "sub", tiles: [`${index}:0`] });
    }

    sendClient(shard, "u_a", { t: "sub", tiles: ["999:0"] });

    const subLimitErrors = messages.filter((msg) => msg.t === "err" && msg.code === "sub_limit");
    const churnErrors = messages.filter((msg) => msg.t === "err" && msg.code === "churn_limit");

    expect(subLimitErrors.length).toBeGreaterThan(0);
    expect(churnErrors.length).toBeGreaterThan(0);

    nowMs += 61_000;
    sendClient(shard, "u_a", { t: "sub", tiles: ["1001:0"] });
    const newChurnErrors = messages.filter((msg) => msg.t === "err" && msg.code === "churn_limit");
    expect(newChurnErrors.length).toBe(churnErrors.length);
  });

  it("local receiveTileBatch only reaches subscribed clients", () => {
    const runtime = new LocalRealtimeRuntime();
    const shard = new ConnectionShard(runtime, "shard-a");

    const clientA = collectMessages();
    const clientB = collectMessages();
    shard.connectClient("u_a", "Alice", clientA.sink);
    shard.connectClient("u_b", "Bob", clientB.sink);

    sendClient(shard, "u_a", { t: "sub", tiles: ["0:0"] });

    shard.receiveTileBatch({
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 1,
      toVer: 1,
      ops: [[3, 1]],
    });

    expect(clientA.messages.some((message) => message.t === "cellUpBatch" && message.tile === "0:0")).toBe(true);
    expect(clientB.messages.some((message) => message.t === "cellUpBatch")).toBe(false);
  });
});
