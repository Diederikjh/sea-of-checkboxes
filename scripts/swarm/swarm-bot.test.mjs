import { describe, expect, it, vi } from "vitest";

import { parseSwarmBotArgs } from "./lib/config.mjs";
import { createSwarmBotMetrics } from "./lib/metrics.mjs";
import {
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  worldToCellIndex,
  worldToTileKey,
} from "./lib/protocol.mjs";
import { SwarmBotSession } from "./lib/swarmBotSession.mjs";

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.binaryType = "";
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
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
    this.emit("close", {});
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

describe("swarm bot config", () => {
  it("parses explicit origin and readonly options", () => {
    const config = parseSwarmBotArgs([
      "--ws-url",
      "wss://example.test/ws",
      "--origin-x",
      "123",
      "--origin-y",
      "-456",
      "--readonly",
    ]);

    expect(config.wsUrl).toBe("wss://example.test/ws");
    expect(config.originX).toBe(123);
    expect(config.originY).toBe(-456);
    expect(config.readonly).toBe(true);
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

      await session.stop("test_complete");
      await startPromise;
      expect(sockets[0].closed).toBe(true);
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

  throw new Error(`Unsupported client tag in test helper: ${tag}`);
}

