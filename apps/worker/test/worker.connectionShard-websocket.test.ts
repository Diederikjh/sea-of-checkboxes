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
  RecordingDurableObjectStub,
  TileOwnerDurableObjectStub,
} from "./helpers/doStubs";
import { NullStorage } from "./helpers/storageMocks";
import { waitFor } from "./helpers/waitFor";
import type { CursorRelayBatch } from "../src/cursorRelay";

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
  const cursorHub = new StubNamespace((name) => new RecordingDurableObjectStub(name));

  const env = {
    CONNECTION_SHARD: tileOwners,
    TILE_OWNER: tileOwners,
    CURSOR_HUB: cursorHub,
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
    cursorHub,
  };
}

function createRelayHarness() {
  const socketPairFactory = new MockSocketPairFactory();
  const upgradeResponseFactory = new MockUpgradeResponseFactory(200);
  const connectionShards = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  const tileOwners = new StubNamespace((name) => new TileOwnerDurableObjectStub(name));
  const cursorHub = new StubNamespace((name) => new RecordingDurableObjectStub(name));

  const env = {
    CONNECTION_SHARD: connectionShards,
    TILE_OWNER: tileOwners,
    CURSOR_HUB: cursorHub,
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
    connectionShards,
    cursorHub,
  };
}

type RelayHarness = ReturnType<typeof createRelayHarness>;

function countConnectionShardSubrequests(
  harness: RelayHarness,
  options: { path: string; method?: string }
): number {
  let total = 0;
  const method = options.method?.toUpperCase();
  for (const stub of harness.connectionShards.stubs.values()) {
    total += stub.requests.filter((entry) => {
      const url = new URL(entry.request.url);
      if (url.pathname !== options.path) {
        return false;
      }
      if (!method) {
        return true;
      }
      return entry.request.method.toUpperCase() === method;
    }).length;
  }
  return total;
}

function countCursorRelaySubrequests(harness: RelayHarness): number {
  return countConnectionShardSubrequests(harness, {
    path: "/cursor-batch",
    method: "POST",
  });
}

function countCursorStatePullRequests(harness: RelayHarness): number {
  return countConnectionShardSubrequests(harness, {
    path: "/cursor-state",
    method: "GET",
  });
}

function countCursorHubRequests(
  harness: RelayHarness,
  options: { path: string; method?: string }
): number {
  let total = 0;
  const method = options.method?.toUpperCase();
  for (const stub of harness.cursorHub.stubs.values()) {
    total += stub.requests.filter((entry) => {
      const url = new URL(entry.request.url);
      if (url.pathname !== options.path) {
        return false;
      }
      if (!method) {
        return true;
      }
      return entry.request.method.toUpperCase() === method;
    }).length;
  }
  return total;
}

function countCursorHubPublishes(harness: RelayHarness): number {
  return countCursorHubRequests(harness, {
    path: "/publish",
    method: "POST",
  });
}

function countTileOpsSinceRequests(harness: ReturnType<typeof createHarness>): number {
  let total = 0;
  for (const stub of harness.tileOwners.stubs.values()) {
    total += stub.requests.filter((entry) => {
      const url = new URL(entry.request.url);
      return entry.request.method.toUpperCase() === "GET" && url.pathname === "/ops-since";
    }).length;
  }

  return total;
}

