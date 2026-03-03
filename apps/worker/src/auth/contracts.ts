import type { ConnectionIdentity } from "../doCommon";

export type ExternalProvider = "firebase";

export interface ExternalAssertion {
  provider: ExternalProvider;
  idToken: string;
}

export interface VerifiedExternalIdentity {
  provider: ExternalProvider;
  providerUserId: string;
  isAnonymous: boolean;
  email?: string;
}

export interface ExternalIdentityVerifier {
  verify(assertion: ExternalAssertion): Promise<VerifiedExternalIdentity | null>;
}

export interface AccountLinkRecord {
  identity: ConnectionIdentity;
  linkedAtMs: number;
  createdAtMs: number;
}

export interface AccountLinkRepository {
  getByProviderUser(provider: ExternalProvider, providerUserId: string): Promise<AccountLinkRecord | null>;
  getByAppUid(uid: string): Promise<{ provider: ExternalProvider; providerUserId: string } | null>;
  linkProviderUserToAppIdentity(params: {
    provider: ExternalProvider;
    providerUserId: string;
    identity: ConnectionIdentity;
    isAnonymous: boolean;
    email?: string;
    nowMs?: number;
  }): Promise<
    | { ok: true; linked: AccountLinkRecord }
    | { ok: false; code: "provider_conflict" | "app_uid_conflict"; existing?: AccountLinkRecord }
  >;
}

export type AuthSessionMigration = "none" | "linked_legacy" | "provisioned";

export interface AuthSessionResult extends ConnectionIdentity {
  migration: AuthSessionMigration;
}

export interface AuthSessionService {
  createOrResumeSession(params: {
    assertion: ExternalAssertion;
    legacyToken?: string;
    nowMs?: number;
  }): Promise<AuthSessionResult>;
}
