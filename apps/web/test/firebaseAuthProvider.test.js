import { describe, expect, it, vi } from "vitest";

import { createFirebaseAuthIdentityProvider } from "../src/auth/firebaseAuthProvider";

function firebaseConfig() {
  return {
    apiKey: "api-key",
    authDomain: "example.firebaseapp.com",
    projectId: "example",
    appId: "1:123:web:abc",
  };
}

describe("firebase auth identity provider", () => {
  it("waits for auth state hydration before creating a new anonymous user", async () => {
    const existingUser = {
      uid: "firebase_existing",
      isAnonymous: false,
    };
    const auth = {
      currentUser: null,
      async authStateReady() {
        auth.currentUser = existingUser;
      },
    };
    const signInAnonymously = vi.fn();
    const getAuth = vi.fn().mockReturnValue(auth);

    const provider = createFirebaseAuthIdentityProvider({
      config: firebaseConfig(),
      sdkLoader: async () => ({
        getApp: vi.fn(),
        getApps: vi.fn().mockReturnValue([]),
        initializeApp: vi.fn().mockReturnValue({}),
        getAuth,
        signInAnonymously,
        getIdToken: vi.fn().mockResolvedValue("token"),
        GoogleAuthProvider: class GoogleAuthProvider {},
        linkWithPopup: vi.fn(),
        signInWithPopup: vi.fn(),
        onAuthStateChanged: vi.fn(),
        unlink: vi.fn(),
        deleteUser: vi.fn(),
        signOut: vi.fn(),
      }),
    });

    const principal = await provider.initAnonymousSession();
    expect(principal).toEqual({
      provider: "firebase",
      providerUserId: "firebase_existing",
      isAnonymous: false,
    });
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(getAuth).toHaveBeenCalledTimes(1);
  });

  it("creates anonymous user when no hydrated user exists", async () => {
    const auth = {
      currentUser: null,
      authStateReady: vi.fn().mockResolvedValue(undefined),
    };
    const anonymousUser = {
      uid: "firebase_anon",
      isAnonymous: true,
    };
    const signInAnonymously = vi.fn().mockImplementation(async () => {
      auth.currentUser = anonymousUser;
      return { user: anonymousUser };
    });

    const provider = createFirebaseAuthIdentityProvider({
      config: firebaseConfig(),
      sdkLoader: async () => ({
        getApp: vi.fn(),
        getApps: vi.fn().mockReturnValue([]),
        initializeApp: vi.fn().mockReturnValue({}),
        getAuth: vi.fn().mockReturnValue(auth),
        signInAnonymously,
        getIdToken: vi.fn().mockResolvedValue("token"),
        GoogleAuthProvider: class GoogleAuthProvider {},
        linkWithPopup: vi.fn(),
        signInWithPopup: vi.fn(),
        onAuthStateChanged: vi.fn(),
        unlink: vi.fn(),
        deleteUser: vi.fn(),
        signOut: vi.fn(),
      }),
    });

    const principal = await provider.initAnonymousSession();
    expect(principal).toEqual({
      provider: "firebase",
      providerUserId: "firebase_anon",
      isAnonymous: true,
    });
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it("treats provider-already-linked as success during google link retries", async () => {
    const auth = {
      currentUser: {
        uid: "firebase_existing_google",
        isAnonymous: false,
      },
      authStateReady: vi.fn().mockResolvedValue(undefined),
    };

    const provider = createFirebaseAuthIdentityProvider({
      config: firebaseConfig(),
      sdkLoader: async () => ({
        getApp: vi.fn(),
        getApps: vi.fn().mockReturnValue([]),
        initializeApp: vi.fn().mockReturnValue({}),
        getAuth: vi.fn().mockReturnValue(auth),
        signInAnonymously: vi.fn(),
        getIdToken: vi.fn().mockResolvedValue("token"),
        GoogleAuthProvider: class GoogleAuthProvider {},
        linkWithPopup: vi.fn().mockRejectedValue({ code: "auth/provider-already-linked" }),
        signInWithPopup: vi.fn(),
        onAuthStateChanged: vi.fn(),
        unlink: vi.fn(),
        deleteUser: vi.fn(),
        signOut: vi.fn(),
      }),
    });

    await expect(provider.linkGoogle()).resolves.toEqual({
      provider: "firebase",
      providerUserId: "firebase_existing_google",
      isAnonymous: false,
    });
  });

  it("treats no-such-provider as success during google unlink retries", async () => {
    const auth = {
      currentUser: {
        uid: "firebase_existing_google",
        isAnonymous: false,
      },
      authStateReady: vi.fn().mockResolvedValue(undefined),
    };

    const provider = createFirebaseAuthIdentityProvider({
      config: firebaseConfig(),
      sdkLoader: async () => ({
        getApp: vi.fn(),
        getApps: vi.fn().mockReturnValue([]),
        initializeApp: vi.fn().mockReturnValue({}),
        getAuth: vi.fn().mockReturnValue(auth),
        signInAnonymously: vi.fn(),
        getIdToken: vi.fn().mockResolvedValue("token"),
        GoogleAuthProvider: class GoogleAuthProvider {},
        linkWithPopup: vi.fn(),
        signInWithPopup: vi.fn(),
        onAuthStateChanged: vi.fn(),
        unlink: vi.fn().mockRejectedValue({ code: "auth/no-such-provider" }),
        deleteUser: vi.fn(),
        signOut: vi.fn(),
      }),
    });

    await expect(provider.unlinkGoogle()).resolves.toEqual({
      provider: "firebase",
      providerUserId: "firebase_existing_google",
      isAnonymous: false,
    });
  });

  it("signs in to existing google account when credential is already in use and deletes anonymous source user", async () => {
    const anonymousSourceUser = {
      uid: "firebase_anon_source",
      isAnonymous: true,
    };
    const googleUser = {
      uid: "firebase_google_user",
      isAnonymous: false,
    };
    const auth = {
      currentUser: anonymousSourceUser,
      authStateReady: vi.fn().mockResolvedValue(undefined),
    };
    const signInWithPopup = vi.fn().mockImplementation(async () => {
      auth.currentUser = googleUser;
      return { user: googleUser };
    });
    const deleteUser = vi.fn().mockResolvedValue(undefined);

    const provider = createFirebaseAuthIdentityProvider({
      config: firebaseConfig(),
      sdkLoader: async () => ({
        getApp: vi.fn(),
        getApps: vi.fn().mockReturnValue([]),
        initializeApp: vi.fn().mockReturnValue({}),
        getAuth: vi.fn().mockReturnValue(auth),
        signInAnonymously: vi.fn(),
        getIdToken: vi.fn().mockResolvedValue("token"),
        GoogleAuthProvider: class GoogleAuthProvider {},
        linkWithPopup: vi.fn().mockRejectedValue({ code: "auth/credential-already-in-use" }),
        signInWithPopup,
        onAuthStateChanged: vi.fn(),
        unlink: vi.fn(),
        deleteUser,
        signOut: vi.fn(),
      }),
    });

    await expect(provider.linkGoogle()).resolves.toEqual({
      provider: "firebase",
      providerUserId: "firebase_google_user",
      isAnonymous: false,
    });
    expect(signInWithPopup).toHaveBeenCalledTimes(1);
    expect(deleteUser).toHaveBeenCalledWith(anonymousSourceUser);
  });
});
