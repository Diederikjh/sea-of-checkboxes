import { normalizeIdentity } from "@sea/domain";
import type { Env } from "./doCommon";

const TOKEN_VERSION = "v2";
const TOKEN_SEPARATOR = ".";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
// Development fallback only. Production must provide IDENTITY_SIGNING_SECRET.
const DEV_IDENTITY_SIGNING_SECRET = "dev-sea-identity-signing-secret-change-before-prod";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface TokenParts {
  version: string;
  payload: string;
  signature: string;
}

export interface IdentityTokenClaims {
  uid: string;
  name: string;
  exp: number;
}

function resolveBase64EncodeFn(): ((value: Uint8Array) => string) | null {
  if (typeof Buffer !== "undefined") {
    return (value) => Buffer.from(value).toString("base64");
  }

  const btoaFn = (globalThis as { btoa?: (value: string) => string }).btoa;
  if (!btoaFn) {
    return null;
  }

  return (value) => {
    let binary = "";
    for (const byte of value) {
      binary += String.fromCharCode(byte);
    }
    return btoaFn(binary);
  };
}

function toBase64Url(bytes: Uint8Array): string {
  const encode = resolveBase64EncodeFn();
  if (!encode) {
    throw new Error("No base64 encoder available");
  }
  return encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function resolveBase64DecodeFn(): ((value: string) => Uint8Array) | null {
  if (typeof Buffer !== "undefined") {
    return (value) => new Uint8Array(Buffer.from(value, "base64"));
  }

  const atobFn = (globalThis as { atob?: (value: string) => string }).atob;
  if (!atobFn) {
    return null;
  }

  return (value) => {
    const binary = atobFn(value);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      out[index] = binary.charCodeAt(index);
    }
    return out;
  };
}

function fromBase64Url(value: string): Uint8Array | null {
  const decode = resolveBase64DecodeFn();
  if (!decode) {
    return null;
  }

  try {
    const withBase64Alphabet = value.replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = (4 - (withBase64Alphabet.length % 4)) % 4;
    const padded = withBase64Alphabet + "=".repeat(paddingLength);
    return decode(padded);
  } catch {
    return null;
  }
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) {
      return false;
    }
    diff |= left ^ right;
  }
  return diff === 0;
}

function parseToken(token: string): TokenParts | null {
  const parts = token.split(TOKEN_SEPARATOR);
  if (parts.length !== 3) {
    return null;
  }

  const version = parts[0] ?? "";
  const payload = parts[1] ?? "";
  const signature = parts[2] ?? "";
  if (version.length === 0 || payload.length === 0 || signature.length === 0) {
    return null;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    return null;
  }

  return {
    version,
    payload,
    signature,
  };
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return new Uint8Array(signature);
}

function buildPayload(uid: string, name: string, exp: number): string {
  return JSON.stringify({
    uid,
    name,
    exp,
  });
}

export function resolveIdentitySigningSecret(env: Env): string {
  const secret = typeof env.IDENTITY_SIGNING_SECRET === "string" ? env.IDENTITY_SIGNING_SECRET.trim() : "";
  return secret.length > 0 ? secret : DEV_IDENTITY_SIGNING_SECRET;
}

export async function createIdentityToken(
  uid: string,
  name: string,
  secret: string,
  nowMs = Date.now()
): Promise<string> {
  const exp = Math.floor(nowMs / 1_000) + TOKEN_TTL_SECONDS;
  const payloadEncoded = toBase64Url(textEncoder.encode(buildPayload(uid, name, exp)));
  const signature = await hmacSha256(secret, payloadEncoded);
  return `${TOKEN_VERSION}.${payloadEncoded}.${toBase64Url(signature)}`;
}

export async function verifyIdentityToken(params: {
  token: string;
  secret: string;
  nowMs?: number;
}): Promise<IdentityTokenClaims | null> {
  const parsed = parseToken(params.token);
  if (!parsed || parsed.version !== TOKEN_VERSION) {
    return null;
  }

  const payloadBytes = fromBase64Url(parsed.payload);
  if (!payloadBytes) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(textDecoder.decode(payloadBytes));
  } catch {
    return null;
  }

  const normalized = normalizeIdentity(payload);
  if (!normalized) {
    return null;
  }

  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== "number" || !Number.isInteger(exp) || exp <= 0) {
    return null;
  }
  const nowSeconds = Math.floor((params.nowMs ?? Date.now()) / 1_000);
  if (exp < nowSeconds) {
    return null;
  }

  const expected = await hmacSha256(params.secret, parsed.payload);
  const expectedRaw = toBase64Url(expected);
  if (!timingSafeEqual(textEncoder.encode(parsed.signature), textEncoder.encode(expectedRaw))) {
    return null;
  }

  return {
    uid: normalized.uid,
    name: normalized.name,
    exp,
  };
}
