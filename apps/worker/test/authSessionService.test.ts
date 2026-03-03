import { describe, expect, it } from "vitest";

import { DefaultAuthSessionService, AuthSessionServiceError } from "../src/auth/authSessionService";
import type {
  AccountLinkRecord,
  AccountLinkRepository,
  ExternalAssertion,
  ExternalIdentityVerifier,
  VerifiedExternalIdentity,
} from "../src/auth/contracts";
import { createIdentityToken } from "../src/identityToken";

class InMemoryLinkRepository implements AccountLinkRepository {
  byProvider = new Map<string, AccountLinkRecord>();
  byUid = new Map<string, { provider: "firebase"; providerUserId: string }>();

  async getByProviderUser(provider: "firebase", providerUserId: string): Promise<AccountLinkRecord | null> {
    return this.byProvider.get(`${provider}:${providerUserId}`) ?? null;
  }

  async getByAppUid(uid: string): Promise<{ provider: "firebase"; providerUserId: string } | null> {
    return this.byUid.get(uid) ?? null;
  }

  async linkProviderUserToAppIdentity(params: {
    provider: "firebase";
    providerUserId: string;
    identity: { uid: string; name: string; token: string };
    isAnonymous: boolean;
    email?: string;
    nowMs?: number;
  }): Promise<
    | { ok: true; linked: AccountLinkRecord }
    | { ok: false; code: "provider_conflict" | "app_uid_conflict"; existing?: AccountLinkRecord }
  > {
    const key = `${params.provider}:${params.providerUserId}`;
    const existingByProvider = this.byProvider.get(key);
    if (existingByProvider) {
      if (existingByProvider.identity.uid === params.identity.uid) {
        return { ok: true, linked: existingByProvider };
      }
      return { ok: false, code: "provider_conflict", existing: existingByProvider };
    }

    const existingByUid = this.byUid.get(params.identity.uid);
    if (existingByUid && existingByUid.providerUserId !== params.providerUserId) {
      return { ok: false, code: "app_uid_conflict" };
    }

    const nowMs = params.nowMs ?? Date.now();
    const linked: AccountLinkRecord = {
      identity: {
        uid: params.identity.uid,
        name: params.identity.name,
        token: "",
      },
      linkedAtMs: nowMs,
      createdAtMs: nowMs,
    };
    this.byProvider.set(key, linked);
    this.byUid.set(params.identity.uid, {
      provider: params.provider,
      providerUserId: params.providerUserId,
    });
    return { ok: true, linked };
  }
}

class StaticVerifier implements ExternalIdentityVerifier {
  #identity: VerifiedExternalIdentity | null;

  constructor(identity: VerifiedExternalIdentity | null) {
    this.#identity = identity;
  }

  async verify(_assertion: ExternalAssertion): Promise<VerifiedExternalIdentity | null> {
    return this.#identity;
  }
}

describe("DefaultAuthSessionService", () => {
  it("returns existing linked identity", async () => {
    const links = new InMemoryLinkRepository();
    links.byProvider.set("firebase:f_u1", {
      identity: { uid: "u_saved123", name: "BriskOtter123", token: "" },
      linkedAtMs: 10,
      createdAtMs: 10,
    });

    const service = new DefaultAuthSessionService({
      verifier: new StaticVerifier({ provider: "firebase", providerUserId: "f_u1", isAnonymous: true }),
      links,
      signingSecret: "test-secret",
    });

    const session = await service.createOrResumeSession({
      assertion: { provider: "firebase", idToken: "id-token" },
      nowMs: 100,
    });

    expect(session.uid).toBe("u_saved123");
    expect(session.name).toBe("BriskOtter123");
    expect(session.migration).toBe("none");
    expect(session.token).toMatch(/^v2\./);
  });

  it("links valid legacy token to first-time firebase user", async () => {
    const links = new InMemoryLinkRepository();
    const legacyToken = await createIdentityToken("u_legacy1", "MintFox001", "test-secret", 1_700_000_000_000);

    const service = new DefaultAuthSessionService({
      verifier: new StaticVerifier({ provider: "firebase", providerUserId: "f_legacy", isAnonymous: true }),
      links,
      signingSecret: "test-secret",
    });

    const session = await service.createOrResumeSession({
      assertion: { provider: "firebase", idToken: "id-token" },
      legacyToken,
      nowMs: 1_700_000_001_000,
    });

    expect(session.uid).toBe("u_legacy1");
    expect(session.name).toBe("MintFox001");
    expect(session.migration).toBe("linked_legacy");
    expect(links.byProvider.get("firebase:f_legacy")?.identity.uid).toBe("u_legacy1");
  });

  it("provisions a new app identity when legacy token is missing", async () => {
    const links = new InMemoryLinkRepository();

    const service = new DefaultAuthSessionService({
      verifier: new StaticVerifier({ provider: "firebase", providerUserId: "f_new", isAnonymous: true }),
      links,
      signingSecret: "test-secret",
    });

    const session = await service.createOrResumeSession({
      assertion: { provider: "firebase", idToken: "id-token" },
      nowMs: 1_700_000_001_000,
    });

    expect(session.uid).toMatch(/^u_[0-9a-f]{8}$/);
    expect(session.name).toMatch(/^[A-Za-z]+\d{3}$/);
    expect(session.migration).toBe("provisioned");
  });

  it("fails with link_conflict when app uid already mapped to another provider user", async () => {
    const links = new InMemoryLinkRepository();
    links.byUid.set("u_legacy1", {
      provider: "firebase",
      providerUserId: "f_other",
    });

    const legacyToken = await createIdentityToken("u_legacy1", "MintFox001", "test-secret", 1_700_000_000_000);

    const service = new DefaultAuthSessionService({
      verifier: new StaticVerifier({ provider: "firebase", providerUserId: "f_new", isAnonymous: true }),
      links,
      signingSecret: "test-secret",
    });

    await expect(
      service.createOrResumeSession({
        assertion: { provider: "firebase", idToken: "id-token" },
        legacyToken,
        nowMs: 1_700_000_001_000,
      })
    ).rejects.toMatchObject({
      status: 409,
      code: "link_conflict",
    } satisfies Partial<AuthSessionServiceError>);
  });
});
