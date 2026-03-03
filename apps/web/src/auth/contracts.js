function isObject(value) {
  return Boolean(value) && typeof value === "object";
}

export function normalizeAuthPrincipal(value) {
  if (!isObject(value)) {
    return null;
  }

  const providerUserId = typeof value.providerUserId === "string" ? value.providerUserId.trim() : "";
  const provider = value.provider === "firebase" ? value.provider : null;
  if (!provider || providerUserId.length === 0) {
    return null;
  }

  return {
    provider,
    providerUserId,
    isAnonymous: value.isAnonymous === true,
  };
}

export function normalizeExternalAssertion(value) {
  if (!isObject(value)) {
    return null;
  }

  const provider = value.provider === "firebase" ? value.provider : null;
  const idToken = typeof value.idToken === "string" ? value.idToken.trim() : "";
  if (!provider || idToken.length === 0) {
    return null;
  }

  return {
    provider,
    idToken,
  };
}

export function normalizeAppSession(value) {
  if (!isObject(value)) {
    return null;
  }

  const uid = typeof value.uid === "string" ? value.uid.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const token = typeof value.token === "string" ? value.token.trim() : "";
  const migration =
    value.migration === "none" || value.migration === "linked_legacy" || value.migration === "provisioned"
      ? value.migration
      : null;

  if (uid.length === 0 || name.length === 0 || token.length === 0 || !migration) {
    return null;
  }

  return {
    uid,
    name,
    token,
    migration,
  };
}

export function assertAuthIdentityProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("Invalid auth identity provider");
  }

  const required = ["initAnonymousSession", "getAssertionToken", "linkGoogle", "unlinkGoogle", "signOut"];
  for (const method of required) {
    if (typeof provider[method] !== "function") {
      throw new Error(`AuthIdentityProvider missing method: ${method}`);
    }
  }
}

export function assertAuthSessionExchangeClient(client) {
  if (!client || typeof client !== "object" || typeof client.exchange !== "function") {
    throw new Error("Invalid auth session exchange client");
  }
}