async function drainDeferred(harness: RelayHarness): Promise<void> {
  void harness;
  await Promise.resolve();
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

async function postTileBatchWithHeaders(
  shard: ConnectionShardDO,
  body: Extract<ServerMessage, { t: "cellUpBatch" }>,
  headers: Record<string, string>
): Promise<Response> {
  return shard.fetch(
    new Request("https://connection-shard.internal/tile-batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

async function postCursorBatch(
  shard: ConnectionShardDO,
  body: unknown
): Promise<Response> {
  return postJson(shard, "/cursor-batch", body);
}

async function postCursorBatchWithHeaders(
  shard: ConnectionShardDO,
  body: unknown,
  headers: Record<string, string>
): Promise<Response> {
  return shard.fetch(
    new Request("https://connection-shard.internal/cursor-batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

async function getCursorState(shard: ConnectionShardDO): Promise<CursorRelayBatch> {
  const response = await shard.fetch(
    new Request("https://connection-shard.internal/cursor-state", {
      method: "GET",
    })
  );
  expect(response.status).toBe(200);
  return (await response.json()) as CursorRelayBatch;
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
            && message.ops.some(([index, value]) => index === 42 && value === 1)
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
            && message.ops.some(([index, value]) => index === 77 && value === 1)
        )
      ).toBe(true);
    }, { attempts: 120, delayMs: 10 });
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
      expect(messagesA.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
    });

    const messagesB = decodeMessages(socketB);
    expect(messagesB.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(false);
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

  it("suppresses cursor hub publishes during inbound cursor-batch processing and resumes after cooldown", async () => {
    const harness = createRelayHarness();
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

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const beforeHubPublishCount = countCursorHubPublishes(harness);

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

    await new Promise((resolve) => setTimeout(resolve, 90));
    await drainDeferred(harness);
    const duringCooldownHubPublishCount = countCursorHubPublishes(harness);
    expect(duringCooldownHubPublishCount).toBe(beforeHubPublishCount);

    await waitFor(() => {
      expect(countCursorHubPublishes(harness)).toBeGreaterThan(beforeHubPublishCount);
    }, { attempts: 120, delayMs: 10 });
  });

  it("suppresses cursor hub publishes during inbound tile-batch processing and resumes after cooldown", async () => {
    const harness = createRelayHarness();
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

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const beforeHubPublishCount = countCursorHubPublishes(harness);

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

    await new Promise((resolve) => setTimeout(resolve, 90));
    await drainDeferred(harness);
    const duringCooldownHubPublishCount = countCursorHubPublishes(harness);
    expect(duringCooldownHubPublishCount).toBe(beforeHubPublishCount);

    await new Promise((resolve) => setTimeout(resolve, 80));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 2.5 }));

    await waitFor(() => {
      expect(countCursorHubPublishes(harness)).toBeGreaterThan(beforeHubPublishCount);
    }, { attempts: 80, delayMs: 5 });
    expect(countCursorStatePullRequests(harness)).toBe(0);
  });

  it("does not publish hub updates from inbound cursor batches and only publishes new local cursors", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    const beforeHubPublishCount = countCursorHubPublishes(harness);

    const inboundResponse = await postCursorBatch(harness.shard, {
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
    expect(inboundResponse.status).toBe(204);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(countCursorHubPublishes(harness)).toBe(beforeHubPublishCount);

    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 3.5, y: 3.5 }));

    await waitFor(() => {
      expect(countCursorHubPublishes(harness)).toBeGreaterThan(beforeHubPublishCount);
    }, { attempts: 80, delayMs: 5 });
    expect(countCursorStatePullRequests(harness)).toBe(0);
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
      expect(messagesB.some((message) => message.t === "curUp" && message.uid === "u_a")).toBe(true);
    });
  });

  it("publishes local cursor updates to cursor hub and does not poll peer cursor-state", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 0.5 }));

    await waitFor(() => {
      expect(countCursorHubPublishes(harness)).toBeGreaterThan(0);
    }, { attempts: 80, delayMs: 5 });

    const hub = harness.cursorHub.getByName("global");
    const watchRequest = hub.requests.find((entry) => {
      const url = new URL(entry.request.url);
      return entry.request.method === "POST" && url.pathname === "/watch";
    });
    expect(watchRequest).toBeDefined();

    const publishRequest = hub.requests.find((entry) => {
      const url = new URL(entry.request.url);
      return entry.request.method === "POST" && url.pathname === "/publish";
    });
    expect(publishRequest).toBeDefined();
    const publishBody = publishRequest ? JSON.parse(publishRequest.body) as CursorRelayBatch : null;
    expect(publishBody?.from).toBe("shard-0");
    expect(
      publishBody?.updates.some(
        (update) => update.uid === "u_a" && update.name === "Alice" && update.x === 1.5 && update.y === 0.5
      )
    ).toBe(true);
    expect(publishRequest?.request.headers.get("x-sea-cursor-trace-id")).toBeNull();
    expect(publishRequest?.request.headers.get("x-sea-cursor-trace-hop")).toBeNull();

    expect(countCursorStatePullRequests(harness)).toBe(0);
    expect(countCursorRelaySubrequests(harness)).toBe(0);
  });

  it("does not leak an inbound cursor trace into later local hub publishes", async () => {
    const harness = createRelayHarness();
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
      expect(countCursorHubPublishes(harness)).toBeGreaterThan(0);
    }, { attempts: 120, delayMs: 10 });

    const hub = harness.cursorHub.getByName("global");
    const publishRequest = [...hub.requests].reverse().find((entry) => {
      const url = new URL(entry.request.url);
      return entry.request.method === "POST" && url.pathname === "/publish";
    });
    expect(publishRequest).toBeDefined();
    expect(publishRequest?.request.headers.get("x-sea-cursor-trace-id")).toBeNull();
    expect(publishRequest?.request.headers.get("x-sea-cursor-trace-hop")).toBeNull();
    expect(publishRequest?.request.headers.get("x-sea-cursor-trace-origin")).toBeNull();
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
