import { describe, expect, it, vi } from "vitest";

import {
  buildDebugLoggingHeaders,
  buildDebugLoggingQueryParams,
  resolveDebugCategoryOverrides,
  resolveDebugLoggingState,
} from "../src/debugLogging";

function createStorage() {
  const values = new Map();
  return {
    getItem: vi.fn((key) => (values.has(key) ? values.get(key) : null)),
    setItem: vi.fn((key, value) => {
      values.set(key, String(value));
    }),
    removeItem: vi.fn((key) => {
      values.delete(key);
    }),
  };
}

describe("debug logging state", () => {
  it("persists reduced debug logging and expires after fifteen minutes", () => {
    const storage = createStorage();
    const initial = resolveDebugLoggingState({
      locationLike: { search: "?debug_logs=reduced" },
      storage,
      nowMs: () => 1_000,
    });

    expect(initial).toEqual({
      level: "reduced",
      expiresAtMs: 901_000,
      source: "url",
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    const beforeExpiry = resolveDebugLoggingState({
      locationLike: { search: "" },
      storage,
      nowMs: () => 900_999,
    });
    expect(beforeExpiry).toEqual({
      level: "reduced",
      expiresAtMs: 901_000,
      source: "storage",
    });

    const afterExpiry = resolveDebugLoggingState({
      locationLike: { search: "" },
      storage,
      nowMs: () => 901_001,
    });
    expect(afterExpiry).toEqual({
      level: "off",
      expiresAtMs: null,
      source: "expired",
      expiredState: {
        level: "reduced",
        expiresAtMs: 901_000,
      },
    });
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
  });

  it("clears stored debug logging when off is requested", () => {
    const storage = createStorage();
    storage.setItem("sea_debug_logging", JSON.stringify({
      level: "reduced",
      expiresAtMs: 2000,
    }));

    const resolved = resolveDebugLoggingState({
      locationLike: { search: "?debug_logs=off" },
      storage,
      nowMs: () => 1000,
    });

    expect(resolved).toEqual({
      level: "off",
      expiresAtMs: null,
      source: "url",
    });
    expect(storage.removeItem).toHaveBeenCalledWith("sea_debug_logging");
  });

  it("recognizes the debug alias for client categories", () => {
    expect(resolveDebugCategoryOverrides({ locationLike: { search: "?debug=1" } })).toEqual({
      debugEnabled: true,
    });
    expect(resolveDebugCategoryOverrides({ locationLike: { search: "?debug=0" } })).toEqual({
      debugEnabled: false,
    });
  });

  it("builds request metadata for websocket and auth requests", () => {
    const state = {
      level: "verbose",
      expiresAtMs: 123456789,
    };

    expect(buildDebugLoggingQueryParams(state)).toEqual({
      debugLogs: "verbose",
      debugLogsExpiresAtMs: "123456789",
    });
    expect(buildDebugLoggingHeaders(state)).toEqual({
      "x-debug-logs": "verbose",
      "x-debug-logs-expires-at-ms": "123456789",
    });
  });
});
