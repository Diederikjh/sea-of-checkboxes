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

export async function signInWithGoogleSession({
  identityProvider,
  sessionExchangeClient,
  readStoredIdentity,
  writeStoredIdentity,
} = {}) {
  return refreshSessionAfterProviderAction({
    identityProvider,
    sessionExchangeClient,
    readStoredIdentity,
    writeStoredIdentity,
    action: (provider) => provider.linkGoogle(),
  });
}

export async function removeGoogleLinkFromSession({
  identityProvider,
  sessionExchangeClient,
  readStoredIdentity,
  writeStoredIdentity,
} = {}) {
  return refreshSessionAfterProviderAction({
    identityProvider,
    sessionExchangeClient,
    readStoredIdentity,
    writeStoredIdentity,
    action: (provider) => provider.unlinkGoogle(),
  });
}

async function refreshSessionAfterProviderAction({
  identityProvider,
  sessionExchangeClient,
  readStoredIdentity,
  writeStoredIdentity,
  action,
}) {
  assertAuthIdentityProvider(identityProvider);
  if (typeof action !== "function") {
    throw new Error("Missing provider action");
  }
  await action(identityProvider);

  return bootstrapAuthSession({
    identityProvider,
    sessionExchangeClient,
    readStoredIdentity,
    writeStoredIdentity,
    allowLegacyFallback: false,
    forceRefresh: true,
  });
}
