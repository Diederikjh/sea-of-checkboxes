import { describe, expect, it } from "vitest";

import {
  createIdentityToken,
  verifyIdentityToken,
} from "../src/identityToken";

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function tokenParts(token: string): { version: string; payload: string; signature: string } {
  const [version, payload, signature] = token.split(".");
  if (!version || !payload || !signature) {
    throw new Error("Invalid token format");
  }
  return { version, payload, signature };
}

function tokenWithPayload(payload: unknown, signature = "sig"): string {
  return `v2.${toBase64Url(JSON.stringify(payload))}.${signature}`;
}

describe("identity token signing", () => {
  it("verifies valid tokens and returns exact claims", async () => {
    const secret = "test-identity-secret";
    const token = await createIdentityToken("u_test123", "BriskOtter481", secret, 1_700_000_000_000);
    const claims = await verifyIdentityToken({ token, secret, nowMs: 1_700_000_001_000 });

    expect(claims).toMatchObject({
      uid: "u_test123",
      name: "BriskOtter481",
    });
    expect(typeof claims?.exp).toBe("number");
  });

  it("rejects wrong token version", async () => {
    const secret = "test-identity-secret";
    const token = await createIdentityToken("u_test123", "BriskOtter481", secret);
    const wrongVersion = token.replace(/^v2\./, "v1.");
    await expect(verifyIdentityToken({ token: wrongVersion, secret })).resolves.toBeNull();
  });

  it("rejects malformed payload/signature segments", async () => {
    const secret = "test-identity-secret";
    await expect(verifyIdentityToken({ token: "v2.@@@.sig", secret })).resolves.toBeNull();
    await expect(verifyIdentityToken({ token: "v2.abc.$$", secret })).resolves.toBeNull();
  });

  it("rejects payload missing required fields", async () => {
    const secret = "test-identity-secret";
    const missingExp = tokenWithPayload({ uid: "u_test123", name: "BriskOtter481" });
    await expect(verifyIdentityToken({ token: missingExp, secret })).resolves.toBeNull();
  });

  it("rejects payload with invalid uid/name", async () => {
    const secret = "test-identity-secret";
    const badUid = tokenWithPayload({ uid: "test123", name: "BriskOtter481", exp: 9_999_999_999 });
    const badName = tokenWithPayload({ uid: "u_test123", name: "bad name", exp: 9_999_999_999 });
    await expect(verifyIdentityToken({ token: badUid, secret })).resolves.toBeNull();
    await expect(verifyIdentityToken({ token: badName, secret })).resolves.toBeNull();
  });

  it("rejects payload with non-integer expiration", async () => {
    const secret = "test-identity-secret";
    const nonIntExp = tokenWithPayload({ uid: "u_test123", name: "BriskOtter481", exp: 123.45 });
    await expect(verifyIdentityToken({ token: nonIntExp, secret })).resolves.toBeNull();
  });

  it("rejects signature mismatch even when payload shape is valid", async () => {
    const secret = "test-identity-secret";
    const tokenA = await createIdentityToken("u_test123", "BriskOtter481", secret, 1_700_000_000_000);
    const tokenB = await createIdentityToken("u_other123", "QuietFalcon233", secret, 1_700_000_000_000);
    const { version, signature } = tokenParts(tokenA);
    const { payload } = tokenParts(tokenB);
    const mismatched = `${version}.${payload}.${signature}`;

    await expect(
      verifyIdentityToken({ token: mismatched, secret })
    ).resolves.toBeNull();
  });

  it("rejects expired tokens", async () => {
    const secret = "test-identity-secret";
    const nowMs = 1_700_000_000_000;
    const token = await createIdentityToken("u_test123", "BriskOtter481", secret, nowMs);

    await expect(
      verifyIdentityToken({ token, secret, nowMs: nowMs + 1000 * 60 * 60 * 24 * 31 })
    ).resolves.toBeNull();
  });

  it("accepts token exactly at expiration boundary", async () => {
    const secret = "test-identity-secret";
    const token = await createIdentityToken("u_test123", "BriskOtter481", secret, 1_700_000_000_000);
    const verified = await verifyIdentityToken({ token, secret, nowMs: 1_700_000_001_000 });
    if (!verified) {
      throw new Error("Expected token to verify");
    }

    await expect(
      verifyIdentityToken({ token, secret, nowMs: verified.exp * 1000 })
    ).resolves.toMatchObject({
      uid: "u_test123",
      name: "BriskOtter481",
      exp: verified.exp,
    });
  });
});
