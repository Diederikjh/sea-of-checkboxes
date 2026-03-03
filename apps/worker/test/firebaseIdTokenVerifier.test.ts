import { describe, expect, it } from "vitest";

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
});
