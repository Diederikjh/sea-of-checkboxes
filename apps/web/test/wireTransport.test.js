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

  it("includes identity query params when identity provider returns one", () => {
    createWireTransport({
      env: {},
      locationLike: {
        protocol: "https:",
        host: "example.com",
      },
      clientSessionId: "web_session_1",
      identityProvider: () => ({
        uid: "u_saved123",
        name: "BriskOtter481",
        token: "tok_abc",
      }),
    });

    const wsUrl = mocks.createWebSocketTransport.mock.calls[0]?.[0];
    expect(wsUrl).toBe("wss://example.com/ws?token=tok_abc&clientSessionId=web_session_1");
    const parsed = new URL(wsUrl);
    expect(parsed.searchParams.has("uid")).toBe(false);
    expect(parsed.searchParams.has("name")).toBe(false);
  });

  it("re-resolves websocket url from identity provider", () => {
    let currentIdentity = null;
    createWireTransport({
      env: {},
      locationLike: {
        protocol: "https:",
        host: "example.com",
      },
      clientSessionId: "web_session_2",
      identityProvider: () => currentIdentity,
    });

    const options = mocks.createWebSocketTransport.mock.calls[0]?.[1];
    expect(options.resolveUrl()).toBe("wss://example.com/ws?clientSessionId=web_session_2");

    currentIdentity = {
      uid: "u_saved123",
      name: "BriskOtter481",
      token: "tok_abc",
    };
    expect(options.resolveUrl()).toBe("wss://example.com/ws?token=tok_abc&clientSessionId=web_session_2");
  });

  it("passes debug logging parameters through websocket url resolution", () => {
    createWireTransport({
      env: {},
      locationLike: {
        protocol: "https:",
        host: "example.com",
      },
      clientSessionId: "web_session_3",
      debugLoggingState: {
        level: "reduced",
        expiresAtMs: 123456789,
      },
    });

    const wsUrl = mocks.createWebSocketTransport.mock.calls[0]?.[0];
    const parsed = new URL(wsUrl);
    expect(parsed.searchParams.get("clientSessionId")).toBe("web_session_3");
    expect(parsed.searchParams.get("debugLogs")).toBe("reduced");
    expect(parsed.searchParams.get("debugLogsExpiresAtMs")).toBe("123456789");
  });
});
