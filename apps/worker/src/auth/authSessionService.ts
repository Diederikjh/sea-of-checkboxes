import { createIdentityToken, verifyIdentityToken } from "../identityToken";
import { generateName, generateUid } from "../identityGenerator";
import type { ConnectionIdentity } from "../doCommon";
import type {
  AccountLinkRepository,
  AuthSessionResult,
  AuthSessionService,
  ExternalIdentityVerifier,
} from "./contracts";

export class AuthSessionServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class DefaultAuthSessionService implements AuthSessionService {
  #verifier: ExternalIdentityVerifier;
  #links: AccountLinkRepository;
  #signingSecret: string;

  constructor(options: {
    verifier: ExternalIdentityVerifier;
    links: AccountLinkRepository;
    signingSecret: string;
  }) {
    this.#verifier = options.verifier;
    this.#links = options.links;
    this.#signingSecret = options.signingSecret;
  }

  async createOrResumeSession(params: {
    assertion: { provider: "firebase"; idToken: string };
    legacyToken?: string;
    nowMs?: number;
  }): Promise<AuthSessionResult> {
    const nowMs = params.nowMs ?? Date.now();
    const verified = await this.#verifier.verify(params.assertion);
    if (!verified) {
      throw new AuthSessionServiceError(401, "invalid_firebase_token", "Invalid external identity assertion");
    }

    const existingLink = await this.#links.getByProviderUser(verified.provider, verified.providerUserId);
    if (existingLink) {
      return {
        ...existingLink.identity,
        token: await createIdentityToken(existingLink.identity.uid, existingLink.identity.name, this.#signingSecret, nowMs),
        migration: "none",
      };
    }

    const legacyIdentity = await this.#resolveLegacyIdentity(params.legacyToken, nowMs);
    const identity: ConnectionIdentity = legacyIdentity ?? {
      uid: generateUid(),
      name: generateName(),
      token: "",
    };
    let migration: "linked_legacy" | "provisioned" = legacyIdentity ? "linked_legacy" : "provisioned";

    let linkResult = await this.#links.linkProviderUserToAppIdentity({
      provider: verified.provider,
      providerUserId: verified.providerUserId,
      identity,
      isAnonymous: verified.isAnonymous,
      ...(verified.email ? { email: verified.email } : {}),
      nowMs,
    });

    if (!linkResult.ok && linkResult.code === "app_uid_conflict") {
      // The provided legacy token points at an app uid linked to a different provider user.
      // Recover by provisioning a fresh app identity for this verified provider user.
      linkResult = await this.#links.linkProviderUserToAppIdentity({
        provider: verified.provider,
        providerUserId: verified.providerUserId,
        identity: {
          uid: generateUid(),
          name: generateName(),
          token: "",
        },
        isAnonymous: verified.isAnonymous,
        ...(verified.email ? { email: verified.email } : {}),
        nowMs,
      });
      migration = "provisioned";
    }

    if (!linkResult.ok) {
      if (linkResult.code === "provider_conflict" && linkResult.existing) {
        return {
          ...linkResult.existing.identity,
          token: await createIdentityToken(
            linkResult.existing.identity.uid,
            linkResult.existing.identity.name,
            this.#signingSecret,
            nowMs
          ),
          migration: "none",
        };
      }

      throw new AuthSessionServiceError(409, "link_conflict", "External identity link conflict");
    }

    return {
      uid: linkResult.linked.identity.uid,
      name: linkResult.linked.identity.name,
      token: await createIdentityToken(linkResult.linked.identity.uid, linkResult.linked.identity.name, this.#signingSecret, nowMs),
      migration,
    };
  }

  async #resolveLegacyIdentity(legacyToken: string | undefined, nowMs: number): Promise<ConnectionIdentity | null> {
    const token = typeof legacyToken === "string" ? legacyToken.trim() : "";
    if (token.length === 0) {
      return null;
    }

    const claims = await verifyIdentityToken({
      token,
      secret: this.#signingSecret,
      nowMs,
    });

    if (!claims) {
      return null;
    }

    return {
      uid: claims.uid,
      name: claims.name,
      token: "",
    };
  }
}
