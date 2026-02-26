import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
    expect(
      writeStoredIdentity(
        { uid: "u_saved123", name: "BriskOtter481", token: "x".repeat(2_049) },
        { storage }
      )
    ).toBe(false);
    expect(readStoredIdentity({ storage })).toBeNull();
  });

  it("returns null for malformed json", () => {
    const storage = createStorage({
      "sea.identity.v2": "{",
    });
    expect(readStoredIdentity({ storage })).toBeNull();
  });

  it("normalizes identity payloads", () => {
    expect(
      normalizeStoredIdentity({ uid: " u_saved123 ", name: " BriskOtter481 ", token: " tok_abc " })
    ).toEqual({
      uid: "u_saved123",
      name: "BriskOtter481",
      token: "tok_abc",
    });
    expect(normalizeStoredIdentity({ uid: "u_saved123", name: "bad name", token: "tok_abc" })).toBeNull();
    expect(normalizeStoredIdentity({ uid: "u_saved123", name: "BriskOtter481" })).toBeNull();
    expect(normalizeStoredIdentity({ uid: "u_saved123", name: "BriskOtter481", token: "x".repeat(2_049) })).toBeNull();
  });

  it("uses session storage by default", () => {
    const key = "sea.identity.v2";
    const sessionStorage = createStorage();
    const localStorage = createStorage();
    vi.stubGlobal("window", {
      sessionStorage,
      localStorage,
    });

    expect(
      writeStoredIdentity({ uid: "u_saved123", name: "BriskOtter481", token: "tok_session" })
    ).toBe(true);

    expect(readStoredIdentity()).toEqual({
      uid: "u_saved123",
      name: "BriskOtter481",
      token: "tok_session",
    });
    expect(sessionStorage.getItem(key)).not.toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("prefers session identity over legacy local storage", () => {
    const key = "sea.identity.v2";
    const sessionStorage = createStorage();
    const localStorage = createStorage();
    vi.stubGlobal("window", {
      sessionStorage,
      localStorage,
    });

    sessionStorage.setItem(
      key,
      JSON.stringify({ uid: "u_session", name: "BriskOtter481", token: "tok_session" })
    );
    localStorage.setItem(
      key,
      JSON.stringify({ uid: "u_local", name: "MintStoat111", token: "tok_local" })
    );

    expect(readStoredIdentity()).toEqual({
      uid: "u_session",
      name: "BriskOtter481",
      token: "tok_session",
    });
    vi.unstubAllGlobals();
  });
});
