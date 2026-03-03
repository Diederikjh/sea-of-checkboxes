import { normalizeAppSession, normalizeExternalAssertion } from "./contracts";

function defaultFetch(input, init) {
  return globalThis.fetch(input, init);
}

export function createAuthSessionExchangeClient({
  apiBaseUrl,
  fetchFn = typeof fetch === "function" ? defaultFetch : null,
} = {}) {
  if (typeof apiBaseUrl !== "string" || apiBaseUrl.trim().length === 0) {
    throw new Error("Missing apiBaseUrl for auth session exchange");
  }
  if (typeof fetchFn !== "function") {
    throw new Error("No fetch function available for auth session exchange");
  }

  const endpoint = `${apiBaseUrl.replace(/\/+$/, "")}/auth/session`;

  return {
    async exchange(assertion, legacyToken = "") {
      const normalizedAssertion = normalizeExternalAssertion(assertion);
      if (!normalizedAssertion) {
        throw new Error("Invalid auth assertion");
      }

      const body = {
        assertion: normalizedAssertion,
      };
      if (typeof legacyToken === "string" && legacyToken.trim().length > 0) {
        body.legacyToken = legacyToken.trim();
      }

      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message = typeof payload?.msg === "string" ? payload.msg : `Auth session exchange failed (${response.status})`;
        const detail = typeof payload?.detail === "string" ? payload.detail.trim() : "";
        throw new Error(detail.length > 0 ? `${message} (${detail})` : message);
      }

      const normalizedSession = normalizeAppSession(payload);
      if (!normalizedSession) {
        throw new Error("Invalid auth session response");
      }

      return normalizedSession;
    },
  };
}
