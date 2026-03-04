import { describe, expect, it, vi } from "vitest";

import {
  bootstrapAuthSession,
  removeGoogleLinkFromSession,
  signInWithGoogleSession,
} from "../src/auth/bootstrap";

describe("auth bootstrap orchestration", () => {
  it("exchanges firebase assertion with legacy token and persists app session", async () => {
    const writeStoredIdentity = vi.fn();
    const exchange = vi.fn().mockResolvedValue({
      uid: "u_saved123",
      name: "BriskOtter001",
      token: "tok_next",
      migration: "linked_legacy",
    });

    const result = await bootstrapAuthSession({
      identityProvider: {
        initAnonymousSession: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_1", isAnonymous: true }),
        getAssertionToken: vi.fn().mockResolvedValue("firebase-id-token"),
        linkGoogle: vi.fn(),
        unlinkGoogle: vi.fn(),
        signOut: vi.fn(),
      },
      sessionExchangeClient: {
        exchange,
      },
      readStoredIdentity: () => ({ uid: "u_saved123", name: "BriskOtter001", token: "tok_legacy" }),
      writeStoredIdentity,
    });

    expect(exchange).toHaveBeenCalledWith(
      {
        provider: "firebase",
        idToken: "firebase-id-token",
      },
      "tok_legacy"
    );
    expect(writeStoredIdentity).toHaveBeenCalledWith({
      uid: "u_saved123",
      name: "BriskOtter001",
      token: "tok_next",
    });
    expect(result.usedLegacyFallback).toBe(false);
    expect(result.migration).toBe("linked_legacy");
  });

  it("provisions session when legacy token is missing", async () => {
    const exchange = vi.fn().mockResolvedValue({
      uid: "u_new123",
      name: "MintFox123",
      token: "tok_new",
      migration: "provisioned",
    });

    const result = await bootstrapAuthSession({
      identityProvider: {
        initAnonymousSession: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_2", isAnonymous: true }),
        getAssertionToken: vi.fn().mockResolvedValue("firebase-id-token"),
        linkGoogle: vi.fn(),
        unlinkGoogle: vi.fn(),
        signOut: vi.fn(),
      },
      sessionExchangeClient: {
        exchange,
      },
      readStoredIdentity: () => null,
      writeStoredIdentity: vi.fn(),
    });

    expect(exchange).toHaveBeenCalledWith(
      {
        provider: "firebase",
        idToken: "firebase-id-token",
      },
      ""
    );
    expect(result.migration).toBe("provisioned");
    expect(result.session.uid).toBe("u_new123");
  });

  it("preserves uid across google sign-in", async () => {
    const identityProvider = {
      initAnonymousSession: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_3", isAnonymous: true }),
      getAssertionToken: vi.fn().mockResolvedValue("firebase-id-token-google"),
      linkGoogle: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_3", isAnonymous: false }),
      unlinkGoogle: vi.fn(),
      signOut: vi.fn(),
    };

    const exchange = vi.fn().mockResolvedValue({
      uid: "u_saved123",
      name: "BriskOtter001",
      token: "tok_new",
      migration: "none",
    });

    const result = await signInWithGoogleSession({
      identityProvider,
      sessionExchangeClient: { exchange },
      readStoredIdentity: () => ({ uid: "u_saved123", name: "BriskOtter001", token: "tok_old" }),
      writeStoredIdentity: vi.fn(),
    });

    expect(identityProvider.linkGoogle).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith(
      {
        provider: "firebase",
        idToken: "firebase-id-token-google",
      },
      "tok_old"
    );
    expect(identityProvider.getAssertionToken).toHaveBeenCalledWith(true);
    expect(result.session.uid).toBe("u_saved123");
  });

  it("falls back to legacy token in hybrid mode when exchange fails", async () => {
    const result = await bootstrapAuthSession({
      identityProvider: {
        initAnonymousSession: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_4", isAnonymous: true }),
        getAssertionToken: vi.fn().mockResolvedValue("firebase-id-token"),
        linkGoogle: vi.fn(),
        unlinkGoogle: vi.fn(),
        signOut: vi.fn(),
      },
      sessionExchangeClient: {
        exchange: vi.fn().mockRejectedValue(new Error("service unavailable")),
      },
      readStoredIdentity: () => ({ uid: "u_saved123", name: "BriskOtter001", token: "tok_old" }),
      writeStoredIdentity: vi.fn(),
      allowLegacyFallback: true,
    });

    expect(result.usedLegacyFallback).toBe(true);
    expect(result.session.token).toBe("tok_old");
  });

  it("preserves uid after unlinking google from current firebase user", async () => {
    const identityProvider = {
      initAnonymousSession: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_3", isAnonymous: true }),
      getAssertionToken: vi.fn().mockResolvedValue("firebase-id-token-anon"),
      linkGoogle: vi.fn(),
      unlinkGoogle: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_3", isAnonymous: true }),
      signOut: vi.fn(),
    };

    const exchange = vi.fn().mockResolvedValue({
      uid: "u_saved123",
      name: "BriskOtter001",
      token: "tok_after_unlink",
      migration: "none",
    });

    const result = await removeGoogleLinkFromSession({
      identityProvider,
      sessionExchangeClient: { exchange },
      readStoredIdentity: () => ({ uid: "u_saved123", name: "BriskOtter001", token: "tok_old" }),
      writeStoredIdentity: vi.fn(),
    });

    expect(identityProvider.unlinkGoogle).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith(
      {
        provider: "firebase",
        idToken: "firebase-id-token-anon",
      },
      "tok_old"
    );
    expect(identityProvider.getAssertionToken).toHaveBeenCalledWith(true);
    expect(result.session.uid).toBe("u_saved123");
  });

  it("does not use legacy fallback during provider relink refresh", async () => {
    const exchangeError = new Error("service unavailable");
    const identityProvider = {
      initAnonymousSession: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_7", isAnonymous: false }),
      getAssertionToken: vi.fn().mockResolvedValue("firebase-id-token-google"),
      linkGoogle: vi.fn().mockResolvedValue({ provider: "firebase", providerUserId: "f_7", isAnonymous: false }),
      unlinkGoogle: vi.fn(),
      signOut: vi.fn(),
    };

    await expect(
      signInWithGoogleSession({
        identityProvider,
        sessionExchangeClient: {
          exchange: vi.fn().mockRejectedValue(exchangeError),
        },
        readStoredIdentity: () => ({ uid: "u_saved123", name: "BriskOtter001", token: "tok_old" }),
        writeStoredIdentity: vi.fn(),
      })
    ).rejects.toBe(exchangeError);
  });
});
