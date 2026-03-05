import { describe, expect, it, vi } from "vitest";

import { FirebaseIdTokenVerifier } from "../src/auth/firebaseIdTokenVerifier";

function toBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeToken(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "kid_1" }) {
  return `${toBase64Url(header)}.${toBase64Url(payload)}.c2ln`;
}

describe("FirebaseIdTokenVerifier", () => {
  it("calls subtle.importKey with the correct invocation context", async () => {
    const originalImportKey = crypto.subtle.importKey;
    let observedThis: unknown = null;
    const importKeySpy = vi.spyOn(crypto.subtle, "importKey").mockImplementation(function (
      this: SubtleCrypto,
      ...args
    ) {
      observedThis = this;
      return (originalImportKey as unknown as (...callArgs: unknown[]) => Promise<CryptoKey>).apply(
        crypto.subtle,
        args as unknown[]
      );
    });

    const verifier = new FirebaseIdTokenVerifier({
      projectId: "project-1",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            keys: [
              {
                kid: "kid_ctx",
                kty: "RSA",
                // Intentionally simple payload: we only need to pass importKey invocation.
                n: "invalid-key-material",
                e: "AQAB",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "max-age=60",
            },
          }
        ),
    });

    try {
      const token = makeToken({
        iss: "https://securetoken.google.com/project-1",
        aud: "project-1",
        sub: "firebase-user-importkey-this",
        exp: Math.floor(Date.now() / 1000) + 3600,
        firebase: { sign_in_provider: "anonymous" },
      }, {
        alg: "RS256",
        kid: "kid_ctx",
      });

      await expect(verifier.verify({ provider: "firebase", idToken: token })).resolves.toBeNull();
      expect(observedThis).toBe(crypto.subtle);
    } finally {
      importKeySpy.mockRestore();
    }
  });

  it("uses global fetch with the correct invocation context", async () => {
    const originalFetch = globalThis.fetch;
    const guardedFetch = function guardedFetch(this: typeof globalThis) {
      if (this !== globalThis) {
        throw new Error("fetch called with incorrect this");
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            keys: [
              {
                kid: "kid_1",
                kty: "RSA",
                n: "invalid-key-material",
                e: "AQAB",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "max-age=60",
            },
          }
        )
      );
    } as unknown as typeof fetch;

    // Override for this test only to simulate Worker illegal-invocation behavior.
    globalThis.fetch = guardedFetch;

    try {
      const verifier = new FirebaseIdTokenVerifier({
        projectId: "project-1",
      });

      const token = makeToken({
        iss: "https://securetoken.google.com/project-1",
        aud: "project-1",
        sub: "firebase-user-ctx",
        exp: Math.floor(Date.now() / 1000) + 3600,
        firebase: { sign_in_provider: "anonymous" },
      });

      await expect(verifier.verify({ provider: "firebase", idToken: token })).resolves.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects invalid issuer", async () => {
    const verifier = new FirebaseIdTokenVerifier({
      projectId: "project-1",
      signatureVerifier: async () => true,
    });

    const token = makeToken({
      iss: "https://securetoken.google.com/other-project",
      aud: "project-1",
      sub: "firebase-user-1",
      exp: Math.floor(Date.now() / 1000) + 3600,
      firebase: { sign_in_provider: "anonymous" },
    });

    await expect(verifier.verify({ provider: "firebase", idToken: token })).resolves.toBeNull();
  });

  it("rejects invalid audience", async () => {
    const verifier = new FirebaseIdTokenVerifier({
      projectId: "project-1",
      signatureVerifier: async () => true,
    });

    const token = makeToken({
      iss: "https://securetoken.google.com/project-1",
      aud: "other-project",
      sub: "firebase-user-1",
      exp: Math.floor(Date.now() / 1000) + 3600,
      firebase: { sign_in_provider: "anonymous" },
    });

    await expect(verifier.verify({ provider: "firebase", idToken: token })).resolves.toBeNull();
  });

  it("rejects expired token", async () => {
    const verifier = new FirebaseIdTokenVerifier({
      projectId: "project-1",
      signatureVerifier: async () => true,
    });

    const token = makeToken({
      iss: "https://securetoken.google.com/project-1",
      aud: "project-1",
      sub: "firebase-user-1",
      exp: Math.floor(Date.now() / 1000) - 1,
      firebase: { sign_in_provider: "anonymous" },
    });

    await expect(verifier.verify({ provider: "firebase", idToken: token })).resolves.toBeNull();
  });

  it("accepts valid anonymous firebase identity", async () => {
    const verifier = new FirebaseIdTokenVerifier({
      projectId: "project-1",
      signatureVerifier: async () => true,
    });

    const token = makeToken({
      iss: "https://securetoken.google.com/project-1",
      aud: "project-1",
      sub: "firebase-user-1",
      exp: Math.floor(Date.now() / 1000) + 3600,
      firebase: { sign_in_provider: "anonymous" },
    });

    await expect(verifier.verify({ provider: "firebase", idToken: token })).resolves.toEqual({
      provider: "firebase",
      providerUserId: "firebase-user-1",
      isAnonymous: true,
    });
  });

  it("accepts valid google firebase identity", async () => {
    const verifier = new FirebaseIdTokenVerifier({
      projectId: "project-1",
      signatureVerifier: async () => true,
    });

    const token = makeToken({
      iss: "https://securetoken.google.com/project-1",
      aud: "project-1",
      sub: "firebase-user-2",
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: "user@example.com",
      firebase: { sign_in_provider: "google.com" },
    });

    await expect(verifier.verify({ provider: "firebase", idToken: token })).resolves.toEqual({
      provider: "firebase",
      providerUserId: "firebase-user-2",
      isAnonymous: false,
      email: "user@example.com",
    });
  });

  it("prefers google identity claim for provider key and keeps firebase uid as legacy fallback", async () => {
    const verifier = new FirebaseIdTokenVerifier({
      projectId: "project-1",
      signatureVerifier: async () => true,
    });

    const token = makeToken({
      iss: "https://securetoken.google.com/project-1",
      aud: "project-1",
      sub: "firebase-user-3",
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: "user@example.com",
      firebase: {
        sign_in_provider: "google.com",
        identities: {
          "google.com": ["google-sub-123"],
        },
      },
    });

    await expect(verifier.verify({ provider: "firebase", idToken: token })).resolves.toEqual({
      provider: "firebase",
      providerUserId: "google:google-sub-123",
      legacyProviderUserId: "firebase-user-3",
      isAnonymous: false,
      email: "user@example.com",
    });
  });
});
