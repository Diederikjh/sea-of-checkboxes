import { describe, expect, it } from "vitest";

import {
  createIdentityToken,
  verifyIdentityToken,
} from "../src/identityToken";

describe("identity token signing", () => {
  it("verifies valid tokens", async () => {
    const secret = "test-identity-secret";
    const token = await createIdentityToken("u_test123", "BriskOtter481", secret, 1_700_000_000_000);

    await expect(
      verifyIdentityToken({ token, secret, nowMs: 1_700_000_001_000 })
    ).resolves.toMatchObject({
      uid: "u_test123",
      name: "BriskOtter481",
    });
  });

  it("rejects tampered token signature", async () => {
    const secret = "test-identity-secret";
    const token = await createIdentityToken("u_test123", "BriskOtter481", secret);
    const tampered = token.replace(/\.[A-Za-z0-9_-]+$/, ".bad");

    await expect(
      verifyIdentityToken({ token: tampered, secret })
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
});
