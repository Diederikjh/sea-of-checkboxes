import { describe, expect, it, vi } from "vitest";

import {
  signInWithGoogleSessionTransition,
  signOutToAnonymousSessionTransition,
} from "../src/auth/sessionSwitcher";

describe("auth session switcher", () => {
  it("captures anonymous app identity before google sign-in and reloads", async () => {
    const writeStoredAnonymousIdentity = vi.fn();
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
      readStoredIdentity: () => ({ uid: "u_guest", name: "MintFox123", token: "tok_guest" }),
      writeStoredIdentity: vi.fn(),
      readStoredAnonymousIdentity: () => null,
      writeStoredAnonymousIdentity,
      setStatus,
      logOther: vi.fn(),
      errorLogger: { error: vi.fn() },
      reloadPage,
      signInWithGoogleSessionFn,
    });

    expect(result).toEqual({ ok: true });
    expect(writeStoredAnonymousIdentity).toHaveBeenCalledWith({
      uid: "u_guest",
      name: "MintFox123",
      token: "tok_guest",
    });
    expect(signInWithGoogleSessionFn).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("Signing in with Google...");
    expect(setStatus).toHaveBeenCalledWith("Signed in with Google. Reloading...");
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("restores saved anonymous identity on sign out", async () => {
    const writeStoredIdentity = vi.fn();
    const bootstrapAuthSessionFn = vi.fn();
    const reloadPage = vi.fn();

    const result = await signOutToAnonymousSessionTransition({
      identityProvider: {
        signOut: vi.fn().mockResolvedValue(undefined),
        initAnonymousSession: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_new", isAnonymous: true }),
      },
      sessionExchangeClient: {},
      writeStoredIdentity,
      readStoredAnonymousIdentity: () => ({ uid: "u_guest", name: "MintFox123", token: "tok_guest" }),
      writeStoredAnonymousIdentity: vi.fn(),
      setStatus: vi.fn(),
      logOther: vi.fn(),
      errorLogger: { error: vi.fn() },
      reloadPage,
      bootstrapAuthSessionFn,
    });

    expect(result).toEqual({
      ok: true,
      restoredAnonymousIdentity: true,
    });
    expect(writeStoredIdentity).toHaveBeenCalledWith({
      uid: "u_guest",
      name: "MintFox123",
      token: "tok_guest",
    });
    expect(bootstrapAuthSessionFn).not.toHaveBeenCalled();
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("provisions and stores anonymous identity on sign out when no backup exists", async () => {
    const writeStoredAnonymousIdentity = vi.fn();
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
      sessionExchangeClient: { exchange: vi.fn() },
      writeStoredIdentity: vi.fn(),
      readStoredAnonymousIdentity: () => null,
      writeStoredAnonymousIdentity,
      setStatus: vi.fn(),
      logOther: vi.fn(),
      errorLogger: { error: vi.fn() },
      reloadPage,
      bootstrapAuthSessionFn,
    });

    expect(result).toEqual({
      ok: true,
      restoredAnonymousIdentity: false,
    });
    expect(bootstrapAuthSessionFn).toHaveBeenCalledWith({
      identityProvider: expect.any(Object),
      sessionExchangeClient: expect.any(Object),
      readStoredIdentity: expect.any(Function),
      writeStoredIdentity: expect.any(Function),
      allowLegacyFallback: false,
      forceRefresh: true,
    });
    expect(writeStoredAnonymousIdentity).toHaveBeenCalledWith({
      uid: "u_new_guest",
      name: "BriskOtter001",
      token: "tok_new_guest",
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
      readStoredAnonymousIdentity: vi.fn().mockReturnValue(null),
      writeStoredAnonymousIdentity: vi.fn(),
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
