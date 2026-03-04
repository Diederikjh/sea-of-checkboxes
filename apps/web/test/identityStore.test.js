import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  clearStoredAnonymousIdentity,
  normalizeStoredIdentity,
  readStoredAnonymousIdentity,
  readStoredIdentity,
  writeStoredIdentity,
  writeStoredAnonymousIdentity,
} from "../src/identityStore";

const AUTH_STATE_KEY = "sea.auth-state.v1";
const LEGACY_IDENTITY_KEY = "sea.identity.v2";
const LEGACY_ANONYMOUS_KEY = "sea.identity.anon.v1";

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
    removeItem(key) {
      data.delete(key);
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
      [AUTH_STATE_KEY]: "{",
      [LEGACY_IDENTITY_KEY]: "{",
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
    expect(sessionStorage.getItem(AUTH_STATE_KEY)).not.toBeNull();
    expect(localStorage.getItem(AUTH_STATE_KEY)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("prefers session auth state over local storage", () => {
    const sessionStorage = createStorage();
    const localStorage = createStorage();
    vi.stubGlobal("window", {
      sessionStorage,
      localStorage,
    });

    sessionStorage.setItem(AUTH_STATE_KEY, JSON.stringify({
      active: { uid: "u_session", name: "BriskOtter481", token: "tok_session" },
      anonymousBackup: null,
    }));
    localStorage.setItem(AUTH_STATE_KEY, JSON.stringify({
      active: { uid: "u_local", name: "MintStoat111", token: "tok_local" },
      anonymousBackup: null,
    }));

    expect(readStoredIdentity()).toEqual({
      uid: "u_session",
      name: "BriskOtter481",
      token: "tok_session",
    });
    vi.unstubAllGlobals();
  });

  it("stores active and anonymous identities in a single auth-state record", () => {
    const storage = createStorage();
    const primaryIdentity = { uid: "u_primary", name: "BriskOtter481", token: "tok_primary" };
    const anonymousIdentity = { uid: "u_guest", name: "MintStoat111", token: "tok_guest" };

    expect(writeStoredIdentity(primaryIdentity, { storage })).toBe(true);
    expect(writeStoredAnonymousIdentity(anonymousIdentity, { storage })).toBe(true);

    expect(readStoredIdentity({ storage })).toEqual(primaryIdentity);
    expect(readStoredAnonymousIdentity({ storage })).toEqual(anonymousIdentity);
    expect(JSON.parse(storage.getItem(AUTH_STATE_KEY))).toEqual({
      active: primaryIdentity,
      anonymousBackup: anonymousIdentity,
    });

    expect(clearStoredAnonymousIdentity({ storage })).toBe(true);
    expect(readStoredAnonymousIdentity({ storage })).toBeNull();
    expect(readStoredIdentity({ storage })).toEqual(primaryIdentity);
    expect(JSON.parse(storage.getItem(AUTH_STATE_KEY))).toEqual({
      active: primaryIdentity,
      anonymousBackup: null,
    });
  });

  it("reads legacy split keys when consolidated auth state is missing", () => {
    const storage = createStorage({
      [LEGACY_IDENTITY_KEY]: JSON.stringify({ uid: "u_legacy", name: "BriskOtter481", token: "tok_legacy" }),
      [LEGACY_ANONYMOUS_KEY]: JSON.stringify({ uid: "u_guest", name: "MintStoat111", token: "tok_guest" }),
    });

    expect(readStoredIdentity({ storage })).toEqual({
      uid: "u_legacy",
      name: "BriskOtter481",
      token: "tok_legacy",
    });
    expect(readStoredAnonymousIdentity({ storage })).toEqual({
      uid: "u_guest",
      name: "MintStoat111",
      token: "tok_guest",
    });
  });

  it("migrates legacy keys into consolidated auth state on write", () => {
    const storage = createStorage({
      [LEGACY_IDENTITY_KEY]: JSON.stringify({ uid: "u_legacy", name: "BriskOtter481", token: "tok_legacy" }),
      [LEGACY_ANONYMOUS_KEY]: JSON.stringify({ uid: "u_guest", name: "MintStoat111", token: "tok_guest" }),
    });

    expect(
      writeStoredIdentity({ uid: "u_active", name: "SilverOtter999", token: "tok_active" }, { storage })
    ).toBe(true);

    expect(storage.getItem(LEGACY_IDENTITY_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_ANONYMOUS_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(AUTH_STATE_KEY))).toEqual({
      active: { uid: "u_active", name: "SilverOtter999", token: "tok_active" },
      anonymousBackup: { uid: "u_guest", name: "MintStoat111", token: "tok_guest" },
    });
  });
});
