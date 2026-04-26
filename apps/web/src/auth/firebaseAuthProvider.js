import { normalizeAuthPrincipal } from "./contracts";
import { normalizeFirebaseConfig } from "../firebaseConfig";

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
    signInWithPopup: auth.signInWithPopup,
    signInWithCredential: auth.signInWithCredential,
    onAuthStateChanged: auth.onAuthStateChanged,
    unlink: auth.unlink,
    deleteUser: auth.deleteUser,
    signOut: auth.signOut,
  };
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
      const beforeLinkUser = auth.currentUser;
      const wasAnonymousBeforeLink = beforeLinkUser.isAnonymous === true;
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
        // If Google already belongs to another Firebase user, sign in as that user.
        if (code === "auth/credential-already-in-use") {
          const googleCredential =
            typeof sdk.GoogleAuthProvider?.credentialFromError === "function"
              ? sdk.GoogleAuthProvider.credentialFromError(error)
              : null;

          let signInResult;
          if (googleCredential && typeof sdk.signInWithCredential === "function") {
            signInResult = await sdk.signInWithCredential(auth, googleCredential);
          } else {
            signInResult = await sdk.signInWithPopup(auth, provider);
          }

          const signedInUser = signInResult?.user ?? auth.currentUser;
          if (!signedInUser) {
            throw new Error("Missing firebase user after google sign-in");
          }

          // Clean up the temporary anonymous user after successful account switch.
          if (wasAnonymousBeforeLink && beforeLinkUser.uid !== signedInUser.uid) {
            try {
              await sdk.deleteUser(beforeLinkUser);
            } catch (deleteError) {
              console.warn("firebase_anonymous_delete_failed", {
                error: deleteError instanceof Error ? deleteError.message : String(deleteError),
              });
            }
          }

          return toPrincipal(signedInUser);
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
