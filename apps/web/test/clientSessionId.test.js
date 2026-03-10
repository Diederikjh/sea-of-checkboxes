import { describe, expect, it, vi } from "vitest";

import { resolveClientSessionId } from "../src/clientSessionId";

describe("client session id", () => {
  it("reuses the stored session id", () => {
    const storage = {
      getItem: vi.fn(() => "web_existing"),
      setItem: vi.fn(),
    };

    expect(resolveClientSessionId({ storage, cryptoLike: null })).toBe("web_existing");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("creates and stores a session id when missing", () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    };
    const cryptoLike = {
      randomUUID: vi.fn(() => "12345678-1234-1234-1234-123456789abc"),
    };

    expect(resolveClientSessionId({ storage, cryptoLike })).toBe("web_12345678-1234-1234-1234-123456789abc");
    expect(storage.setItem).toHaveBeenCalledWith(
      "sea_client_session_id",
      "web_12345678-1234-1234-1234-123456789abc"
    );
  });
});
