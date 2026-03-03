import type {
  ExternalAssertion,
  ExternalIdentityVerifier,
  VerifiedExternalIdentity,
} from "./contracts";

const DEFAULT_JWK_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000;

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Cloudflare Workers requires fetch to be called with the correct global receiver.
  return globalThis.fetch(input, init);
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
}

interface FirebaseClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  email?: unknown;
  firebase?: {
    sign_in_provider?: unknown;
  };
}

interface JwkKey {
  kty?: unknown;
  kid?: unknown;
  alg?: unknown;
  use?: unknown;
  n?: unknown;
  e?: unknown;
}

function decodeBase64UrlBytes(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

  try {
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(padded, "base64"));
    }

    const atobFn = (globalThis as { atob?: (input: string) => string }).atob;
    if (!atobFn) {
      return null;
    }

    const binary = atobFn(padded);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      out[index] = binary.charCodeAt(index);
    }
    return out;
  } catch {
    return null;
  }
}

function decodeBase64UrlJson<T>(value: string): T | null {
  const bytes = decodeBase64UrlBytes(value);
  if (!bytes) {
    return null;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function parseBearerJwt(token: string): { header: JwtHeader; claims: FirebaseClaims; signature: Uint8Array; signingInput: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [rawHeader, rawClaims, rawSignature] = parts;
  if (!rawHeader || !rawClaims || !rawSignature) {
    return null;
  }

  const header = decodeBase64UrlJson<JwtHeader>(rawHeader);
  const claims = decodeBase64UrlJson<FirebaseClaims>(rawClaims);
  const signature = decodeBase64UrlBytes(rawSignature);
  if (!header || !claims || !signature) {
    return null;
  }

  return {
    header,
    claims,
    signature,
    signingInput: `${rawHeader}.${rawClaims}`,
  };
}

function claimString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function claimInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function resolveProvider(claims: FirebaseClaims): { providerUserId: string; isAnonymous: boolean; email?: string } | null {
  const providerUserId = claimString(claims.sub);
  if (!providerUserId) {
    return null;
  }

  const signInProvider = claimString(claims.firebase?.sign_in_provider);
  const isAnonymous = signInProvider === "anonymous";
  const email = claimString(claims.email) ?? undefined;

  if (!isAnonymous && signInProvider !== "google.com") {
    return null;
  }

  return {
    providerUserId,
    isAnonymous,
    ...(email ? { email } : {}),
  };
}

function parseCacheMaxAge(cacheControl: string | null): number {
  if (!cacheControl) {
    return DEFAULT_CACHE_TTL_MS;
  }

  const match = cacheControl.match(/max-age=(\d+)/i);
  if (!match) {
    return DEFAULT_CACHE_TTL_MS;
  }

  const raw = match[1];
  if (!raw) {
    return DEFAULT_CACHE_TTL_MS;
  }

  const maxAgeSeconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    return DEFAULT_CACHE_TTL_MS;
  }

  return maxAgeSeconds * 1_000;
}

export class FirebaseIdTokenVerifier implements ExternalIdentityVerifier {
  #projectId: string;
  #fetchFn: typeof fetch;
  #jwkUrl: string;
  #clock: { nowMs: () => number };
  #signatureVerifier: ((params: {
    header: JwtHeader;
    signingInput: string;
    signature: Uint8Array;
    nowMs: number;
  }) => Promise<boolean>) | null;
  #cachedKeys: Map<string, JwkKey>;
  #keysExpireAtMs: number;

  constructor(options: {
    projectId: string;
    fetchFn?: typeof fetch;
    jwkUrl?: string;
    clock?: { nowMs: () => number };
    signatureVerifier?: (params: {
      header: JwtHeader;
      signingInput: string;
      signature: Uint8Array;
      nowMs: number;
    }) => Promise<boolean>;
  }) {
    this.#projectId = options.projectId.trim();
    this.#fetchFn = options.fetchFn ?? defaultFetch;
    this.#jwkUrl = options.jwkUrl ?? DEFAULT_JWK_URL;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#signatureVerifier = options.signatureVerifier ?? null;
    this.#cachedKeys = new Map();
    this.#keysExpireAtMs = 0;
  }

  async verify(assertion: ExternalAssertion): Promise<VerifiedExternalIdentity | null> {
    const reject = (reason: string, details: Record<string, unknown> = {}): null => {
      console.warn("firebase_token_rejected", {
        reason,
        ...details,
      });
      return null;
    };

    if (assertion.provider !== "firebase") {
      return reject("unsupported_assertion_provider", { provider: assertion.provider });
    }

    const parsed = parseBearerJwt(assertion.idToken.trim());
    if (!parsed) {
      return reject("jwt_parse_failed");
    }

    const nowMs = this.#clock.nowMs();
    const headerAlg = claimString(parsed.header.alg);
    const kid = claimString(parsed.header.kid);
    if (headerAlg !== "RS256" || !kid) {
      return reject("invalid_header", {
        alg: headerAlg,
        hasKid: Boolean(kid),
      });
    }

    const issuer = claimString(parsed.claims.iss);
    const audience = claimString(parsed.claims.aud);
    const exp = claimInt(parsed.claims.exp);
    if (!issuer || !audience || exp === null) {
      return reject("missing_claims", {
        hasIssuer: Boolean(issuer),
        hasAudience: Boolean(audience),
        hasExp: exp !== null,
      });
    }

    if (issuer !== `https://securetoken.google.com/${this.#projectId}`) {
      return reject("issuer_mismatch", {
        issuer,
        expectedIssuer: `https://securetoken.google.com/${this.#projectId}`,
      });
    }
    if (audience !== this.#projectId) {
      return reject("audience_mismatch", {
        audience,
        expectedAudience: this.#projectId,
      });
    }

    const nowSeconds = Math.floor(nowMs / 1_000);
    if (exp < nowSeconds) {
      return reject("token_expired", {
        exp,
        nowSeconds,
      });
    }

    const provider = resolveProvider(parsed.claims);
    if (!provider) {
      return reject("unsupported_sign_in_provider", {
        signInProvider: claimString(parsed.claims.firebase?.sign_in_provider),
      });
    }

    const signatureValid = this.#signatureVerifier
      ? await this.#signatureVerifier({
          header: parsed.header,
          signingInput: parsed.signingInput,
          signature: parsed.signature,
          nowMs,
        })
      : await this.#verifySignature({
          kid,
          signingInput: parsed.signingInput,
          signature: parsed.signature,
          nowMs,
        });

    if (!signatureValid) {
      return reject("signature_invalid", {
        kid,
      });
    }

    return {
      provider: "firebase",
      providerUserId: provider.providerUserId,
      isAnonymous: provider.isAnonymous,
      ...(provider.email ? { email: provider.email } : {}),
    };
  }

  async #verifySignature(params: {
    kid: string;
    signingInput: string;
    signature: Uint8Array;
    nowMs: number;
  }): Promise<boolean> {
    const key = await this.#keyForKid(params.kid, params.nowMs);
    if (!key) {
      console.warn("firebase_token_signature_key_missing", {
        kid: params.kid,
      });
      return false;
    }
    if (key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string") {
      console.warn("firebase_token_signature_key_invalid", {
        kid: params.kid,
        kty: key.kty,
        hasN: typeof key.n === "string",
        hasE: typeof key.e === "string",
      });
      return false;
    }

    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await crypto.subtle.importKey(
        "jwk",
        {
          kty: "RSA",
          n: key.n,
          e: key.e,
          alg: "RS256",
          ext: true,
        },
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: { name: "SHA-256" },
        },
        false,
        ["verify"]
      );
    } catch (error) {
      console.warn("firebase_token_signature_import_failed", {
        kid: params.kid,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    const signature = new Uint8Array(params.signature.length);
    signature.set(params.signature);
    const signatureBuffer = signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength
    );
    const payload = new TextEncoder().encode(params.signingInput);
    const payloadBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);

    const isValid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      cryptoKey,
      signatureBuffer,
      payloadBuffer
    );
    if (!isValid) {
      console.warn("firebase_token_signature_verify_failed", {
        kid: params.kid,
      });
    }
    return isValid;
  }

  async #keyForKid(kid: string, nowMs: number): Promise<JwkKey | null> {
    if (nowMs < this.#keysExpireAtMs && this.#cachedKeys.size > 0) {
      const cached = this.#cachedKeys.get(kid);
      if (cached) {
        return cached;
      }
      // Key ID can change before cache expiry; refresh once when cache misses.
      console.warn("firebase_jwk_cache_miss_for_kid", {
        kid,
        cachedKidCount: this.#cachedKeys.size,
      });
    }

    let response: Response;
    try {
      response = await this.#fetchFn(this.#jwkUrl);
    } catch (error) {
      throw new Error(
        `Unable to fetch firebase public keys: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (!response.ok) {
      return null;
    }

    let payload: { keys?: unknown };
    try {
      payload = (await response.json()) as { keys?: unknown };
    } catch (error) {
      throw new Error(
        `Firebase public key response was not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (!Array.isArray(payload.keys)) {
      console.warn("firebase_jwk_payload_unexpected_shape", {
        hasKeysArray: false,
        payloadType: typeof payload,
      });
      return null;
    }

    const next = new Map<string, JwkKey>();
    for (const raw of payload.keys) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const key = raw as JwkKey;
      const keyKid = claimString(key.kid);
      if (!keyKid) {
        continue;
      }
      next.set(keyKid, key);
    }

    this.#cachedKeys = next;
    this.#keysExpireAtMs = nowMs + parseCacheMaxAge(response.headers.get("cache-control"));
    const matched = this.#cachedKeys.get(kid) ?? null;
    if (!matched) {
      console.warn("firebase_jwk_kid_not_found_after_refresh", {
        kid,
        fetchedKidCount: this.#cachedKeys.size,
      });
    }
    return matched;
  }
}
