import { describe, expect, it } from "vitest";

import { normalizeStoredIdentity, readStoredIdentity, writeStoredIdentity } from "../src/identityStore";

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

describe("identity storage", () => {
  it("writes and reads valid identity payloads", () => {
    const storage = createStorage();

    expect(
      writeStoredIdentity(
        { uid: "u_saved123", name: "BriskOtter481", token: "tok_valid" },
        { storage }
      )
    ).toBe(true);
    expect(readStoredIdentity({ storage })).toEqual({
      uid: "u_saved123",
      name: "BriskOtter481",
      token: "tok_valid",
    });
  });

  it("rejects invalid payloads", () => {
    const storage = createStorage();

    expect(writeStoredIdentity({ uid: "u_saved123", name: "bad name", token: "tok" }, { storage })).toBe(false);
    expect(writeStoredIdentity({ uid: "u_saved123", name: "BriskOtter481" }, { storage })).toBe(false);
    expect(readStoredIdentity({ storage })).toBeNull();
  });

  it("returns null for malformed json", () => {
    const storage = createStorage({
      "sea.identity.v2": "{",
    });
    expect(readStoredIdentity({ storage })).toBeNull();
  });

  it("normalizes identity payloads", () => {
    expect(normalizeStoredIdentity({ uid: "u_saved123", name: "BriskOtter481", token: " tok_abc " })).toEqual({
      uid: "u_saved123",
      name: "BriskOtter481",
      token: "tok_abc",
    });
    expect(normalizeStoredIdentity({ uid: "u_saved123", name: "bad name", token: "tok_abc" })).toBeNull();
    expect(normalizeStoredIdentity({ uid: "u_saved123", name: "BriskOtter481" })).toBeNull();
  });
});
