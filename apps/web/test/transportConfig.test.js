import { describe, expect, it } from "vitest";

import { isMockTransportEnabled, resolveApiBaseUrl, resolveWebSocketUrl } from "../src/transportConfig";

describe("transport config", () => {
  it("enables mock transport from env flag", () => {
    expect(isMockTransportEnabled({ VITE_USE_MOCK: "1" })).toBe(true);
    expect(isMockTransportEnabled({ VITE_USE_MOCK: "true" })).toBe(true);
    expect(isMockTransportEnabled({ VITE_USE_MOCK: "0" })).toBe(false);
    expect(isMockTransportEnabled({})).toBe(false);
  });

  it("resolves ws url from explicit env first", () => {
    const url = resolveWebSocketUrl(
      { protocol: "http:", host: "localhost:5173" },
      { VITE_WS_URL: "ws://127.0.0.1:8787/ws" }
    );

    expect(url).toBe("ws://127.0.0.1:8787/ws");
  });

  it("derives ws url from browser location", () => {
    expect(
      resolveWebSocketUrl(
        { protocol: "http:", host: "localhost:5173" },
        {}
      )
    ).toBe("ws://127.0.0.1:8787/ws");

    expect(
      resolveWebSocketUrl(
        { protocol: "http:", host: "127.0.0.1:5173" },
        {}
      )
    ).toBe("ws://127.0.0.1:8787/ws");

    expect(
      resolveWebSocketUrl(
        { protocol: "https:", host: "example.com" },
        {}
      )
    ).toBe("wss://example.com/ws");
  });

  it("falls back to local worker ws url when location is unavailable", () => {
    expect(resolveWebSocketUrl(undefined, {})).toBe("ws://127.0.0.1:8787/ws");
  });

  it("appends persisted identity to websocket url", () => {
    expect(
      resolveWebSocketUrl(
        { protocol: "https:", host: "example.com" },
        {},
        { uid: "u_saved123", name: "BriskOtter481" }
      )
    ).toBe("wss://example.com/ws?uid=u_saved123&name=BriskOtter481");
  });

  it("ignores invalid identity when building websocket url", () => {
    expect(
      resolveWebSocketUrl(
        { protocol: "https:", host: "example.com" },
        {},
        { uid: "u_saved123", name: "bad name" }
      )
    ).toBe("wss://example.com/ws");
  });

  it("derives api base url from websocket url rules", () => {
    expect(
      resolveApiBaseUrl(
        { protocol: "http:", host: "localhost:5173" },
        {}
      )
    ).toBe("http://127.0.0.1:8787");

    expect(
      resolveApiBaseUrl(
        { protocol: "https:", host: "example.com" },
        {}
      )
    ).toBe("https://example.com");
  });

  it("uses explicit api base env override", () => {
    expect(
      resolveApiBaseUrl(
        { protocol: "https:", host: "example.com" },
        { VITE_API_BASE_URL: "https://api.example.com/" }
      )
    ).toBe("https://api.example.com");
  });
});
