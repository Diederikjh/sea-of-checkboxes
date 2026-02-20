import { describe, expect, it } from "vitest";

import { isValidIdentity, readStoredIdentity, writeStoredIdentity } from "../src/identityStore";

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

    expect(writeStoredIdentity({ uid: "u_saved123", name: "BriskOtter481" }, { storage })).toBe(true);
    expect(readStoredIdentity({ storage })).toEqual({
      uid: "u_saved123",
      name: "BriskOtter481",
    });
  });

  it("rejects invalid payloads", () => {
    const storage = createStorage();

    expect(writeStoredIdentity({ uid: "u_saved123", name: "bad name" }, { storage })).toBe(false);
    expect(readStoredIdentity({ storage })).toBeNull();
  });

  it("returns null for malformed json", () => {
    const storage = createStorage({
      "sea.identity.v1": "{",
    });
    expect(readStoredIdentity({ storage })).toBeNull();
  });

  it("validates identity helper", () => {
    expect(isValidIdentity({ uid: "u_saved123", name: "BriskOtter481" })).toBe(true);
    expect(isValidIdentity({ uid: "u_saved123", name: "bad name" })).toBe(false);
  });
});
