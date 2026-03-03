import type { ExternalAssertion } from "./contracts";

export interface AuthSessionRequest {
  assertion: ExternalAssertion;
  legacyToken?: string;
}

export function parseAuthSessionRequest(value: unknown): AuthSessionRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    assertion?: unknown;
    legacyToken?: unknown;
  };

  if (!candidate.assertion || typeof candidate.assertion !== "object") {
    return null;
  }

  const assertion = candidate.assertion as {
    provider?: unknown;
    idToken?: unknown;
  };

  if (assertion.provider !== "firebase" || typeof assertion.idToken !== "string" || assertion.idToken.trim().length === 0) {
    return null;
  }

  const legacyToken = typeof candidate.legacyToken === "string" ? candidate.legacyToken.trim() : "";

  return {
    assertion: {
      provider: "firebase",
      idToken: assertion.idToken.trim(),
    },
    ...(legacyToken.length > 0 ? { legacyToken } : {}),
  };
}
