import { describe, expect, it } from "vitest";

import { DefaultAuthSessionService } from "../src/auth/authSessionService";
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

    const nowMs = params.nowMs ?? Date.now();
    const existingByUid = this.byUid.get(params.identity.uid);
    if (existingByUid && existingByUid.providerUserId !== params.providerUserId) {
      const currentProviderRecord = this.byProvider.get(`${params.provider}:${existingByUid.providerUserId}`);
      if (currentProviderRecord && currentProviderRecord.identity.uid === params.identity.uid) {
        const migrated: AccountLinkRecord = {
          identity: {
            uid: currentProviderRecord.identity.uid,
            name: currentProviderRecord.identity.name,
            token: "",
          },
          linkedAtMs: nowMs,
          createdAtMs: currentProviderRecord.createdAtMs,
        };
        this.byProvider.set(key, migrated);
        this.byUid.set(params.identity.uid, {
          provider: params.provider,
          providerUserId: params.providerUserId,
        });
        return { ok: true, linked: migrated };
      }
      return { ok: false, code: "app_uid_conflict" };
    }

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

  it("falls back to provisioned identity when legacy app uid is already mapped to another provider user", async () => {
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

    const session = await service.createOrResumeSession({
      assertion: { provider: "firebase", idToken: "id-token" },
      legacyToken,
      nowMs: 1_700_000_001_000,
    });

    expect(session.uid).toMatch(/^u_[0-9a-f]{8}$/);
    expect(session.uid).not.toBe("u_legacy1");
    expect(session.name).toMatch(/^[A-Za-z]+\d{3}$/);
    expect(session.migration).toBe("provisioned");
  });

  it("reuses existing identity via legacy provider id fallback and migrates to stable provider id", async () => {
    const links = new InMemoryLinkRepository();
    links.byProvider.set("firebase:firebase-sub-legacy", {
      identity: { uid: "u_stable123", name: "BriskOtter123", token: "" },
      linkedAtMs: 10,
      createdAtMs: 10,
    });
    links.byUid.set("u_stable123", {
      provider: "firebase",
      providerUserId: "firebase-sub-legacy",
    });

    const service = new DefaultAuthSessionService({
      verifier: new StaticVerifier({
        provider: "firebase",
        providerUserId: "google:google-sub-1",
        legacyProviderUserId: "firebase-sub-legacy",
        isAnonymous: false,
        email: "stable@example.com",
      }),
      links,
      signingSecret: "test-secret",
    });

    const session = await service.createOrResumeSession({
      assertion: { provider: "firebase", idToken: "id-token" },
      nowMs: 1_700_000_010_000,
    });

    expect(session.uid).toBe("u_stable123");
    expect(session.name).toBe("BriskOtter123");
    expect(session.migration).toBe("none");
    expect(links.byProvider.get("firebase:google:google-sub-1")?.identity.uid).toBe("u_stable123");
  });
});
