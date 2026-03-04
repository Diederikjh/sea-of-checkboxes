import { describe, expect, it, vi } from "vitest";

import {
  signInWithGoogleSessionTransition,
  signOutToAnonymousSessionTransition,
} from "../src/auth/sessionSwitcher";

describe("auth session switcher", () => {
  it("signs in with google and reloads", async () => {
    const signInWithGoogleSessionFn = vi.fn().mockResolvedValue({
      session: {
        uid: "u_google",
        name: "BriskOtter001",
        token: "tok_google",
      },
      migration: "none",
      usedLegacyFallback: false,
    });
    const setStatus = vi.fn();
    const reloadPage = vi.fn();

    const result = await signInWithGoogleSessionTransition({
      identityProvider: {
        initAnonymousSession: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_1", isAnonymous: true }),
      },
      sessionExchangeClient: {},
      readStoredIdentity: vi.fn(),
      writeStoredIdentity: vi.fn(),
      setStatus,
      logOther: vi.fn(),
      errorLogger: { error: vi.fn() },
      reloadPage,
      signInWithGoogleSessionFn,
    });

    expect(result).toEqual({ ok: true });
    expect(signInWithGoogleSessionFn).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("Signing in with Google...");
    expect(setStatus).toHaveBeenCalledWith("Signed in with Google. Reloading...");
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("always provisions a fresh anonymous app session on sign out", async () => {
    const writeStoredIdentity = vi.fn();
    const bootstrapAuthSessionFn = vi.fn().mockResolvedValue({
      session: {
        uid: "u_new_guest",
        name: "BriskOtter001",
        token: "tok_new_guest",
      },
      migration: "provisioned",
      usedLegacyFallback: false,
    });
    const reloadPage = vi.fn();

    const result = await signOutToAnonymousSessionTransition({
      identityProvider: {
        signOut: vi.fn().mockResolvedValue(undefined),
        initAnonymousSession: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_new", isAnonymous: true }),
      },
      sessionExchangeClient: {},
      writeStoredIdentity,
      setStatus: vi.fn(),
      logOther: vi.fn(),
      errorLogger: { error: vi.fn() },
      reloadPage,
      bootstrapAuthSessionFn,
    });

    expect(result).toEqual({
      ok: true,
      uid: "u_new_guest",
    });
    expect(bootstrapAuthSessionFn).toHaveBeenCalledWith({
      identityProvider: expect.any(Object),
      sessionExchangeClient: expect.any(Object),
      readStoredIdentity: expect.any(Function),
      writeStoredIdentity: expect.any(Function),
      allowLegacyFallback: false,
      forceRefresh: true,
    });
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("reports google sign-in failures without reloading", async () => {
    const setStatus = vi.fn();
    const logOther = vi.fn();
    const errorLogger = { error: vi.fn() };
    const reloadPage = vi.fn();

    const result = await signInWithGoogleSessionTransition({
      identityProvider: {
        initAnonymousSession: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_1", isAnonymous: true }),
      },
      sessionExchangeClient: {},
      readStoredIdentity: vi.fn().mockReturnValue(null),
      writeStoredIdentity: vi.fn(),
      setStatus,
      logOther,
      errorLogger,
      reloadPage,
      signInWithGoogleSessionFn: vi.fn().mockRejectedValue(new Error("auth unavailable")),
    });

    expect(result).toEqual({
      ok: false,
      error: "auth unavailable",
    });
    expect(logOther).toHaveBeenCalledWith("auth google_signin_failed", {
      error: "auth unavailable",
    });
    expect(setStatus).toHaveBeenCalledWith("Google sign-in failed. auth unavailable");
    expect(reloadPage).not.toHaveBeenCalled();
  });
});
