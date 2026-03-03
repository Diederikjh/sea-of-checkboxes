import type {
  ExternalAssertion,
  ExternalIdentityVerifier,
  VerifiedExternalIdentity,
} from "./contracts";

const DEFAULT_JWK_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000;

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
    this.#fetchFn = options.fetchFn ?? fetch;
    this.#jwkUrl = options.jwkUrl ?? DEFAULT_JWK_URL;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#signatureVerifier = options.signatureVerifier ?? null;
    this.#cachedKeys = new Map();
    this.#keysExpireAtMs = 0;
  }

  async verify(assertion: ExternalAssertion): Promise<VerifiedExternalIdentity | null> {
    if (assertion.provider !== "firebase") {
      return null;
    }

    const parsed = parseBearerJwt(assertion.idToken.trim());
    if (!parsed) {
      return null;
    }

    const nowMs = this.#clock.nowMs();
    const headerAlg = claimString(parsed.header.alg);
    const kid = claimString(parsed.header.kid);
    if (headerAlg !== "RS256" || !kid) {
      return null;
    }

    const issuer = claimString(parsed.claims.iss);
    const audience = claimString(parsed.claims.aud);
    const exp = claimInt(parsed.claims.exp);
    if (!issuer || !audience || exp === null) {
      return null;
    }

    if (issuer !== `https://securetoken.google.com/${this.#projectId}`) {
      return null;
    }
    if (audience !== this.#projectId) {
      return null;
    }

    const nowSeconds = Math.floor(nowMs / 1_000);
    if (exp < nowSeconds) {
      return null;
    }

    const provider = resolveProvider(parsed.claims);
    if (!provider) {
      return null;
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
      return null;
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
    if (!key || key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string") {
      return false;
    }

    let cryptoKey: CryptoKey;
    try {
      const importKey = crypto.subtle.importKey as unknown as (
        format: string,
        keyData: JsonWebKey,
        algorithm: AlgorithmIdentifier | RsaHashedImportParams,
        extractable: boolean,
        keyUsages: KeyUsage[]
      ) => Promise<CryptoKey>;
      cryptoKey = await importKey(
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
          hash: "SHA-256",
        },
        false,
        ["verify"]
      );
    } catch {
      return false;
    }

    const signature = new Uint8Array(params.signature.length);
    signature.set(params.signature);
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      new TextEncoder().encode(params.signingInput)
    );
  }

  async #keyForKid(kid: string, nowMs: number): Promise<JwkKey | null> {
    if (nowMs < this.#keysExpireAtMs && this.#cachedKeys.size > 0) {
      return this.#cachedKeys.get(kid) ?? null;
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
    return this.#cachedKeys.get(kid) ?? null;
  }
}
