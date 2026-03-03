import {
  assertAuthIdentityProvider,
  assertAuthSessionExchangeClient,
  normalizeExternalAssertion,
} from "./contracts";

function readLegacyToken(readStoredIdentity) {
  if (typeof readStoredIdentity !== "function") {
    return "";
  }

  const identity = readStoredIdentity();
  const token = typeof identity?.token === "string" ? identity.token.trim() : "";
  return token;
}

export async function bootstrapAuthSession({
  identityProvider,
  sessionExchangeClient,
  readStoredIdentity,
  writeStoredIdentity,
  allowLegacyFallback = true,
  forceRefresh = false,
} = {}) {
  assertAuthIdentityProvider(identityProvider);
  assertAuthSessionExchangeClient(sessionExchangeClient);

  await identityProvider.initAnonymousSession();
  const idToken = await identityProvider.getAssertionToken(forceRefresh);
  const assertion = normalizeExternalAssertion({
    provider: "firebase",
    idToken,
  });
  if (!assertion) {
    throw new Error("Invalid assertion token from auth provider");
  }

  const legacyToken = readLegacyToken(readStoredIdentity);

  try {
    const session = await sessionExchangeClient.exchange(assertion, legacyToken);
    if (typeof writeStoredIdentity === "function") {
      writeStoredIdentity({
        uid: session.uid,
        name: session.name,
        token: session.token,
      });
    }

    return {
      session,
      migration: session.migration,
      usedLegacyFallback: false,
    };
  } catch (error) {
    if (!allowLegacyFallback || legacyToken.length === 0) {
      throw error;
    }

    const fallbackIdentity = typeof readStoredIdentity === "function" ? readStoredIdentity() : null;
    if (!fallbackIdentity) {
      throw error;
    }

    return {
      session: {
        uid: fallbackIdentity.uid,
        name: fallbackIdentity.name,
        token: fallbackIdentity.token,
      },
      migration: "none",
      usedLegacyFallback: true,
    };
  }
}

export async function upgradeAuthSessionWithGoogle({
  identityProvider,
  sessionExchangeClient,
  readStoredIdentity,
  writeStoredIdentity,
} = {}) {
  assertAuthIdentityProvider(identityProvider);
  await identityProvider.linkGoogle();

  return bootstrapAuthSession({
    identityProvider,
    sessionExchangeClient,
    readStoredIdentity,
    writeStoredIdentity,
    allowLegacyFallback: false,
    forceRefresh: true,
  });
}

export async function removeGoogleLinkFromSession({
  identityProvider,
  sessionExchangeClient,
  readStoredIdentity,
  writeStoredIdentity,
} = {}) {
  assertAuthIdentityProvider(identityProvider);
  await identityProvider.unlinkGoogle();

  return bootstrapAuthSession({
    identityProvider,
    sessionExchangeClient,
    readStoredIdentity,
    writeStoredIdentity,
    allowLegacyFallback: false,
    forceRefresh: true,
  });
}
