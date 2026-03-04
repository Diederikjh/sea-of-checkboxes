import { bootstrapAuthSession, signInWithGoogleSession } from "./bootstrap";

function defaultReloadPage() {
  if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
    window.location.reload();
  }
}

function errorMessageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function logError(errorLogger, event, errorMessage) {
  if (!errorLogger || typeof errorLogger.error !== "function") {
    return;
  }
  errorLogger.error(event, { error: errorMessage });
}

export async function signInWithGoogleSessionTransition({
  identityProvider,
  sessionExchangeClient,
  readStoredIdentity,
  writeStoredIdentity,
  readStoredAnonymousIdentity,
  writeStoredAnonymousIdentity,
  setStatus = () => {},
  logOther = () => {},
  errorLogger = console,
  reloadPage = defaultReloadPage,
  signInWithGoogleSessionFn = signInWithGoogleSession,
} = {}) {
  try {
    const principalBefore = await identityProvider.initAnonymousSession();
    const existingAnonymousIdentity =
      typeof readStoredAnonymousIdentity === "function" ? readStoredAnonymousIdentity() : null;
    const currentIdentity = typeof readStoredIdentity === "function" ? readStoredIdentity() : null;
    if (!existingAnonymousIdentity && principalBefore?.isAnonymous === true && currentIdentity) {
      writeStoredAnonymousIdentity(currentIdentity);
    }

    setStatus("Signing in with Google...");
    await signInWithGoogleSessionFn({
      identityProvider,
      sessionExchangeClient,
      readStoredIdentity,
      writeStoredIdentity,
    });
    setStatus("Signed in with Google. Reloading...");
    reloadPage();
    return { ok: true };
  } catch (error) {
    const message = errorMessageOf(error);
    logOther("auth google_signin_failed", {
      error: message,
    });
    logError(errorLogger, "auth google_signin_failed", message);
    setStatus(`Google sign-in failed. ${message}`);
    return {
      ok: false,
      error: message,
    };
  }
}

export async function signOutToAnonymousSessionTransition({
  identityProvider,
  sessionExchangeClient,
  writeStoredIdentity,
  readStoredAnonymousIdentity,
  writeStoredAnonymousIdentity,
  setStatus = () => {},
  logOther = () => {},
  errorLogger = console,
  reloadPage = defaultReloadPage,
  bootstrapAuthSessionFn = bootstrapAuthSession,
} = {}) {
  try {
    setStatus("Signing out...");
    const anonymousIdentity =
      typeof readStoredAnonymousIdentity === "function" ? readStoredAnonymousIdentity() : null;
    await identityProvider.signOut();
    await identityProvider.initAnonymousSession();

    if (anonymousIdentity) {
      writeStoredIdentity(anonymousIdentity);
      setStatus("Signed out. Restoring anonymous session...");
      reloadPage();
      return {
        ok: true,
        restoredAnonymousIdentity: true,
      };
    }

    const bootstrap = await bootstrapAuthSessionFn({
      identityProvider,
      sessionExchangeClient,
      readStoredIdentity: () => null,
      writeStoredIdentity,
      allowLegacyFallback: false,
      forceRefresh: true,
    });
    writeStoredAnonymousIdentity({
      uid: bootstrap.session.uid,
      name: bootstrap.session.name,
      token: bootstrap.session.token,
    });
    setStatus("Signed out. New anonymous session ready.");
    reloadPage();
    return {
      ok: true,
      restoredAnonymousIdentity: false,
    };
  } catch (error) {
    const message = errorMessageOf(error);
    logOther("auth google_logout_failed", {
      error: message,
    });
    logError(errorLogger, "auth google_logout_failed", message);
    setStatus(`Google logout failed. ${message}`);
    return {
      ok: false,
      error: message,
    };
  }
}
