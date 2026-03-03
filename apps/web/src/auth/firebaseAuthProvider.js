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

async function loadFirebaseSdk() {
  const appModuleName = "firebase/app";
  const authModuleName = "firebase/auth";
  const [{ getApp, getApps, initializeApp }, auth] = await Promise.all([
    import(/* @vite-ignore */ appModuleName),
    import(/* @vite-ignore */ authModuleName),
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

  const ensureUser = async () => {
    const { sdk, auth } = await ensureAuth();
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
      const result = await sdk.linkWithPopup(auth.currentUser, provider);
      const user = result?.user ?? auth.currentUser;
      return toPrincipal(user);
    },

    async signOut() {
      const { sdk, auth } = await ensureAuth();
      await sdk.signOut(auth);
    },
  };
}
