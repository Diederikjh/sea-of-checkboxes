import {
  MAX_REMOTE_CURSORS,
} from "@sea/domain";
import {
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  type ServerMessage,
} from "@sea/protocol";
import { describe, expect, it, vi } from "vitest";

import { ConnectionShardCursorPullOrchestrator } from "../src/connectionShardCursorPullOrchestrator";
import { ConnectionShardCursorPullScheduler } from "../src/connectionShardCursorPullScheduler";
import { waitFor } from "./helpers/waitFor";
import {
  connectClient,
  countCursorHubPublishes,
  countCursorRelaySubrequests,
  countCursorStatePullRequests,
  countCursorStatePullRequestsForShard,
  countTileOpsSinceRequests,
  createHarness,
  createRelayHarness,
  decodeMessages,
  drainDeferred,
  getCursorState,
  getCursorStateWithHeaders,
  parseStructuredLogs,
  postCursorBatch,
  postCursorBatchWithHeaders,
  postTileBatch,
  postTileBatchWithHeaders,
  setCursorHubWatchResponse,
  toUint8Array,
} from "./helpers/connectionShardWebsocketHarness";

describe("ConnectionShardDO websocket handling", () => {
  it("sends hello on connect via injected socket pair", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    const messages = decodeMessages(serverSocket);
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      t: "hello",
      uid: "u_a",
      name: "Alice",
      token: "test-token",
    });
    expect(harness.upgradeResponseFactory.clientSockets.length).toBe(1);
  });

  it("includes spawn in hello when cursor hub returns a spawn sample", async () => {
    const harness = createHarness();
    const hub = harness.cursorHub.getByName("global");
    hub.setJsonPathResponse("/spawn-sample", {
      x: 320.5,
      y: -160.5,
      source: "edit",
    });

    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_spawn",
      name: "Spawned",
      shard: "shard-a",
    });

    const messages = decodeMessages(serverSocket);
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      t: "hello",
      uid: "u_spawn",
      name: "Spawned",
      token: "test-token",
      spawn: {
        x: 320.5,
        y: -160.5,
      },
    });
  });

  it("subscribes tiles, registers watch, and returns snapshots", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    serverSocket.emitMessage(encodeClientMessageBinary({ t: "sub", cid: "c_sub_1", tiles: ["0:0"] }));

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    expect(tileStub.watchRequests[0]).toEqual({
      tile: "0:0",
      shard: "shard-a",
      action: "sub",
    });

    const messages = decodeMessages(serverSocket);
    expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    expect(messages).toContainEqual({
      t: "subAck",
      cid: "c_sub_1",
      requestedCount: 1,
      changedCount: 1,
      subscribedCount: 1,
    });
  });

  it("does not send subAck for legacy subscribe messages without a cid", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_legacy",
      name: "Legacy",
      shard: "shard-a",
    });

    serverSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    const messages = decodeMessages(serverSocket);
    expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    expect(messages.some((message) => message.t === "subAck")).toBe(false);
  });

  it("rejects setCell for unsubscribed tiles and sends snapshot", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    serverSocket.emitMessage(
      encodeClientMessageBinary({
        t: "setCell",
        tile: "0:0",
        i: 22,
        v: 1,
        op: "op_1",
      })
    );

    await waitFor(() => {
      const messages = decodeMessages(serverSocket);
      expect(messages.some((message) => message.t === "err" && message.code === "not_subscribed")).toBe(true);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    expect(tileStub.setCellRequests.length).toBe(0);
  });

  it("rejects setCell with app_readonly when read-only mode is enabled", async () => {
    const harness = createHarness({
      envOverrides: {
        READONLY_MODE: "1",
      },
    });
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    serverSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    serverSocket.emitMessage(
      encodeClientMessageBinary({
        t: "setCell",
        tile: "0:0",
        i: 22,
        v: 1,
        op: "op_readonly",
      })
    );

    await waitFor(() => {
      const messages = decodeMessages(serverSocket);
      expect(messages.some((message) => message.t === "err" && message.code === "app_readonly")).toBe(true);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    expect(tileStub.setCellRequests.length).toBe(0);
  });

  it("publishes accepted edit activity to cursor hub for spawn sampling", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    serverSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    serverSocket.emitMessage(
      encodeClientMessageBinary({
        t: "setCell",
        tile: "0:0",
        i: 65,
        v: 1,
        op: "op_spawn_activity",
      })
    );

    await waitFor(() => {
      const hub = harness.cursorHub.getByName("global");
      expect(
        hub.requests.some(
          (entry) =>
            entry.request.method.toUpperCase() === "POST"
            && new URL(entry.request.url).pathname === "/activity"
        )
      ).toBe(true);
    });

    const hub = harness.cursorHub.getByName("global");
    const activityRequest = hub.requests.find((entry) => new URL(entry.request.url).pathname === "/activity");
    expect(activityRequest).toBeDefined();
    expect(activityRequest?.request.method.toUpperCase()).toBe("POST");
    const body = activityRequest?.body ? (JSON.parse(activityRequest.body) as Record<string, unknown>) : {};
    expect(body).toMatchObject({
      from: "shard-a",
      x: 1.5,
      y: 1.5,
    });
    expect(typeof body.atMs).toBe("number");
  });

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

  it("replaces an existing uid connection without letting stale socket events evict the new client", async () => {
    const harness = createHarness();
    const firstSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_same",
      name: "Alice",
      shard: "shard-a",
    });
    const secondSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_same",
      name: "Alice",
      shard: "shard-a",
    });

    firstSocket.emitClose();
    secondSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    const secondMessages = decodeMessages(secondSocket);
    expect(secondMessages.some((message) => message.t === "hello" && message.uid === "u_same")).toBe(true);
  });

  it("logs setcell_not_subscribed diagnostics when a reconnect sends setCell before re-subscribe", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const firstSocket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_reconnect",
        name: "Alice",
        shard: "shard-a",
      });

      firstSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      await waitFor(() => {
        const tileStub = harness.tileOwners.getByName("0:0");
        expect(tileStub.watchRequests.length).toBe(1);
      });

      firstSocket.emitClose();

      const secondSocket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_reconnect",
        name: "Alice",
        shard: "shard-a",
      });
      secondSocket.emitMessage(
        encodeClientMessageBinary({
          t: "setCell",
          cid: "c_set_before_resub",
          tile: "0:0",
          i: 7,
          v: 1,
          op: "op_before_resub",
        })
      );

      await waitFor(() => {
        const messages = decodeMessages(secondSocket);
        expect(messages.some((message) => message.t === "err" && message.code === "not_subscribed")).toBe(true);
      });

      const events = parseStructuredLogs(logSpy);
      const event = events.find(
        (entry) =>
          entry.scope === "connection_shard_do"
          && entry.event === "setcell_not_subscribed"
          && entry.uid === "u_reconnect"
          && entry.tile === "0:0"
      );

      expect(event).toBeDefined();
      expect(event).toMatchObject({
        cid: "c_set_before_resub",
        i: 7,
        v: 1,
        op: "op_before_resub",
        subscribed_count: 0,
        clients_connected: 1,
      });
      expect(Array.isArray(event?.subscribed_tiles_sample)).toBe(true);
      expect((event?.subscribed_tiles_sample as unknown[]).length).toBe(0);
      expect(typeof event?.connection_age_ms).toBe("number");
      expect((event?.connection_age_ms as number)).toBeGreaterThanOrEqual(0);
      expect((event?.connection_age_ms as number)).toBeLessThan(10_000);

      const errEvent = events.find(
        (entry) =>
          entry.scope === "connection_shard_do"
          && entry.event === "server_error_sent"
          && entry.uid === "u_reconnect"
          && entry.code === "not_subscribed"
      );

      expect(errEvent).toMatchObject({
        cid: "c_set_before_resub",
        msg: "Tile 0:0 is not currently subscribed",
        tile: "0:0",
        i: 7,
        v: 1,
        op: "op_before_resub",
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("ingests cursor batches and forwards only to clients with cursor subscriptions", async () => {
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
    socketA.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

    const response = await postCursorBatch(harness.shard, {
      from: "shard-1",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 1.5,
          y: 1.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });

    expect(response.status).toBe(204);

    await waitFor(() => {
      const messagesA = decodeMessages(socketA);
      expect(messagesA.some((message) => message.t === "curUp" && message.uid === "u_remote" && message.ver === 1)).toBe(true);
    });

    const messagesB = decodeMessages(socketB);
    expect(messagesB.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(false);
  });

  it("logs first local cursor publish with connection age", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-a",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_first_local_publish"
            && entry.shard === "shard-a"
            && entry.uid === "u_a"
            && entry.seq === 1
            && entry.tile === "0:0"
            && typeof entry.connection_age_ms === "number"
            && entry.connection_age_ms >= 0
            && entry.subscribed_count === 1
        )
      ).toBe(true);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_local_publish"
            && entry.shard === "shard-a"
            && entry.uid === "u_a"
            && entry.seq === 1
            && typeof entry.connection_age_ms === "number"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("drops re-entrant cursor-batch requests while ingress is active", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      let releaseFirstBody!: () => void;
      const holdFirstBody = new Promise<void>((resolve) => {
        releaseFirstBody = () => resolve();
      });
      const encoder = new TextEncoder();
      const firstBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"from":"shard-1","updates":'));
          void holdFirstBody.then(() => {
            controller.enqueue(encoder.encode("[]}"));
            controller.close();
          });
        },
      });
      const firstRequestInit: RequestInit & { duplex?: "half" } = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sea-cursor-hub": "1",
        },
        body: firstBody,
        duplex: "half",
      };

      const firstResponsePromise = harness.shard.fetch(
        new Request("https://connection-shard.internal/cursor-batch", firstRequestInit)
      );

      let firstSettled = false;
      void firstResponsePromise.then(() => {
        firstSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(firstSettled).toBe(false);

      const nestedResponse = await postCursorBatch(harness.shard, {
        from: "shard-2",
        updates: [],
      });
      expect(nestedResponse.status).toBe(204);

      releaseFirstBody();
      const firstResponse = await firstResponsePromise;
      expect(firstResponse.status).toBe(204);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_batch_reentrant_drop"
            && event.path === "/cursor-batch"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("drops traced cursor-batch loops once hop depth exceeds the safe limit", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await postCursorBatchWithHeaders(
        harness.shard,
        {
          from: "shard-1",
          updates: [],
        },
        {
          "x-sea-cursor-hub": "1",
          "x-sea-cursor-trace-id": "trace-loop",
          "x-sea-cursor-trace-hop": "2",
          "x-sea-cursor-trace-origin": "shard-origin",
        }
      );

      expect(response.status).toBe(204);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_batch_loop_guard_drop"
            && event.trace_id === "trace-loop"
            && event.trace_hop === 2
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("drops duplicate traced cursor-batch deliveries on the same shard", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const requestBody = {
        from: "shard-1",
        updates: [
          {
            uid: "u_remote",
            name: "Remote",
            x: 1.5,
            y: 1.5,
            seenAt: Date.now(),
            seq: 1,
            tileKey: "0:0",
          },
        ],
      };
      const headers = {
        "x-sea-cursor-hub": "1",
        "x-sea-cursor-trace-id": "trace-dup",
        "x-sea-cursor-trace-hop": "1",
        "x-sea-cursor-trace-origin": "shard-origin",
      };

      const firstResponse = await postCursorBatchWithHeaders(harness.shard, requestBody, headers);
      const secondResponse = await postCursorBatchWithHeaders(harness.shard, requestBody, headers);

      expect(firstResponse.status).toBe(204);
      expect(secondResponse.status).toBe(204);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_batch_duplicate_trace_drop"
            && event.trace_id === "trace-dup"
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

  it("exposes local cursor state via cursor-state endpoint", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 5.5, y: 6.5 }));

    await waitFor(async () => {
      const state = await getCursorState(harness.shard);
      expect(state.from).toBe("shard-0");
      expect(
        state.updates.some(
          (update) => update.uid === "u_a" && update.name === "Alice" && update.x === 5.5 && update.y === 6.5
        )
      ).toBe(true);
    });
  });

  it("logs versioned cursor-state snapshot assembly details", async () => {
    const harness = createRelayHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 5.5, y: 6.5 }));
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 6.5, y: 7.5 }));

      const state = await getCursorStateWithHeaders(harness.shard, {
        "x-sea-cursor-pull": "1",
        "x-sea-cursor-trace-id": "trace-snapshot",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      });

      expect(state.updates.some((update) => update.uid === "u_a" && update.seq === 2)).toBe(true);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_state_snapshot_served"
            && event.from_shard === "shard-0"
            && event.update_count === 1
            && event.max_seq === 2
            && Array.isArray(event.uid_sample)
            && event.uid_sample.includes("u_a")
            && event.trace_id === "trace-snapshot"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("backs off cursor-state polling after repeated quiet polls", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1", "shard-2"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });
      harness.connectionShards.getByName("shard-2").setJsonPathResponse("/cursor-state", {
        from: "shard-2",
        updates: [],
      });

      await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(2);
      expect(countCursorStatePullRequestsForShard(harness, "shard-1")).toBe(1);
      expect(countCursorStatePullRequestsForShard(harness, "shard-2")).toBe(1);
      expect(countCursorStatePullRequestsForShard(harness, "shard-3")).toBe(0);

      await vi.advanceTimersByTimeAsync(450);
      expect(countCursorStatePullRequests(harness)).toBe(14);

      await vi.advanceTimersByTimeAsync(74);
      expect(countCursorStatePullRequests(harness)).toBe(14);

      await vi.advanceTimersByTimeAsync(1);
      expect(countCursorStatePullRequests(harness)).toBe(16);

      await vi.advanceTimersByTimeAsync(149);
      expect(countCursorStatePullRequests(harness)).toBe(18);

      await vi.advanceTimersByTimeAsync(1);
      expect(countCursorStatePullRequests(harness)).toBe(18);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a tighter quiet-poll cadence when only one remote peer is connected", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const singlePeerHarness = createRelayHarness();
      setCursorHubWatchResponse(singlePeerHarness, {
        peerShards: ["shard-1"],
      });
      singlePeerHarness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      const multiPeerHarness = createRelayHarness();
      setCursorHubWatchResponse(multiPeerHarness, {
        peerShards: ["shard-1", "shard-2"],
      });
      multiPeerHarness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });
      multiPeerHarness.connectionShards.getByName("shard-2").setJsonPathResponse("/cursor-state", {
        from: "shard-2",
        updates: [],
      });

      await connectClient(singlePeerHarness.shard, singlePeerHarness.socketPairFactory, {
        uid: "u_single",
        name: "Single",
        shard: "shard-0",
      });
      await connectClient(multiPeerHarness.shard, multiPeerHarness.socketPairFactory, {
        uid: "u_multi",
        name: "Multi",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(countCursorStatePullRequestsForShard(singlePeerHarness, "shard-1")).toBe(12);
      expect(countCursorStatePullRequestsForShard(multiPeerHarness, "shard-1")).toBe(10);
      expect(countCursorStatePullRequestsForShard(multiPeerHarness, "shard-2")).toBe(10);
      expect(countCursorStatePullRequestsForShard(singlePeerHarness, "shard-1")).toBeGreaterThan(
        countCursorStatePullRequestsForShard(multiPeerHarness, "shard-1")
      );
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes cursor-state polling back up when local cursor activity resumes", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1", "shard-2"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });
      harness.connectionShards.getByName("shard-2").setJsonPathResponse("/cursor-state", {
        from: "shard-2",
        updates: [],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(2);

      await vi.advanceTimersByTimeAsync(150 + 225 + 225 + 225 + 225 + 225);
      expect(countCursorStatePullRequests(harness)).toBe(24);

      await vi.advanceTimersByTimeAsync(224);
      expect(countCursorStatePullRequests(harness)).toBe(24);

      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 1.5 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(26);

      await vi.advanceTimersByTimeAsync(74);
      expect(countCursorStatePullRequests(harness)).toBe(26);

      await vi.advanceTimersByTimeAsync(150);
      expect(countCursorStatePullRequests(harness)).toBe(28);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces repeated local cursor activity into one prompt cursor-state reheat", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(1);

      await vi.advanceTimersByTimeAsync(150 + 225 + 225 + 225 + 225 + 225);
      const beforeReheat = countCursorStatePullRequests(harness);

      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 1.5 }));
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.75, y: 1.75 }));
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 3.0, y: 2.0 }));

      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(beforeReheat + 1);

      await vi.advanceTimersByTimeAsync(149);
      expect(countCursorStatePullRequests(harness)).toBe(beforeReheat + 2);

      await vi.advanceTimersByTimeAsync(1);
      expect(countCursorStatePullRequests(harness)).toBe(beforeReheat + 2);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows timer-driven cursor pulls to resume immediately after inbound cursor-state pull ingress", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      const baseline = countCursorStatePullRequests(harness);
      expect(baseline).toBe(1);

      await getCursorStateWithHeaders(harness.shard, {
        "x-sea-cursor-pull": "1",
        "x-sea-cursor-trace-id": "trace-inbound",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(baseline);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms a detached alarm before issuing the initial cursor-state pull", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(harness.hasPendingAlarm()).toBe(true);
      expect(countCursorStatePullRequests(harness)).toBe(0);

      await harness.fireAlarm();
      expect(countCursorStatePullRequests(harness)).toBe(1);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs post-ingress reverse pull from a detached alarm instead of directly from the wake callback", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(0);
      expect(harness.hasPendingAlarm()).toBe(true);

      await harness.fireAlarm();
      const baseline = countCursorStatePullRequests(harness);
      expect(baseline).toBe(1);

      await getCursorStateWithHeaders(harness.shard, {
        "x-sea-cursor-pull": "1",
        "x-sea-cursor-trace-id": "trace-inbound",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 1.5 }));
      await vi.advanceTimersByTimeAsync(299);
      expect(countCursorStatePullRequests(harness)).toBe(baseline);

      await vi.advanceTimersByTimeAsync(1);
      expect(countCursorStatePullRequests(harness)).toBe(baseline);
      expect(harness.hasPendingAlarm()).toBe(true);

      await harness.fireAlarm();
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(baseline);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs stale detached cursor-pull alarms without throwing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });

      await expect(harness.shard.alarm()).resolves.toBeUndefined();

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_alarm_stale"
            && entry.alarm_armed === false
            && entry.in_flight === false
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs structured context when a detached cursor-pull alarm run throws", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const markRunStartedSpy = vi
      .spyOn(ConnectionShardCursorPullScheduler.prototype, "markRunStarted")
      .mockImplementation(() => {
        throw new Error("alarm exploded");
      });
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(harness.hasPendingAlarm()).toBe(true);
      await expect(harness.fireAlarm()).rejects.toThrow("alarm exploded");

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_alarm_failed"
            && entry.failure_stage === "run_tick"
            && entry.error_name === "Error"
            && entry.error_message === "alarm exploded"
            && typeof entry.error_stack === "string"
            && typeof entry.scheduled_at_ms === "number"
            && entry.in_flight === true
        )
      ).toBe(true);
    } finally {
      markRunStartedSpy.mockRestore();
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs primitive detached alarm failures before runTick begins", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consumeAlarmWakeSpy = vi
      .spyOn(ConnectionShardCursorPullOrchestrator.prototype, "consumeAlarmWake")
      .mockImplementation(() => {
        throw "2026-03-14T21:34:37.497Z";
      });
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(harness.hasPendingAlarm()).toBe(true);

      await expect(harness.fireAlarm()).rejects.toBe("2026-03-14T21:34:37.497Z");

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_alarm_failed"
            && entry.failure_stage === "consume_wake"
            && entry.error_type === "string"
            && entry.error_message === "2026-03-14T21:34:37.497Z"
            && entry.error_datetime_like === true
            && entry.pre_alarm_armed === true
            && entry.pre_pending_wake_reason === "watch_scope_change"
            && typeof entry.pre_scheduled_at_ms === "number"
        )
      ).toBe(true);
    } finally {
      consumeAlarmWakeSpy.mockRestore();
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs watch-scope wake scheduling and alarm execution decisions", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

      for (let index = 0; index < 5 && !harness.hasPendingAlarm(); index += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }

      const eventsBeforeAlarm = parseStructuredLogs(logSpy);
      expect(
        eventsBeforeAlarm.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_scope"
            && entry.shard === "shard-0"
            && entry.previous_peer_count === 0
            && entry.peer_count === 1
        )
      ).toBe(true);
      expect(
        eventsBeforeAlarm.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_watch_scope_wake"
            && entry.shard === "shard-0"
            && entry.action === "scheduled_new"
            && entry.wake_reason === "watch_scope_change"
        )
      ).toBe(true);
      expect(harness.hasPendingAlarm()).toBe(true);

      await harness.fireAlarm();
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs scope-unchanged refreshes and first peer visibility for the current scope epoch", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [
          {
            uid: "u_remote",
            name: "Remote",
            x: 1.5,
            y: 2.5,
            seenAt: 123,
            seq: 1,
            tileKey: "0:0",
          },
        ],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

      for (let index = 0; index < 5 && !harness.hasPendingAlarm(); index += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }

      await harness.fireAlarm();

      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_first_peer_visibility"
            && entry.shard === "shard-0"
            && entry.target_shard === "shard-1"
            && entry.update_count === 1
            && typeof entry.scope_observed_at_ms === "number"
            && typeof entry.scope_age_ms === "number"
        )
      ).toBe(true);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_scope_unchanged"
            && entry.shard === "shard-0"
            && entry.peer_count === 1
            && typeof entry.oldest_scope_age_ms === "number"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs pre-visibility empty snapshots before the first visible peer cursor arrives", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

      for (let index = 0; index < 5 && !harness.hasPendingAlarm(); index += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }

      await harness.fireAlarm();

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_pre_visibility_observation"
            && entry.shard === "shard-0"
            && entry.target_shard === "shard-1"
            && entry.outcome === "empty_snapshot"
            && entry.update_count === 0
            && entry.delta_observed === false
            && typeof entry.scope_observed_at_ms === "number"
            && typeof entry.scope_age_ms === "number"
        )
      ).toBe(true);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_first_peer_visibility"
            && entry.shard === "shard-0"
            && entry.target_shard === "shard-1"
        )
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("starts the first pull after peer scope becomes non-empty without extra cursor-state cooldown", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [
          {
            uid: "u_remote",
            name: "Remote",
            x: 1.5,
            y: 2.5,
            seenAt: 123,
            seq: 1,
            tileKey: "0:0",
          },
        ],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

      for (let index = 0; index < 5 && !harness.hasPendingAlarm(); index += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }

      await getCursorStateWithHeaders(harness.shard, {
        "x-sea-cursor-pull": "1",
        "x-sea-cursor-trace-id": "trace-bypass-first-post-scope",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      });

      await harness.fireAlarm();

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_first_post_scope_decision"
            && entry.shard === "shard-0"
            && entry.action === "started"
            && (entry.wake_reason === "watch_scope_change" || entry.wake_reason === "local_activity")
            && typeof entry.suppression_remaining_ms === "number"
            && entry.suppression_remaining_ms === 0
        )
      ).toBe(true);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_peer"
            && entry.shard === "shard-0"
            && (entry.wake_reason === "watch_scope_change" || entry.wake_reason === "local_activity")
            && entry.ok === true
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("resumes local-activity pulls immediately after inbound cursor-state pull ingress completes", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(0);
      const baseline = countCursorStatePullRequests(harness);
      expect(baseline).toBe(1);

      await getCursorStateWithHeaders(harness.shard, {
        "x-sea-cursor-pull": "1",
        "x-sea-cursor-trace-id": "trace-inbound",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 1.5 }));
      await vi.advanceTimersByTimeAsync(100);
      expect(
        parseStructuredLogs(logSpy).some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_local_activity_wake"
            && entry.wake_reason === "local_activity"
            && typeof entry.suppression_remaining_ms === "number"
            && entry.suppression_remaining_ms === 0
        )
      ).toBe(true);
      expect(
        parseStructuredLogs(logSpy).some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_peer"
            && (entry.wake_reason === "local_activity" || entry.wake_reason === "timer")
        )
      ).toBe(true);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(baseline);
      randomSpy.mockRestore();
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not relay inbound cursor batches to peer shards", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const beforeRelayCount = countCursorRelaySubrequests(harness);

    const response = await postCursorBatch(harness.shard, {
      from: "shard-1",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 1.5,
          y: 1.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });

    expect(response.status).toBe(204);

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
    }, { attempts: 80, delayMs: 5 });

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const afterRelayCount = countCursorRelaySubrequests(harness);
    expect(afterRelayCount).toBe(beforeRelayCount);
  });

  it("logs remote cursor ingest decisions with previous and next versions", async () => {
    const harness = createRelayHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

      await waitFor(() => {
        const messages = decodeMessages(socket);
        expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
      });

      const headers = {
        "x-sea-cursor-trace-id": "trace-ingest",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      };
      const staleHeaders = {
        "x-sea-cursor-trace-id": "trace-ingest-stale",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      };

      await postCursorBatchWithHeaders(
        harness.shard,
        {
          from: "shard-1",
          updates: [
            {
              uid: "u_remote",
              name: "Remote",
              x: 1.5,
              y: 1.5,
              seenAt: Date.now(),
              seq: 1,
              tileKey: "0:0",
            },
          ],
        },
        staleHeaders
      );
      await postCursorBatchWithHeaders(
        harness.shard,
        {
          from: "shard-1",
          updates: [
            {
              uid: "u_remote",
              name: "Remote",
              x: 1.0,
              y: 1.0,
              seenAt: Date.now() - 1,
              seq: 1,
              tileKey: "0:0",
            },
          ],
        },
        headers
      );

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_remote_ingest"
            && event.from_shard === "shard-1"
            && event.uid === "u_remote"
            && event.previous_seq === undefined
            && event.next_seq === 1
            && event.applied === true
            && event.trace_id === "trace-ingest-stale"
        )
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_remote_ingest"
            && event.from_shard === "shard-1"
            && event.uid === "u_remote"
            && event.previous_seq === 1
            && event.next_seq === 1
            && event.fanout_count === 0
            && event.applied === false
            && event.ignored_reason === "stale"
            && event.trace_id === "trace-ingest"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("suppresses local cursor relay re-entry while processing inbound cursor batches", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const beforeRelayCount = countCursorRelaySubrequests(harness);

    const response = await postCursorBatch(harness.shard, {
      from: "shard-1",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 1.5,
          y: 1.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
    expect(response.status).toBe(204);

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
    }, { attempts: 80, delayMs: 5 });

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const afterRelayCount = countCursorRelaySubrequests(harness);
    expect(afterRelayCount).toBe(beforeRelayCount);
  });

  it("does not publish local cursors to the hub during inbound cursor-batch handling and wakes cursor pull", async () => {
    const harness = createRelayHarness();
    setCursorHubWatchResponse(harness, {
      peerShards: ["shard-1"],
    });
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
      from: "shard-1",
      updates: [],
    });

    const response = await postCursorBatch(harness.shard, {
      from: "shard-1",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 1.5,
          y: 1.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
    expect(response.status).toBe(204);
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 1.5 }));

    await waitFor(() => {
      expect(countCursorHubPublishes(harness)).toBe(0);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(0);
    }, { attempts: 120, delayMs: 10 });
  });

  it("does not publish local cursors to the hub after inbound tile-batch handling and wakes cursor pull", async () => {
    const harness = createRelayHarness();
    setCursorHubWatchResponse(harness, {
      peerShards: ["shard-1"],
    });
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
      from: "shard-1",
      updates: [],
    });

    const originalSend = socket.send.bind(socket);
    let reflectedCursor = false;
    socket.send = (payload) => {
      originalSend(payload);
      if (reflectedCursor || typeof payload === "string") {
        return;
      }

      const message = decodeServerMessageBinary(toUint8Array(payload));
      if (message.t !== "cellUpBatch" || message.tile !== "0:0") {
        return;
      }

      reflectedCursor = true;
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 1.5 }));
    };

    const response = await postTileBatch(harness.shard, {
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 1,
      toVer: 1,
      ops: [[10, 1]],
    });
    expect(response.status).toBe(204);

    await new Promise((resolve) => setTimeout(resolve, 80));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 2.5 }));

    await waitFor(() => {
      expect(countCursorHubPublishes(harness)).toBe(0);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(0);
    }, { attempts: 80, delayMs: 5 });
  });

  it("rejects malformed cursor-batch payloads", async () => {
    const harness = createHarness();
    const badBodies = [
      {},
      { from: "", updates: [] },
      { from: "shard-1", updates: {} },
      {
        from: "shard-1",
        updates: [{ uid: "u_a", name: "A", x: 1, y: 1, seenAt: Date.now(), seq: 0, tileKey: "0:0" }],
      },
      {
        from: "shard-1",
        updates: [{ uid: "u_a", name: "A", x: 1, y: 1, seenAt: Date.now(), seq: 1, tileKey: "bad" }],
      },
    ];

    for (const body of badBodies) {
      const response = await postCursorBatch(harness.shard, body);
      expect(response.status).toBe(400);
    }
  });

  it("ignores self-origin cursor batches without forwarding", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));
    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const beforeRelayCount = countCursorRelaySubrequests(harness);

    const response = await postCursorBatch(harness.shard, {
      from: "shard-0",
      updates: [
        {
          uid: "u_remote_self",
          name: "RemoteSelf",
          x: 2.5,
          y: 2.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
    expect(response.status).toBe(204);

    const messages = decodeMessages(socket);
    expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote_self")).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const afterRelayCount = countCursorRelaySubrequests(harness);
    expect(afterRelayCount).toBe(beforeRelayCount);
  });

  it("limits remote cursor subscription to nearest MAX_REMOTE_CURSORS", async () => {
    const harness = createHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_view",
      name: "Viewer",
      shard: "shard-a",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

    const updates = Array.from({ length: MAX_REMOTE_CURSORS + 2 }, (_, index) => ({
      uid: `u_remote_${index}`,
      name: `Remote${index}`,
      x: 1 + index,
      y: 0.5,
      seenAt: Date.now(),
      seq: 1,
      tileKey: "0:0",
    }));

    const response = await postCursorBatch(harness.shard, {
      from: "shard-1",
      updates,
    });
    expect(response.status).toBe(204);

    await waitFor(() => {
      const messages = decodeMessages(socket);
      const remoteUids = new Set(
        messages
          .filter((message): message is Extract<ServerMessage, { t: "curUp" }> => message.t === "curUp")
          .filter((message) => message.uid.startsWith("u_remote_"))
          .map((message) => message.uid)
      );

      expect(remoteUids.size).toBe(MAX_REMOTE_CURSORS);
      expect(remoteUids.has("u_remote_0")).toBe(true);
      expect(remoteUids.has(`u_remote_${MAX_REMOTE_CURSORS + 1}`)).toBe(false);
    });
  });

  it("forwards local cursor updates via DO runtime path", async () => {
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
    socketB.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));
    socketA.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 0.5 }));

    await waitFor(() => {
      const messagesB = decodeMessages(socketB);
      expect(messagesB.some((message) => message.t === "curUp" && message.uid === "u_a" && message.ver === 1)).toBe(true);
    });
  });

  it("pulls peer cursor-state when the hub is configured and never publishes local cursors to the hub", async () => {
    const harness = createRelayHarness();
    setCursorHubWatchResponse(harness, {
      peerShards: ["shard-1"],
    });
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
      from: "shard-1",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 9.5,
          y: 1.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 0.5 }));

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(0);
      expect(countCursorStatePullRequestsForShard(harness, "shard-1")).toBeGreaterThan(0);
      expect(countCursorStatePullRequestsForShard(harness, "shard-2")).toBe(0);
      expect(countCursorHubPublishes(harness)).toBe(0);
    }, { attempts: 80, delayMs: 5 });

    const hub = harness.cursorHub.getByName("global");
    const watchRequest = hub.requests.find((entry) => {
      const url = new URL(entry.request.url);
      return entry.request.method === "POST" && url.pathname === "/watch";
    });
    expect(watchRequest).toBeDefined();
    expect(countCursorRelaySubrequests(harness)).toBe(0);
  });

  it("polls only watched peers returned by the hub watch flow", async () => {
    const harness = createRelayHarness();
    setCursorHubWatchResponse(harness, {
      peerShards: ["shard-2"],
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 4.5,
          y: 5.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
    harness.connectionShards.getByName("shard-2").setJsonPathResponse("/cursor-state", {
      from: "shard-2",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 4.5,
          y: 5.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
    harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
      from: "shard-1",
      updates: [
        {
          uid: "u_irrelevant",
          name: "Irrelevant",
          x: 8.5,
          y: 8.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });

    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 0.5 }));

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
      expect(messages.some((message) => message.t === "curUp" && message.uid === "u_irrelevant")).toBe(false);
      expect(countCursorStatePullRequestsForShard(harness, "shard-2")).toBeGreaterThan(0);
    }, { attempts: 80, delayMs: 5 });

    expect(countCursorStatePullRequestsForShard(harness, "shard-1")).toBe(0);
    expect(countCursorStatePullRequestsForShard(harness, "shard-3")).toBe(0);
  });

  it("caps in-flight cursor-state pulls instead of starting every peer at once", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1", "shard-2", "shard-3", "shard-4"],
      });
      for (const shardName of ["shard-1", "shard-2", "shard-3", "shard-4"]) {
        harness.connectionShards.getByName(shardName).setNeverResolvePath("/cursor-state", true);
      }

      await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(2);
      expect(countCursorStatePullRequestsForShard(harness, "shard-1")).toBe(1);
      expect(countCursorStatePullRequestsForShard(harness, "shard-2")).toBe(1);
      expect(countCursorStatePullRequestsForShard(harness, "shard-3")).toBe(0);
      expect(countCursorStatePullRequestsForShard(harness, "shard-4")).toBe(0);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds jitter to timer-driven cursor-state pulls", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(countCursorStatePullRequests(harness)).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(countCursorStatePullRequests(harness)).toBe(2);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cursor-state pull failures best-effort and does not emit client errors", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1", "shard-2"],
      });
      harness.connectionShards.getByName("shard-1").setPathStatus("/cursor-state", 500);
      harness.connectionShards.getByName("shard-2").setJsonPathResponse("/cursor-state", {
        from: "shard-2",
        updates: [
          {
            uid: "u_remote",
            name: "Remote",
            x: 3.5,
            y: 2.5,
            seenAt: Date.now(),
            seq: 1,
            tileKey: "0:0",
          },
        ],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 0.5 }));

      await waitFor(() => {
        const messages = decodeMessages(socket);
        expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
      }, { attempts: 80, delayMs: 5 });

      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "err" && message.code === "internal")).toBe(false);

      await waitFor(() => {
        const events = parseStructuredLogs(logSpy);
        expect(
          events.some(
            (entry) =>
              entry.scope === "connection_shard_do"
              && entry.event === "cursor_pull_peer"
              && entry.target_shard === "shard-1"
              && entry.ok === false
          )
        ).toBe(true);
      }, { attempts: 80, delayMs: 5 });

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "server_error_sent"
            && entry.uid === "u_a"
            && entry.code === "internal"
        )
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("includes fallback trace ids on internal websocket errors without an active cursor trace", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createHarness();
      harness.tileOwners.getByName("0:0").setPathError("/watch", new Error("watch exploded"));
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-a",
      });

      socket.emitMessage(encodeClientMessageBinary({
        t: "sub",
        cid: "c_sub_trace",
        tiles: ["0:0"],
      }));

      let errorMessage: Extract<ServerMessage, { t: "err" }> | undefined;
      await waitFor(() => {
        errorMessage = decodeMessages(socket).find(
          (message): message is Extract<ServerMessage, { t: "err" }> =>
            message.t === "err" && message.code === "internal"
        );
        expect(errorMessage?.trace).toEqual(expect.any(String));
      });

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "internal_error"
            && entry.uid === "u_a"
            && entry.trace_id === errorMessage?.trace
        )
      ).toBe(true);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "server_error_sent"
            && entry.uid === "u_a"
            && entry.code === "internal"
            && entry.trace_id === errorMessage?.trace
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not publish local cursors to the hub after an inbound traced cursor batch", async () => {
    const harness = createRelayHarness();
    setCursorHubWatchResponse(harness, {
      peerShards: ["shard-1"],
    });
    harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
      from: "shard-1",
      updates: [],
    });
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

    const response = await postCursorBatchWithHeaders(
      harness.shard,
      {
        from: "shard-1",
        updates: [
          {
            uid: "u_remote",
            name: "Remote",
            x: 1.5,
            y: 1.5,
            seenAt: Date.now(),
            seq: 1,
            tileKey: "0:0",
          },
        ],
      },
      {
        "x-sea-cursor-hub": "1",
        "x-sea-cursor-trace-id": "trace-prop",
        "x-sea-cursor-trace-hop": "1",
        "x-sea-cursor-trace-origin": "shard-origin",
      }
    );
    expect(response.status).toBe(204);
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 2.5 }));

    await waitFor(() => {
      expect(countCursorHubPublishes(harness)).toBe(0);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(0);
    }, { attempts: 120, delayMs: 10 });
  });

  it("does not generate timer-driven cursor relay from inbound batches", async () => {
    vi.useFakeTimers();
    try {
      const harness = createRelayHarness();
      const response = await postCursorBatch(harness.shard, {
        from: "shard-1",
        updates: [
          {
            uid: "u_remote_timer",
            name: "RemoteTimer",
            x: 3.5,
            y: 3.5,
            seenAt: Date.now(),
            seq: 1,
            tileKey: "0:0",
          },
        ],
      });
      expect(response.status).toBe(204);

      await vi.advanceTimersByTimeAsync(60_000);
      await drainDeferred(harness);
      expect(countCursorRelaySubrequests(harness)).toBe(0);
      expect(countCursorHubPublishes(harness)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribes and unsubscribes shard watch with cursor hub as clients connect/disconnect", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    await waitFor(() => {
      const hub = harness.cursorHub.getByName("global");
      const subWatch = hub.requests.some((entry) => {
        const url = new URL(entry.request.url);
        return entry.request.method === "POST" && url.pathname === "/watch" && entry.body.includes('"action":"sub"');
      });
      expect(subWatch).toBe(true);
    });

    socket.emitClose();

    await waitFor(() => {
      const hub = harness.cursorHub.getByName("global");
      const unsubWatch = hub.requests.some((entry) => {
        const url = new URL(entry.request.url);
        return entry.request.method === "POST" && url.pathname === "/watch" && entry.body.includes('"action":"unsub"');
      });
      expect(unsubWatch).toBe(true);
    });
  });

  it("unsubscribes watcher on socket close when last subscriber disconnects", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    serverSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.some((request) => request.action === "sub")).toBe(true);
    });

    serverSocket.emitClose();

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.some((request) => request.action === "unsub")).toBe(true);
    });
  });
});
