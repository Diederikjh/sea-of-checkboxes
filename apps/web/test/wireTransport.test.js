import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMockTransport: vi.fn(() => ({ mode: "mock" })),
  createWebSocketTransport: vi.fn(() => ({ mode: "ws" })),
  loggerOther: vi.fn(),
}));

vi.mock("../src/mockTransport", () => ({
  createMockTransport: mocks.createMockTransport,
}));

vi.mock("../src/webSocketTransport", () => ({
  createWebSocketTransport: mocks.createWebSocketTransport,
}));

vi.mock("../src/logger", () => ({
  logger: {
    other: mocks.loggerOther,
  },
}));

import { createWireTransport } from "../src/wireTransport";

describe("wire transport selection", () => {
  beforeEach(() => {
    mocks.createMockTransport.mockClear();
    mocks.createWebSocketTransport.mockClear();
    mocks.loggerOther.mockClear();
  });

  it("uses websocket transport by default", () => {
    const transport = createWireTransport({
      env: {},
      locationLike: {
        protocol: "http:",
        host: "localhost:5173",
      },
    });

    expect(transport).toEqual({ mode: "ws" });
    expect(mocks.createWebSocketTransport).toHaveBeenCalledTimes(1);
    expect(mocks.createWebSocketTransport).toHaveBeenCalledWith(
      "ws://127.0.0.1:8787/ws",
      expect.any(Object)
    );
    expect(mocks.createMockTransport).not.toHaveBeenCalled();
  });

  it("uses mock transport when VITE_USE_MOCK is enabled", () => {
    const transport = createWireTransport({
      env: { VITE_USE_MOCK: "1" },
      locationLike: {
        protocol: "http:",
        host: "localhost:5173",
      },
    });

    expect(transport).toEqual({ mode: "mock" });
    expect(mocks.createMockTransport).toHaveBeenCalledTimes(1);
    expect(mocks.createWebSocketTransport).not.toHaveBeenCalled();
  });

  it("uses explicit websocket url from env override", () => {
    createWireTransport({
      env: { VITE_WS_URL: "ws://127.0.0.1:8787/ws" },
      locationLike: {
        protocol: "http:",
        host: "localhost:5173",
      },
    });

    expect(mocks.createWebSocketTransport).toHaveBeenCalledWith(
      "ws://127.0.0.1:8787/ws",
      expect.any(Object)
    );
  });
});
