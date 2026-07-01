import {
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  type ServerMessage,
} from "@sea/protocol";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { waitFor } from "./helpers/waitFor";
import {
  connectClient,
  countTileOpsSinceRequests,
  createHarness,
  decodeMessages,
  parseStructuredLogs,
  postTileBatch,
  postTileBatchWithHeaders,
  toUint8Array,
} from "./helpers/connectionShardWebsocketHarness";

describe("ConnectionShardDO websocket tile sync", () => {
  it("locally fans out setCell updates when a tile has a single watcher shard", async () => {
    const harness = createHarness();
    const socketA = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });
    const socketB = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_b",
      name: "Bob",
      shard: "shard-a",
    });

    socketA.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socketB.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    socketA.emitMessage(
      encodeClientMessageBinary({
        t: "setCell",
        tile: "0:0",
        i: 42,
        v: 1,
        op: "op_local_fanout",
      })
    );

    await waitFor(() => {
      const messagesB = decodeMessages(socketB);
      expect(
        messagesB.some(
          (message) =>
            message.t === "cellUpBatch" &&
            message.tile === "0:0" &&
            message.fromVer === 1 &&
            message.toVer === 1
        )
      ).toBe(true);
    });
  });

  it("locally fans out setCell updates even when tile owner watcher count is greater than one", async () => {
    const harness = createHarness();
    const socketA = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });
    const socketB = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_b",
      name: "Bob",
      shard: "shard-a",
    });

    socketA.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socketB.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    const remoteWatchResponse = await tileStub.fetch("https://tile-owner.internal/watch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tile: "0:0",
        shard: "shard-remote",
        action: "sub",
      }),
    });
    expect(remoteWatchResponse.status).toBe(204);

    socketA.emitMessage(
      encodeClientMessageBinary({
        t: "setCell",
        tile: "0:0",
        i: 42,
        v: 1,
        op: "op_local_fanout_multi_watcher",
      })
    );

    await waitFor(() => {
      const messagesB = decodeMessages(socketB);
      expect(
        messagesB.some(
          (message) =>
            message.t === "cellUpBatch"
            && message.tile === "0:0"
            && message.fromVer === 1
            && message.toVer === 1
            && message.ops.some((op) => op[0] === 42 && op[1] === 1)
        )
      ).toBe(true);
    });
  });

  it("processes same-client setCell messages in send order under variable latency", async () => {
    const harness = createHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    const originalFetch = tileStub.fetch.bind(tileStub);
    tileStub.fetch = async (input: Request | string, init?: RequestInit): Promise<Response> => {
      const request = typeof input === "string" ? new Request(input, init) : input;
      const url = new URL(request.url);
      if (url.pathname === "/setCell") {
        const body = await request.clone().text();
        if (body.includes('"op":"op_slow"')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      return originalFetch(input, init);
    };

    socket.emitMessage(
      encodeClientMessageBinary({
        t: "setCell",
        tile: "0:0",
        i: 42,
        v: 0,
        op: "op_slow",
      })
    );
    socket.emitMessage(
      encodeClientMessageBinary({
        t: "setCell",
        tile: "0:0",
        i: 42,
        v: 1,
        op: "op_fast",
      })
    );

    await waitFor(() => {
      const ordered = decodeMessages(socket)
        .filter(
          (message): message is Extract<ServerMessage, { t: "cellUpBatch" }> =>
            message.t === "cellUpBatch" && message.tile === "0:0" && message.ops[0]?.[0] === 42
        )
        .slice(-2);

      expect(ordered).toHaveLength(2);
      expect(ordered[0]?.ops[0]).toEqual([42, 0]);
      expect(ordered[1]?.ops[0]).toEqual([42, 1]);
    });
  });

  it("preserves sub before setCell order when payloads are emitted back-to-back", async () => {
    const harness = createHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(
      encodeClientMessageBinary({
        t: "setCell",
        tile: "0:0",
        i: 21,
        v: 1,
        op: "op_sub_then_set",
      })
    );

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
      expect(tileStub.setCellRequests.length).toBe(1);
      expect(tileStub.setCellRequests[0]?.op).toBe("op_sub_then_set");
    });

    const errors = decodeMessages(socket).filter(
      (message): message is Extract<ServerMessage, { t: "err" }> => message.t === "err"
    );
    expect(errors.some((message) => message.code === "not_subscribed")).toBe(false);
  });

  it("fans out tile batches only to subscribers", async () => {
    const harness = createHarness();
    const socketA = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });
    const socketB = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_b",
      name: "Bob",
      shard: "shard-a",
    });

    socketA.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    const batchResponse = await postTileBatch(harness.shard, {
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 1,
      toVer: 1,
      ops: [[15, 1]],
    });

    expect(batchResponse.status).toBe(204);

    const messagesA = decodeMessages(socketA);
    const messagesB = decodeMessages(socketB);

    expect(messagesA.some((message) => message.t === "cellUpBatch" && message.tile === "0:0")).toBe(true);
    expect(messagesB.some((message) => message.t === "cellUpBatch")).toBe(false);
  });

  it("pulls tile deltas from tile owner and fans out to local subscribers", async () => {
    const harness = createHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));
    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    tileStub.injectOp("0:0", 77, 1);

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(
        messages.some(
          (message) =>
            message.t === "cellUpBatch"
            && message.tile === "0:0"
            && message.fromVer === 1
            && message.toVer === 1
            && message.ops.some((op) => op[0] === 77 && op[1] === 1)
        )
      ).toBe(true);
    }, { attempts: 120, delayMs: 10 });
  });

  it("continues swarm-style tile convergence after tile owner coordination state is evicted", async () => {
    const harness = createHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", cid: "c_sub_1", tiles: ["0:0"] }));
    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    tileStub.resetCoordinationState();
    tileStub.injectOp("0:0", 88, 1);

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(
        messages.some(
          (message) =>
            message.t === "cellUpBatch"
            && message.tile === "0:0"
            && message.fromVer === 1
            && message.toVer === 1
            && message.ops.some((op) => op[0] === 88 && op[1] === 1)
        )
      ).toBe(true);
    }, { attempts: 120, delayMs: 10 });
  });

  it("accepts swarm-style setCell after tile owner coordination state is evicted", async () => {
    const harness = createHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", cid: "c_sub_1", tiles: ["0:0"] }));
    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    tileStub.resetCoordinationState();
    socket.emitMessage(encodeClientMessageBinary({
      t: "setCell",
      tile: "0:0",
      i: 99,
      v: 1,
      op: "op_after_coordination_reset",
    }));

    await waitFor(() => {
      expect(tileStub.setCellRequests.some((request) => request.op === "op_after_coordination_reset")).toBe(true);
      const messages = decodeMessages(socket);
      expect(
        messages.some(
          (message) =>
            message.t === "cellUpBatch"
            && message.tile === "0:0"
            && message.ops.some((op) => op[0] === 99 && op[1] === 1)
        )
      ).toBe(true);
    }, { attempts: 120, delayMs: 10 });

    const errors = decodeMessages(socket).filter(
      (message): message is Extract<ServerMessage, { t: "err" }> => message.t === "err"
    );
    expect(errors.some((message) => message.code === "not_subscribed")).toBe(false);
  });

  it("resyncs snapshot when pulled tile deltas have a version gap", async () => {
    const harness = createHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0" && message.ver === 0)).toBe(true);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    tileStub.setOpsHistoryLimit(2);
    tileStub.injectOp("0:0", 9, 1);
    tileStub.injectOp("0:0", 9, 0);
    tileStub.injectOp("0:0", 9, 1);

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0" && message.ver === 3)).toBe(true);
    }, { attempts: 120, delayMs: 10 });
  });

  it("defers re-entrant setCell messages emitted during tile-batch fanout until cooldown", async () => {
    const harness = createHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    const originalSend = socket.send.bind(socket);
    let reflectedSetCell = false;
    socket.send = (payload) => {
      originalSend(payload);
      if (reflectedSetCell || typeof payload === "string") {
        return;
      }

      const message = decodeServerMessageBinary(toUint8Array(payload));
      if (message.t !== "cellUpBatch" || message.tile !== "0:0") {
        return;
      }

      reflectedSetCell = true;
      socket.emitMessage(
        encodeClientMessageBinary({
          t: "setCell",
          tile: "0:0",
          i: 11,
          v: 1,
          op: "op_reentrant",
        })
      );
    };

    const response = await postTileBatch(harness.shard, {
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 1,
      toVer: 1,
      ops: [[10, 1]],
    });
    expect(response.status).toBe(204);

    const tileStub = harness.tileOwners.getByName("0:0");
    expect(tileStub.setCellRequests.length).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(tileStub.setCellRequests.length).toBe(0);

    await waitFor(() => {
      expect(
        tileStub.setCellRequests.some(
          (request) =>
            request.op === "op_reentrant" &&
            request.tile === "0:0" &&
            request.i === 11 &&
            request.v === 1
        )
      ).toBe(true);
    });
  });

  it("logs non-monotonic tile-batch version ordering anomalies", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-a",
      });
      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      await waitFor(() => {
        const messages = decodeMessages(socket);
        expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
      });

      const sendBatch = (fromVer: number, toVer: number, ops: Array<[number, 0 | 1]>) =>
        postTileBatch(harness.shard, {
          t: "cellUpBatch",
          tile: "0:0",
          fromVer,
          toVer,
          ops,
        });

      expect((await sendBatch(920, 920, [[1562, 1]])).status).toBe(204);
      expect((await sendBatch(921, 921, [[1626, 1]])).status).toBe(204);
      expect((await sendBatch(920, 920, [[1498, 1]])).status).toBe(204);

      const events = parseStructuredLogs(logSpy);
      const anomaly = events.find(
        (event) =>
          event.scope === "connection_shard_do" && event.event === "tile_batch_order_anomaly"
      );

      expect(anomaly).toMatchObject({
        tile: "0:0",
        kind: "version_regression",
        prev_to_ver: 921,
        incoming_to_ver: 920,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("drops tile-batch requests with recursive trace hop > 1", async () => {
    const harness = createHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

      await waitFor(() => {
        const messages = decodeMessages(socket);
        expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
      });

      const beforeMessages = decodeMessages(socket).length;
      const response = await postTileBatchWithHeaders(
        harness.shard,
        {
          t: "cellUpBatch",
          tile: "0:0",
          fromVer: 11,
          toVer: 11,
          ops: [[0, 1]],
        },
        {
          "x-sea-trace-id": "trace-recursive",
          "x-sea-trace-hop": "2",
          "x-sea-trace-origin": "tile-owner:0:0",
        }
      );
      expect(response.status).toBe(204);

      const afterMessages = decodeMessages(socket).length;
      expect(afterMessages).toBe(beforeMessages);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "tile_batch_loop_guard_drop"
            && event.trace_id === "trace-recursive"
            && event.trace_hop === 2
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("returns gone for tile-batch requests when shard has no local subscribers", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await postTileBatchWithHeaders(
        harness.shard,
        {
          t: "cellUpBatch",
          tile: "0:0",
          fromVer: 12,
          toVer: 12,
          ops: [[1, 1]],
        },
        {
          "x-sea-trace-id": "trace-no-subs",
          "x-sea-trace-hop": "1",
          "x-sea-trace-origin": "tile-owner:0:0",
        }
      );

      expect(response.status).toBe(410);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "tile_batch_no_local_subscribers"
            && event.tile === "0:0"
            && event.trace_id === "trace-no-subs"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("polls tile ops-since at ~1s cadence when idle", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-a",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(0);
      const baseline = countTileOpsSinceRequests(harness);
      expect(baseline).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(900);
      expect(countTileOpsSinceRequests(harness)).toBe(baseline);

      await vi.advanceTimersByTimeAsync(100);
      expect(countTileOpsSinceRequests(harness)).toBe(baseline + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accelerates tile ops-since polling to 200ms on deltas and backs off when quiet", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-a",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(0);
      const initial = countTileOpsSinceRequests(harness);
      expect(initial).toBeGreaterThan(0);

      const tileStub = harness.tileOwners.getByName("0:0");
      tileStub.injectOp("0:0", 7, 1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(countTileOpsSinceRequests(harness)).toBe(initial + 1);

      await vi.advanceTimersByTimeAsync(199);
      expect(countTileOpsSinceRequests(harness)).toBe(initial + 1);

      await vi.advanceTimersByTimeAsync(1);
      expect(countTileOpsSinceRequests(harness)).toBe(initial + 2);

      await vi.advanceTimersByTimeAsync(399);
      expect(countTileOpsSinceRequests(harness)).toBe(initial + 2);

      await vi.advanceTimersByTimeAsync(1);
      expect(countTileOpsSinceRequests(harness)).toBe(initial + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off tile ops-since polling beyond 1s after sustained idle", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-a",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(0);
      const initial = countTileOpsSinceRequests(harness);
      expect(initial).toBeGreaterThan(0);

      // Let the shard observe multiple quiet polls so idle backoff engages.
      await vi.advanceTimersByTimeAsync(7_000);
      const afterQuiet = countTileOpsSinceRequests(harness);
      expect(afterQuiet).toBeGreaterThan(initial);

      await vi.advanceTimersByTimeAsync(1_500);
      expect(countTileOpsSinceRequests(harness)).toBe(afterQuiet);

      await vi.advanceTimersByTimeAsync(500);
      expect(countTileOpsSinceRequests(harness)).toBe(afterQuiet + 1);
    } finally {
      vi.useRealTimers();
    }
  });

});
