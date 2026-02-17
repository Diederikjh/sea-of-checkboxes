import { describe, expect, it, vi } from "vitest";

import { createWebSocketTransport } from "../src/webSocketTransport";

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    this.binaryType = "";
    this.onmessage = null;
    this.onopen = null;
    this.onclose = null;
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
  }
}

describe("websocket transport", () => {
  it("queues payloads until socket opens", () => {
    const socket = new FakeSocket();
    const transport = createWebSocketTransport("ws://example/ws", {
      wsFactory: () => socket,
    });

    transport.connect(() => {});
    const payload = Uint8Array.from([1, 2, 3]);
    transport.send(payload);

    expect(socket.sent).toEqual([]);

    socket.readyState = 1;
    socket.onopen?.();

    expect(socket.sent).toEqual([payload]);
  });

  it("forwards inbound binary messages as Uint8Array", () => {
    const socket = new FakeSocket();
    const received = [];
    const transport = createWebSocketTransport("ws://example/ws", {
      wsFactory: () => socket,
    });

    transport.connect((payload) => {
      received.push(payload);
    });

    const frame = Uint8Array.from([9, 8, 7]);
    socket.onmessage?.({ data: frame.buffer });

    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[0])).toEqual([9, 8, 7]);
  });

  it("closes socket on dispose", () => {
    const socket = new FakeSocket();
    const transport = createWebSocketTransport("ws://example/ws", {
      wsFactory: () => socket,
    });

    transport.connect(() => {});
    transport.dispose();

    expect(socket.closed).toBe(true);
  });

  it("reconnects after close and flushes queued sends", () => {
    vi.useFakeTimers();
    try {
      const sockets = [];
      const transport = createWebSocketTransport("ws://example/ws", {
        wsFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });

      transport.connect(() => {});
      expect(sockets).toHaveLength(1);

      const first = sockets[0];
      expect(first).toBeDefined();
      if (!first) {
        return;
      }

      first.readyState = 1;
      first.onopen?.();

      first.readyState = 3;
      first.onclose?.();

      const queuedPayload = Uint8Array.from([4, 5, 6]);
      transport.send(queuedPayload);

      vi.advanceTimersByTime(250);
      expect(sockets).toHaveLength(2);

      const second = sockets[1];
      expect(second).toBeDefined();
      if (!second) {
        return;
      }

      second.readyState = 1;
      second.onopen?.();
      expect(second.sent).toEqual([queuedPayload]);
    } finally {
      vi.useRealTimers();
    }
  });
});
