import { describe, expect, it } from "vitest";

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
});

