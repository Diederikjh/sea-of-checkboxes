import { describe, expect, it, vi } from "vitest";

import { createTransportRuntime } from "../src/transportRuntime";

function createRuntime({ onlineOnConnect = true } = {}) {
  let onPayload = null;
  let lifecycle = null;
  const wireTransport = {
    connect: vi.fn((handler, hooks) => {
      onPayload = handler;
      lifecycle = hooks;
      if (onlineOnConnect) {
        hooks.onOpen({ reconnected: false });
      }
    }),
    send: vi.fn(),
    dispose: vi.fn(),
  };

  const outbox = {
    trackOutgoingClientMessage: vi.fn(),
    handleServerMessage: vi.fn(),
    handleConnectionOpen: vi.fn(),
  };

  const runtime = createTransportRuntime({
    wireTransport,
    perfProbe: {
      measure: (_key, fn) => fn(),
      increment: vi.fn(),
    },
    perfCounter: {
      WS_TX_COUNT: "tx_count",
      WS_TX_BYTES: "tx_bytes",
      WS_RX_COUNT: "rx_count",
      WS_RX_BYTES: "rx_bytes",
    },
    perfTiming: {
      PROTOCOL_ENCODE_MS: "encode",
      PROTOCOL_DECODE_MS: "decode",
    },
    encodeClientMessage: (message) => new Uint8Array([message.t.length]),
    decodeServerMessage: () => ({ t: "hello", uid: "u_1", name: "User" }),
    protocolLogsEnabled: false,
    logger: { protocol: vi.fn(), other: vi.fn() },
    describePayload: vi.fn(() => ({})),
    summarizeMessage: vi.fn(() => ({})),
    setCellOutboxSync: outbox,
  });

  return { runtime, wireTransport, outbox, getLifecycle: () => lifecycle, emitPayload: () => onPayload?.(new Uint8Array([1])) };
}

describe("transportRuntime", () => {
  it("does not send cursor messages while offline", () => {
    const { runtime, wireTransport, outbox } = createRuntime({ onlineOnConnect: false });

    runtime.send({ t: "cur", x: 1, y: 2 });

    expect(wireTransport.send).not.toHaveBeenCalled();
    expect(outbox.trackOutgoingClientMessage).not.toHaveBeenCalled();
  });

  it("tracks outbound setCell and forwards payload once connected", () => {
    const { runtime, wireTransport, outbox } = createRuntime();

    runtime.send({ t: "setCell", tile: "0:0", i: 1, v: 1, op: "op_1" });

    expect(outbox.trackOutgoingClientMessage).toHaveBeenCalledTimes(1);
    expect(wireTransport.send).toHaveBeenCalledTimes(1);
  });

  it("handles wire connect lifecycle events", () => {
    const { runtime, outbox, getLifecycle, emitPayload } = createRuntime({ onlineOnConnect: false });
    const onServerMessage = vi.fn();
    const onOpen = vi.fn();
    const onClose = vi.fn();

    runtime.connect(onServerMessage, { onOpen, onClose });
    getLifecycle().onOpen({ reconnected: true });

    expect(outbox.handleConnectionOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith({ reconnected: true });

    emitPayload();
    expect(outbox.handleServerMessage).toHaveBeenCalledTimes(1);
    expect(onServerMessage).toHaveBeenCalledTimes(1);

    getLifecycle().onClose({ disposed: false });
    expect(onClose).toHaveBeenCalledWith({ disposed: false });
  });
});
