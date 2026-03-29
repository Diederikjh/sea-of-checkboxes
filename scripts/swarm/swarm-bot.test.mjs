import { describe, expect, it, vi } from "vitest";

import { parseSwarmBotArgs } from "./lib/config.mjs";
import { createSwarmBotMetrics } from "./lib/metrics.mjs";
import {
  decodeRle64,
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  shardNameForUid,
  worldToCellIndex,
  worldToTileKey,
} from "./lib/protocol.mjs";
import { SwarmBotSession } from "./lib/swarmBotSession.mjs";

class FakeSocket {
  constructor(url, options = {}) {
    this.url = url;
    this.binaryType = "";
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    this.emitCloseOnClose = options.emitCloseOnClose ?? true;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
    if (this.emitCloseOnClose) {
      this.emit("close", {});
    }
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function encodeHelloMessage({
  uid = "u_test",
  name = "Test",
  token = "tok_test",
  spawn,
} = {}) {
  const encoder = new TextEncoder();
  const chunks = [];
  let totalLength = 0;

  const push = (chunk) => {
    chunks.push(chunk);
    totalLength += chunk.length;
  };
  const writeU8 = (value) => {
    const chunk = new Uint8Array(1);
    chunk[0] = value;
    push(chunk);
  };
  const writeU16 = (value) => {
    const chunk = new Uint8Array(2);
    new DataView(chunk.buffer).setUint16(0, value);
    push(chunk);
  };
  const writeF32 = (value) => {
    const chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setFloat32(0, value);
    push(chunk);
  };
  const writeString = (value) => {
    const encoded = encoder.encode(value);
    writeU16(encoded.length);
    push(encoded);
  };

  writeU8(101);
  writeString(uid);
  writeString(name);
  writeString(token);
  if (spawn) {
    writeU8(1);
    writeF32(spawn.x);
    writeF32(spawn.y);
  } else {
    writeU8(0);
  }

  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function encodeSubAckMessage({
  cid,
  requestedCount = 1,
  changedCount = 1,
  subscribedCount = 1,
}) {
  const encoder = new TextEncoder();
  const encodedCid = encoder.encode(cid);
  const out = new Uint8Array(1 + 2 + encodedCid.length + 4 + 4 + 4);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint8(offset, 106);
  offset += 1;
  view.setUint16(offset, encodedCid.length);
  offset += 2;
  out.set(encodedCid, offset);
  offset += encodedCid.length;
  view.setUint32(offset, requestedCount);
  offset += 4;
  view.setUint32(offset, changedCount);
  offset += 4;
  view.setUint32(offset, subscribedCount);
  return out;
}

function encodeCellUpBatchMessage({
  tile,
  fromVer = 0,
  toVer = 1,
  ops,
}) {
  const [txRaw, tyRaw] = tile.split(":");
  const tx = Number.parseInt(txRaw, 10);
  const ty = Number.parseInt(tyRaw, 10);
  const out = new Uint8Array(1 + 4 + 4 + 4 + 4 + 2 + (ops.length * 3));
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint8(offset, 104);
  offset += 1;
  view.setInt32(offset, tx);
  offset += 4;
  view.setInt32(offset, ty);
  offset += 4;
  view.setUint32(offset, fromVer);
  offset += 4;
  view.setUint32(offset, toVer);
  offset += 4;
  view.setUint16(offset, ops.length);
  offset += 2;
  for (const [index, value] of ops) {
    view.setUint16(offset, index);
    offset += 2;
    view.setUint8(offset, value);
    offset += 1;
  }
  return out;
}

describe("swarm bot config", () => {
  it("parses explicit origin and readonly options", () => {
    const config = parseSwarmBotArgs([
      "--ws-url",
      "wss://example.test/ws",
      "--scenario-id",
      "cursor-heavy",
      "--origin-x",
      "123",
      "--origin-y",
      "-456",
      "--readonly",
    ]);

    expect(config.wsUrl).toBe("wss://example.test/ws");
    expect(config.scenarioId).toBe("cursor-heavy");
    expect(config.originX).toBe(123);
    expect(config.originY).toBe(-456);
    expect(config.readonly).toBe(true);
  });

  it("accepts an explicit initial token for reconnect-safe authenticated runs", () => {
    const config = parseSwarmBotArgs([
      "--token",
      "tok-seeded",
    ]);

    expect(config.token).toBe("tok-seeded");
  });

  it("derives a stable client session id from run and bot ids", () => {
    const config = parseSwarmBotArgs([
      "--run-id",
      "run-1",
      "--bot-id",
      "bot-2",
    ]);

    expect(config.clientSessionId).toBe("swarm_run-1_bot-2");
  });
});

describe("swarm protocol helpers", () => {
  it("encodes client setCell payloads and converts origin coordinates into the same tile", () => {
    const tile = worldToTileKey(900000000, -900000000);
    const index = worldToCellIndex(900000000, -900000000);
    const payload = encodeClientMessageBinary({
      t: "setCell",
      tile,
      i: index,
      v: 1,
      op: "op_1",
    });

    expect(payload[0]).toBe(3);
    expect(tile).toBe("14062500:-14062500");
    expect(index).toBe(0);
  });

  it("decodes hello messages from the binary wire format", () => {
    const message = decodeServerMessageBinary(
      encodeHelloMessage({
        uid: "u_alpha",
        name: "Alpha",
        token: "tok_alpha",
        spawn: { x: 10.5, y: -4.25 },
      })
    );

    expect(message).toEqual({
      t: "hello",
      uid: "u_alpha",
      name: "Alpha",
      token: "tok_alpha",
      spawn: {
        x: 10.5,
        y: -4.25,
      },
    });
  });

  it("decodes rle64 golden vectors and computes shard names", () => {
    expect(Array.from(decodeRle64("AgADAQEA", 6))).toEqual([0, 0, 1, 1, 1, 0]);
    expect(shardNameForUid("u_test123")).toMatch(/^shard-\d+$/);
  });
});

describe("swarm bot metrics", () => {
  it("tracks subscribe and setCell latency samples", () => {
    let now = 0;
    const metrics = createSwarmBotMetrics({
      nowMs: () => now,
    });

    metrics.markConnectAttempt(0);
    now = 25;
    metrics.markHello(now);
    metrics.markSubscribeSent("c_1", now);
    now = 50;
    metrics.markSubscribeAck("c_1", now);
    metrics.markSetCellSent("0:0", 5, now);
    now = 75;
    metrics.markSetCellResolved("0:0", 5, now);

    const summary = metrics.summary();
    expect(summary.latencyMs.hello.p50Ms).toBe(25);
    expect(summary.latencyMs.subscribeAck.p50Ms).toBe(25);
    expect(summary.latencyMs.setCellSync.p50Ms).toBe(25);
  });

  it("clears pending setCell samples on tile snapshot fallback", () => {
    let now = 0;
    const metrics = createSwarmBotMetrics({
      nowMs: () => now,
    });

    metrics.markSetCellSent("0:0", 5, 0);
    metrics.markSetCellSent("0:0", 6, 10);
    metrics.markSetCellSent("1:0", 1, 20);
    now = 40;
    metrics.markTileSnapshotResolved("0:0", now);

    const summary = metrics.summary();
    expect(summary.latencyMs.setCellSync.count).toBe(2);
    expect(summary.pending.setCell).toBe(1);
  });

  it("collapses repeated writes to the same cell to the latest pending intent", () => {
    const metrics = createSwarmBotMetrics();

    metrics.markSetCellSent("0:0", 5, 0);
    metrics.markSetCellSent("0:0", 5, 10);
    metrics.markSetCellResolved("0:0", 5, 40);
    metrics.markSetCellResolved("0:0", 5, 70);

    const summary = metrics.summary();
    expect(summary.counters.setCellSent).toBe(2);
    expect(summary.counters.setCellResolved).toBe(1);
    expect(summary.counters.setCellSuperseded).toBe(1);
    expect(summary.latencyMs.setCellSync.count).toBe(1);
    expect(summary.pending.setCell).toBe(0);
  });
});

describe("swarm bot session", () => {
  it("subscribes after hello and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      const config = parseSwarmBotArgs([
        "--bot-id",
        "bot-test",
        "--duration-ms",
        "10000",
        "--cursor-interval-ms",
        "5000",
        "--setcell-interval-ms",
        "0",
      ]);
      const session = new SwarmBotSession(config, {
        logger,
        wsFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      expect(sockets).toHaveLength(1);
      expect(sockets[0].url).toContain("clientSessionId=swarm_");
      sockets[0].emit("open", {});
      sockets[0].emit("message", {
        data: encodeHelloMessage(),
      });

      const sentMessages = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      expect(sentMessages).toContainEqual({
        t: "sub",
        cid: "bot-test-sub-000000",
        tiles: [worldToTileKey(config.originX, config.originY)],
      });
      expect(sentMessages).toContainEqual({
        t: "cur",
        x: config.originX,
        y: config.originY,
      });

      await session.stop("test_complete");
      await startPromise;
      expect(sockets[0].closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the configured initial token on the first websocket connect", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      const config = parseSwarmBotArgs([
        "--token",
        "tok-seeded",
        "--duration-ms",
        "10000",
        "--setcell-interval-ms",
        "0",
      ]);
      const session = new SwarmBotSession(config, {
        logger,
        wsFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      expect(sockets).toHaveLength(1);
      expect(sockets[0].url).toContain("token=tok-seeded");

      await session.stop("test_complete");
      await startPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("viewport churn unsubscribes and subscribes to the next tile window", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      const config = parseSwarmBotArgs([
        "--bot-id",
        "bot-churn",
        "--scenario-id",
        "viewport-churn",
        "--duration-ms",
        "20000",
        "--cursor-interval-ms",
        "5000",
        "--setcell-interval-ms",
        "0",
      ]);
      const session = new SwarmBotSession(config, {
        logger,
        wsFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      sockets[0].emit("open", {});
      sockets[0].emit("message", {
        data: encodeHelloMessage(),
      });

      await vi.advanceTimersByTimeAsync(5000);
      const sentMessages = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      expect(sentMessages).toContainEqual({
        t: "unsub",
        cid: "bot-churn-unsub-000001",
        tiles: [worldToTileKey(config.originX, config.originY)],
      });
      expect(sentMessages).toContainEqual({
        t: "sub",
        cid: "bot-churn-sub-000002",
        tiles: [worldToTileKey(config.originX + 64, config.originY)],
      });

      await session.stop("test_complete");
      await startPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers viewport churn moves while the current tile has pending writes", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      const config = parseSwarmBotArgs([
        "--bot-id",
        "bot-churn-pending",
        "--scenario-id",
        "viewport-churn",
        "--duration-ms",
        "20000",
        "--cursor-interval-ms",
        "5000",
        "--setcell-interval-ms",
        "3000",
      ]);
      const session = new SwarmBotSession(config, {
        logger,
        wsFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      sockets[0].emit("open", {});
      sockets[0].emit("message", {
        data: encodeHelloMessage(),
      });

      const initialSub = decodeClientMessageBinaryForTest(sockets[0].sent[0]);
      sockets[0].emit("message", {
        data: encodeSubAckMessage({
          cid: initialSub.cid,
        }),
      });

      await vi.advanceTimersByTimeAsync(4500);

      const beforeMove = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      const firstSetCell = beforeMove.find((message) => message.t === "setCell");

      expect(firstSetCell).toBeDefined();

      await vi.advanceTimersByTimeAsync(500);

      const atMoveBoundary = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      expect(atMoveBoundary.some((message) => message.t === "unsub")).toBe(false);
      expect(logger.log).toHaveBeenCalledWith("viewport_move_deferred", expect.objectContaining({
        botId: "bot-churn-pending",
        scenarioId: "viewport-churn",
      }));

      sockets[0].emit("message", {
        data: encodeCellUpBatchMessage({
          tile: firstSetCell.tile,
          toVer: 1,
          ops: [[firstSetCell.i, firstSetCell.v]],
        }),
      });

      await vi.advanceTimersByTimeAsync(100);

      const afterResolve = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      expect(afterResolve).toContainEqual({
        t: "unsub",
        cid: "bot-churn-pending-unsub-000001",
        tiles: [worldToTileKey(config.originX, config.originY)],
      });
      expect(afterResolve).toContainEqual({
        t: "sub",
        cid: "bot-churn-pending-sub-000002",
        tiles: [worldToTileKey(config.originX + 64, config.originY)],
      });

      await vi.advanceTimersByTimeAsync(5100);

      const deferredLogs = logger.log.mock.calls.filter(([event]) => event === "viewport_move_deferred");
      expect(deferredLogs.length).toBeGreaterThanOrEqual(2);

      const finalMessages = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      const finalSetCell = [...finalMessages].reverse().find((message) => message.t === "setCell");
      if (finalSetCell) {
        sockets[0].emit("message", {
          data: encodeCellUpBatchMessage({
            tile: finalSetCell.tile,
            toVer: 2,
            ops: [[finalSetCell.i, finalSetCell.v]],
          }),
        });
      }

      await session.stop("test_complete");
      await startPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays pending writes once when viewport churn drain elapses before moving", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      const config = parseSwarmBotArgs([
        "--bot-id",
        "bot-churn-replay",
        "--scenario-id",
        "viewport-churn",
        "--duration-ms",
        "20000",
        "--cursor-interval-ms",
        "5000",
        "--setcell-interval-ms",
        "3000",
      ]);
      const session = new SwarmBotSession(config, {
        logger,
        wsFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      sockets[0].emit("open", {});
      sockets[0].emit("message", {
        data: encodeHelloMessage(),
      });

      const initialSub = decodeClientMessageBinaryForTest(sockets[0].sent[0]);
      sockets[0].emit("message", {
        data: encodeSubAckMessage({
          cid: initialSub.cid,
        }),
      });

      await vi.advanceTimersByTimeAsync(4500);

      const sentBeforeDrainElapsed = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      const firstSetCell = sentBeforeDrainElapsed.find((message) => message.t === "setCell");
      expect(firstSetCell).toBeDefined();

      await vi.advanceTimersByTimeAsync(2200);

      const sentAfterDrainElapsed = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      const replayedWrites = sentAfterDrainElapsed.filter((message) =>
        message.t === "setCell"
          && message.tile === firstSetCell.tile
          && message.i === firstSetCell.i
          && message.op === firstSetCell.op
      );

      expect(replayedWrites).toHaveLength(2);
      expect(sentAfterDrainElapsed).toContainEqual({
        t: "unsub",
        cid: "bot-churn-replay-unsub-000001",
        tiles: [worldToTileKey(config.originX, config.originY)],
      });
      expect(logger.log).toHaveBeenCalledWith("setcell_replayed", expect.objectContaining({
        botId: "bot-churn-replay",
        scenarioId: "viewport-churn",
        reason: "viewport_move_drain_elapsed",
        count: 1,
      }));

      sockets[0].emit("message", {
        data: encodeCellUpBatchMessage({
          tile: firstSetCell.tile,
          toVer: 1,
          ops: [[firstSetCell.i, firstSetCell.v]],
        }),
      });

      await session.stop("test_complete");
      await startPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains pending viewport churn writes before final shutdown", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      let summary = null;
      const config = parseSwarmBotArgs([
        "--bot-id",
        "bot-churn-stop-drain",
        "--scenario-id",
        "viewport-churn",
        "--duration-ms",
        "20000",
        "--cursor-interval-ms",
        "5000",
        "--setcell-interval-ms",
        "3000",
      ]);
      const session = new SwarmBotSession(config, {
        logger,
        onSummary(value) {
          summary = value;
        },
        wsFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      sockets[0].emit("open", {});
      sockets[0].emit("message", {
        data: encodeHelloMessage(),
      });

      await vi.advanceTimersByTimeAsync(4500);

      const sentMessages = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      const firstSetCell = sentMessages.find((message) => message.t === "setCell");

      expect(firstSetCell).toBeDefined();

      const stopPromise = session.stop("test_complete");
      expect(summary).toBeNull();
      expect(logger.log).toHaveBeenCalledWith("stop_drain_started", expect.objectContaining({
        botId: "bot-churn-stop-drain",
        scenarioId: "viewport-churn",
      }));

      sockets[0].emit("message", {
        data: encodeCellUpBatchMessage({
          tile: firstSetCell.tile,
          toVer: 1,
          ops: [[firstSetCell.i, firstSetCell.v]],
        }),
      });

      await stopPromise;
      await startPromise;

      expect(summary.counters.setCellSent).toBe(1);
      expect(summary.counters.setCellResolved).toBe(1);
      expect(summary.pending.setCell).toBe(0);
      expect(logger.log).toHaveBeenCalledWith("stop_drain_completed", expect.objectContaining({
        botId: "bot-churn-stop-drain",
        scenarioId: "viewport-churn",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps spread-editing writes inside the subscribed tile", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      const config = parseSwarmBotArgs([
        "--bot-id",
        "bot-spread",
        "--scenario-id",
        "spread-editing",
        "--origin-x",
        "900000096",
        "--origin-y",
        "-900000000",
        "--duration-ms",
        "20000",
        "--cursor-interval-ms",
        "5000",
        "--setcell-interval-ms",
        "3000",
      ]);
      const session = new SwarmBotSession(config, {
        logger,
        wsFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      sockets[0].emit("open", {});
      sockets[0].emit("message", {
        data: encodeHelloMessage(),
      });

      await vi.advanceTimersByTimeAsync(9500);

      const sentMessages = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      const subscribedTile = worldToTileKey(config.originX, config.originY);
      const setCellMessages = sentMessages.filter((message) => message.t === "setCell");

      expect(setCellMessages.length).toBeGreaterThan(0);
      expect(setCellMessages.every((message) => message.tile === subscribedTile)).toBe(true);

      await session.stop("test_complete");
      await startPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnect burst reconnects even if close does not emit a close event", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      const config = parseSwarmBotArgs([
        "--bot-id",
        "bot-reconnect",
        "--scenario-id",
        "reconnect-burst",
        "--duration-ms",
        "20000",
        "--cursor-interval-ms",
        "5000",
        "--setcell-interval-ms",
        "0",
        "--reconnect-delay-ms",
        "1000",
      ]);
      let summary = null;
      const session = new SwarmBotSession(config, {
        logger,
        onSummary(value) {
          summary = value;
        },
        wsFactory: (url) => {
          const socket = new FakeSocket(url, {
            emitCloseOnClose: sockets.length !== 0,
          });
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      sockets[0].emit("open", {});
      sockets[0].emit("message", {
        data: encodeHelloMessage({
          token: "tok_first",
        }),
      });

      await vi.advanceTimersByTimeAsync(9000);

      expect(sockets[0].closed).toBe(true);
      expect(logger.log).toHaveBeenCalledWith("reconnect_burst_triggered", expect.objectContaining({
        botId: "bot-reconnect",
        scenarioId: "reconnect-burst",
      }));

      await vi.advanceTimersByTimeAsync(1000);

      expect(sockets).toHaveLength(2);
      sockets[1].emit("open", {});
      sockets[1].emit("message", {
        data: encodeHelloMessage({
          token: "tok_second",
        }),
      });

      await session.stop("test_complete");
      await startPromise;

      expect(summary.counters.connectAttempts).toBe(2);
      expect(summary.counters.helloCount).toBe(2);
      expect(summary.counters.forcedReconnects).toBe(1);
      expect(summary.latencyMs.reconnect.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stale socket error events after shutdown", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      const config = parseSwarmBotArgs([
        "--bot-id",
        "bot-stale-error",
        "--duration-ms",
        "10000",
        "--cursor-interval-ms",
        "5000",
        "--setcell-interval-ms",
        "0",
      ]);
      const session = new SwarmBotSession(config, {
        logger,
        wsFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      sockets[0].emit("open", {});
      sockets[0].emit("message", {
        data: encodeHelloMessage(),
      });

      await session.stop("test_complete");
      await startPromise;

      sockets[0].emit("error", {});

      expect(logger.log).not.toHaveBeenCalledWith("ws_error", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains pending hotspot writes before final shutdown", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      let summary = null;
      const config = parseSwarmBotArgs([
        "--bot-id",
        "bot-hot-drain",
        "--scenario-id",
        "hot-tile-contention",
        "--duration-ms",
        "20000",
        "--cursor-interval-ms",
        "5000",
        "--setcell-interval-ms",
        "3000",
      ]);
      const session = new SwarmBotSession(config, {
        logger,
        onSummary(value) {
          summary = value;
        },
        wsFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      sockets[0].emit("open", {});
      sockets[0].emit("message", {
        data: encodeHelloMessage(),
      });

      await vi.advanceTimersByTimeAsync(1300);

      const sentMessages = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      const firstSetCell = sentMessages.find((message) => message.t === "setCell");

      expect(firstSetCell).toBeDefined();

      const stopPromise = session.stop("test_complete");
      expect(summary).toBeNull();
      expect(logger.log).toHaveBeenCalledWith("stop_drain_started", expect.objectContaining({
        botId: "bot-hot-drain",
        scenarioId: "hot-tile-contention",
      }));

      sockets[0].emit("message", {
        data: encodeCellUpBatchMessage({
          tile: firstSetCell.tile,
          toVer: 1,
          ops: [[firstSetCell.i, firstSetCell.v]],
        }),
      });

      await stopPromise;
      await startPromise;

      expect(summary.counters.setCellSent).toBe(1);
      expect(summary.counters.setCellResolved).toBe(1);
      expect(summary.pending.setCell).toBe(0);
      expect(logger.log).toHaveBeenCalledWith("stop_drain_completed", expect.objectContaining({
        botId: "bot-hot-drain",
        scenarioId: "hot-tile-contention",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays pending hotspot writes when stop drain elapses", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      let summary = null;
      const config = parseSwarmBotArgs([
        "--bot-id",
        "bot-hot-replay",
        "--scenario-id",
        "hot-tile-contention",
        "--duration-ms",
        "20000",
        "--cursor-interval-ms",
        "5000",
        "--setcell-interval-ms",
        "3000",
      ]);
      const session = new SwarmBotSession(config, {
        logger,
        onSummary(value) {
          summary = value;
        },
        wsFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      sockets[0].emit("open", {});
      sockets[0].emit("message", {
        data: encodeHelloMessage(),
      });

      await vi.advanceTimersByTimeAsync(1300);

      const stopPromise = session.stop("test_complete");
      await vi.advanceTimersByTimeAsync(5000);
      await stopPromise;
      await startPromise;

      const sentMessages = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      const setCellMessages = sentMessages.filter((message) => message.t === "setCell");

      expect(setCellMessages).toHaveLength(2);
      expect(setCellMessages[0]).toMatchObject(setCellMessages[1]);
      expect(summary.counters.setCellSent).toBe(1);
      expect(summary.counters.setCellResolved ?? 0).toBe(0);
      expect(summary.pending.setCell).toBe(1);
      expect(logger.log).toHaveBeenCalledWith("setcell_replayed", expect.objectContaining({
        botId: "bot-hot-replay",
        scenarioId: "hot-tile-contention",
        reason: "stop_drain_elapsed",
        count: 1,
      }));
      expect(logger.log).toHaveBeenCalledWith("stop_drain_elapsed", expect.objectContaining({
        botId: "bot-hot-replay",
        scenarioId: "hot-tile-contention",
        replayedSetCell: 1,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains pending reconnect-burst writes before final shutdown", async () => {
    vi.useFakeTimers();
    try {
      const logger = { log: vi.fn() };
      const sockets = [];
      let summary = null;
      const config = parseSwarmBotArgs([
        "--bot-id",
        "bot-reconnect-drain",
        "--scenario-id",
        "reconnect-burst",
        "--duration-ms",
        "20000",
        "--cursor-interval-ms",
        "5000",
        "--setcell-interval-ms",
        "3000",
      ]);
      const session = new SwarmBotSession(config, {
        logger,
        onSummary(value) {
          summary = value;
        },
        wsFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const startPromise = session.start();
      sockets[0].emit("open", {});
      sockets[0].emit("message", {
        data: encodeHelloMessage(),
      });

      await vi.advanceTimersByTimeAsync(3200);

      const sentMessages = sockets[0].sent.map((payload) => decodeClientMessageBinaryForTest(payload));
      const firstSetCell = sentMessages.find((message) => message.t === "setCell");

      expect(firstSetCell).toBeDefined();

      const stopPromise = session.stop("test_complete");
      expect(summary).toBeNull();
      expect(logger.log).toHaveBeenCalledWith("stop_drain_started", expect.objectContaining({
        botId: "bot-reconnect-drain",
        scenarioId: "reconnect-burst",
      }));

      sockets[0].emit("message", {
        data: encodeCellUpBatchMessage({
          tile: firstSetCell.tile,
          toVer: 1,
          ops: [[firstSetCell.i, firstSetCell.v]],
        }),
      });

      await stopPromise;
      await startPromise;

      expect(summary.counters.setCellSent).toBe(1);
      expect(summary.counters.setCellResolved).toBe(1);
      expect(summary.pending.setCell).toBe(0);
      expect(logger.log).toHaveBeenCalledWith("stop_drain_completed", expect.objectContaining({
        botId: "bot-reconnect-drain",
        scenarioId: "reconnect-burst",
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});

function decodeClientMessageBinaryForTest(payload) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const tag = bytes[0];
  if (tag === 1) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tx = view.getInt32(3);
    const ty = view.getInt32(7);
    const stringMarker = bytes[11];
    const length = stringMarker === 1 ? view.getUint16(12) : 0;
    const cidStart = stringMarker === 1 ? 14 : 12;
    const cid = stringMarker === 1
      ? new TextDecoder().decode(bytes.slice(cidStart, cidStart + length))
      : undefined;
    return {
      t: "sub",
      ...(cid ? { cid } : {}),
      tiles: [`${tx}:${ty}`],
    };
  }

  if (tag === 4) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      t: "cur",
      x: view.getFloat32(1),
      y: view.getFloat32(5),
    };
  }

  if (tag === 2) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tx = view.getInt32(3);
    const ty = view.getInt32(7);
    const stringMarker = bytes[11];
    const length = stringMarker === 1 ? view.getUint16(12) : 0;
    const cidStart = stringMarker === 1 ? 14 : 12;
    const cid = stringMarker === 1
      ? new TextDecoder().decode(bytes.slice(cidStart, cidStart + length))
      : undefined;
    return {
      t: "unsub",
      ...(cid ? { cid } : {}),
      tiles: [`${tx}:${ty}`],
    };
  }

  if (tag === 3) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tx = view.getInt32(1);
    const ty = view.getInt32(5);
    return {
      t: "setCell",
      tile: `${tx}:${ty}`,
      i: view.getUint16(9),
      v: bytes[11],
    };
  }

  throw new Error(`Unsupported client tag in test helper: ${tag}`);
}
