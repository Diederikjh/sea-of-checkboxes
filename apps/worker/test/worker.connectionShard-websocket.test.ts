import {
  MAX_REMOTE_CURSORS,
} from "@sea/domain";
import {
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  type ServerMessage,
} from "@sea/protocol";
import { describe, expect, it, vi } from "vitest";

import { ConnectionShardDO } from "../src/worker";
import {
  MockSocket,
  MockSocketPairFactory,
  MockUpgradeResponseFactory,
} from "./helpers/socketMocks";
import {
  StubNamespace,
  TileOwnerDurableObjectStub,
} from "./helpers/doStubs";
import { NullStorage } from "./helpers/storageMocks";
import { waitFor } from "./helpers/waitFor";

function decodeMessages(socket: MockSocket): ServerMessage[] {
  const messages: ServerMessage[] = [];

  for (const payload of socket.sentPayloads) {
    if (typeof payload === "string") {
      continue;
    }
    messages.push(decodeServerMessageBinary(toUint8Array(payload)));
  }

  return messages;
}

function toUint8Array(payload: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

function parseStructuredLogs(logSpy: ReturnType<typeof vi.spyOn>) {
  return logSpy.mock.calls
    .flatMap((call) => {
      const payload = call[0];
      if (typeof payload !== "string") {
        return [];
      }
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        return [parsed];
      } catch {
        return [];
      }
    });
}

function createHarness() {
  const socketPairFactory = new MockSocketPairFactory();
  const upgradeResponseFactory = new MockUpgradeResponseFactory(200);
  const tileOwners = new StubNamespace((name) => new TileOwnerDurableObjectStub(name));

  const env = {
    CONNECTION_SHARD: tileOwners,
    TILE_OWNER: tileOwners,
  };

  const state = {
    id: { toString: () => "shard:test" },
    storage: new NullStorage(),
  };

  const shard = new ConnectionShardDO(state, env, {
    socketPairFactory,
    upgradeResponseFactory,
  });

  return {
    shard,
    socketPairFactory,
    upgradeResponseFactory,
    tileOwners,
  };
}

async function connectClient(
  shard: ConnectionShardDO,
  socketPairFactory: MockSocketPairFactory,
  params: { uid: string; name: string; token?: string; shard: string }
): Promise<MockSocket> {
  const token = params.token ?? "test-token";
  const request = new Request(
    `https://connection-shard.internal/ws?uid=${encodeURIComponent(params.uid)}&name=${encodeURIComponent(
      params.name
    )}&token=${encodeURIComponent(token)}&shard=${encodeURIComponent(params.shard)}`,
    {
      method: "GET",
      headers: {
        upgrade: "websocket",
      },
    }
  );

  const response = await shard.fetch(request);
  expect(response.status).toBe(200);

  const pair = socketPairFactory.pairs[socketPairFactory.pairs.length - 1];
  if (!pair) {
    throw new Error("Expected socket pair");
  }

  expect(pair.server.wasAccepted()).toBe(true);
  return pair.server;
}

async function postJson(
  shard: ConnectionShardDO,
  path: "/tile-batch" | "/cursor-batch",
  body: unknown
): Promise<Response> {
  return shard.fetch(
    new Request(`https://connection-shard.internal${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  );
}

async function postTileBatch(
  shard: ConnectionShardDO,
  body: Extract<ServerMessage, { t: "cellUpBatch" }>
): Promise<Response> {
  return postJson(shard, "/tile-batch", body);
}

async function postCursorBatch(
  shard: ConnectionShardDO,
  body: unknown
): Promise<Response> {
  return postJson(shard, "/cursor-batch", body);
}

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

  it("subscribes tiles, registers watch, and returns snapshots", async () => {
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

    const tileStub = harness.tileOwners.getByName("0:0");
    expect(tileStub.watchRequests[0]).toEqual({
      tile: "0:0",
      shard: "shard-a",
      action: "sub",
    });

    const messages = decodeMessages(serverSocket);
    expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
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

  it("logs non-monotonic tile-batch version ordering anomalies", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
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
      expect(messagesA.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
    });

    const messagesB = decodeMessages(socketB);
    expect(messagesB.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(false);
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
      expect(messagesB.some((message) => message.t === "curUp" && message.uid === "u_a")).toBe(true);
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
