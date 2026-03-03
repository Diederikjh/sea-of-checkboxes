import { normalizeAuthPrincipal } from "./contracts";

function normalizeFirebaseConfig(config) {
  if (!config || typeof config !== "object") {
    return null;
  }

  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const authDomain = typeof config.authDomain === "string" ? config.authDomain.trim() : "";
  const projectId = typeof config.projectId === "string" ? config.projectId.trim() : "";
  const appId = typeof config.appId === "string" ? config.appId.trim() : "";
  if (apiKey.length === 0 || authDomain.length === 0 || projectId.length === 0 || appId.length === 0) {
    return null;
  }

  return {
    apiKey,
    authDomain,
    projectId,
    appId,
  };
}

function toPrincipal(user) {
  const principal = normalizeAuthPrincipal({
    provider: "firebase",
    providerUserId: user?.uid,
    isAnonymous: user?.isAnonymous === true,
  });

  if (!principal) {
    throw new Error("Missing firebase user principal");
  }

  return principal;
}

function firebaseErrorCode(error) {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") {
    return "";
  }

  return error.code;
}

async function loadFirebaseSdk() {
  const [{ getApp, getApps, initializeApp }, auth] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
  ]);

  return {
    getApp,
    getApps,
    initializeApp,
    getAuth: auth.getAuth,
    signInAnonymously: auth.signInAnonymously,
    getIdToken: auth.getIdToken,
    GoogleAuthProvider: auth.GoogleAuthProvider,
    linkWithPopup: auth.linkWithPopup,
    onAuthStateChanged: auth.onAuthStateChanged,
    unlink: auth.unlink,
    signOut: auth.signOut,
  };
}

export function resolveFirebaseConfigFromEnv(
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {}
) {
  return normalizeFirebaseConfig({
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  });
}

export function createFirebaseAuthIdentityProvider({
  config,
  sdkLoader = loadFirebaseSdk,
} = {}) {
  const normalizedConfig = normalizeFirebaseConfig(config);
  if (!normalizedConfig) {
    throw new Error("Invalid Firebase config");
  }

  let sdkPromise = null;
  let authInstance = null;
  let authReadyPromise = null;

  const ensureAuth = async () => {
    if (!sdkPromise) {
      sdkPromise = sdkLoader();
    }

    const sdk = await sdkPromise;
    if (!authInstance) {
      const app = sdk.getApps().length > 0 ? sdk.getApp() : sdk.initializeApp(normalizedConfig);
      authInstance = sdk.getAuth(app);
    }

    return {
      sdk,
      auth: authInstance,
    };
  };

  const waitForAuthStateReady = async (sdk, auth) => {
    if (!authReadyPromise) {
      const authWithReady = auth;
      if (typeof authWithReady.authStateReady === "function") {
        authReadyPromise = authWithReady.authStateReady().catch(() => undefined);
      } else {
        authReadyPromise = new Promise((resolve) => {
          let unsubscribed = false;
          let unsubscribe = () => {
            unsubscribed = true;
          };

          try {
            unsubscribe = sdk.onAuthStateChanged(
              auth,
              () => {
                if (!unsubscribed) {
                  unsubscribe();
                  unsubscribed = true;
                }
                resolve();
              },
              () => {
                if (!unsubscribed) {
                  unsubscribe();
                  unsubscribed = true;
                }
                resolve();
              }
            );
          } catch {
            resolve();
          }
        });
      }
    }

    await authReadyPromise;
  };

  const ensureUser = async () => {
    const { sdk, auth } = await ensureAuth();
    await waitForAuthStateReady(sdk, auth);
    if (!auth.currentUser) {
      await sdk.signInAnonymously(auth);
    }

    if (!auth.currentUser) {
      throw new Error("Unable to create firebase anonymous user");
    }

    return {
      sdk,
      auth,
      user: auth.currentUser,
    };
  };

  return {
    async initAnonymousSession() {
      const { user } = await ensureUser();
      return toPrincipal(user);
    },

    async getAssertionToken(forceRefresh = false) {
      const { sdk, auth } = await ensureAuth();
      if (!auth.currentUser) {
        await ensureUser();
      }
      if (!auth.currentUser) {
        throw new Error("Missing firebase user for id token request");
      }
      return sdk.getIdToken(auth.currentUser, forceRefresh);
    },

    async linkGoogle() {
      const { sdk, auth } = await ensureUser();
      if (!auth.currentUser) {
        throw new Error("Missing firebase user for google link");
      }
      const provider = new sdk.GoogleAuthProvider();
      try {
        const result = await sdk.linkWithPopup(auth.currentUser, provider);
        const user = result?.user ?? auth.currentUser;
        return toPrincipal(user);
      } catch (error) {
        const code = firebaseErrorCode(error);
        // Treat "already linked" as success for retry-safe UX.
        if (code === "auth/provider-already-linked") {
          return toPrincipal(auth.currentUser);
        }
        throw error;
      }
    },

    async unlinkGoogle() {
      const { sdk, auth } = await ensureUser();
      if (!auth.currentUser) {
        throw new Error("Missing firebase user for google unlink");
      }

      try {
        const user = await sdk.unlink(auth.currentUser, "google.com");
        return toPrincipal(user ?? auth.currentUser);
      } catch (error) {
        const code = firebaseErrorCode(error);
        // Treat "already unlinked" as success for idempotent UX.
        if (code === "auth/no-such-provider") {
          return toPrincipal(auth.currentUser);
        }
        throw error;
      }
    },

    async signOut() {
      const { sdk, auth } = await ensureAuth();
      await sdk.signOut(auth);
    },
  };
}
