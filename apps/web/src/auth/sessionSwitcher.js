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
  setStatus = () => {},
  logOther = () => {},
  errorLogger = console,
  reloadPage = defaultReloadPage,
  signInWithGoogleSessionFn = signInWithGoogleSession,
} = {}) {
  try {
    await identityProvider.initAnonymousSession();

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
  setStatus = () => {},
  logOther = () => {},
  errorLogger = console,
  reloadPage = defaultReloadPage,
  bootstrapAuthSessionFn = bootstrapAuthSession,
} = {}) {
  try {
    setStatus("Signing out...");
    await identityProvider.signOut();
    await identityProvider.initAnonymousSession();

    // TODO(auth): Add scheduled backend cleanup for unlinked anonymous Firebase users older than 7 days.
    const bootstrap = await bootstrapAuthSessionFn({
      identityProvider,
      sessionExchangeClient,
      readStoredIdentity: () => null,
      writeStoredIdentity,
      allowLegacyFallback: false,
      forceRefresh: true,
    });
    setStatus("Signed out. New anonymous session ready.");
    reloadPage();
    return {
      ok: true,
      uid: bootstrap.session.uid,
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
