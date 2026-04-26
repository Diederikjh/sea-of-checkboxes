import { describe, expect, it, vi } from "vitest";

import {
  createFirebaseAnalyticsReporter,
} from "../src/firebaseAnalytics";
import {
  resolveFirebaseAnalyticsConfigFromEnv,
  resolveFirebaseAnalyticsCookieDomain,
  resolveFirebaseConfigFromEnv,
} from "../src/firebaseConfig";

function analyticsConfig() {
  return {
    apiKey: "api-key",
    authDomain: "example.firebaseapp.com",
    projectId: "example",
    appId: "1:123:web:abc",
    measurementId: "G-ABC123",
  };
}

describe("firebase analytics", () => {
  it("allows auth config without analytics measurement id", () => {
    expect(resolveFirebaseConfigFromEnv({
      VITE_FIREBASE_API_KEY: "api-key",
      VITE_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
      VITE_FIREBASE_PROJECT_ID: "example",
      VITE_FIREBASE_APP_ID: "1:123:web:abc",
    })).toEqual({
      apiKey: "api-key",
      authDomain: "example.firebaseapp.com",
      projectId: "example",
      appId: "1:123:web:abc",
    });
  });

  it("requires measurement id in addition to base firebase config", () => {
    expect(resolveFirebaseAnalyticsConfigFromEnv({
      VITE_FIREBASE_API_KEY: "api-key",
      VITE_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
      VITE_FIREBASE_PROJECT_ID: "example",
      VITE_FIREBASE_APP_ID: "1:123:web:abc",
    })).toBeNull();

    expect(resolveFirebaseAnalyticsConfigFromEnv({
      VITE_FIREBASE_API_KEY: "api-key",
      VITE_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
      VITE_FIREBASE_PROJECT_ID: "example",
      VITE_FIREBASE_APP_ID: "1:123:web:abc",
      VITE_FIREBASE_MEASUREMENT_ID: "G-ABC123",
    })).toEqual(analyticsConfig());
  });

  it("uses host-only analytics cookies when running in a browser", () => {
    expect(resolveFirebaseAnalyticsCookieDomain({
      locationLike: { hostname: "sea-of-checkboxes-web.pages.dev" },
    })).toBe("none");

    expect(resolveFirebaseAnalyticsCookieDomain({
      locationLike: { hostname: "localhost" },
    })).toBe("none");

    expect(resolveFirebaseAnalyticsCookieDomain({
      locationLike: { hostname: "future.example.com" },
    })).toBe("none");
  });

  it("initializes analytics once and logs events", async () => {
    const app = {};
    const getAnalytics = vi.fn(() => "analytics-instance");
    const logEvent = vi.fn();
    const initializeApp = vi.fn(() => app);
    const reporter = createFirebaseAnalyticsReporter({
      config: analyticsConfig(),
      sdkLoader: async () => ({
        getApp: vi.fn(),
        getApps: vi.fn(() => []),
        initializeApp,
        getAnalytics,
        isSupported: vi.fn().mockResolvedValue(true),
        logEvent,
      }),
    });

    await reporter.logEvent("beta_session_start", { share_link: 0 });
    await reporter.logEvent("set_cell", { value: 1 });

    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(initializeApp).toHaveBeenCalledWith(analyticsConfig());
    expect(getAnalytics).toHaveBeenCalledWith(app);
    expect(logEvent).toHaveBeenCalledWith("analytics-instance", "beta_session_start", { share_link: 0 });
    expect(logEvent).toHaveBeenCalledWith("analytics-instance", "set_cell", { value: 1 });
  });

  it("passes an explicit cookie domain mode to Firebase Analytics when configured", async () => {
    const app = {};
    const getAnalytics = vi.fn();
    const initializeAnalytics = vi.fn(() => "analytics-instance");
    const logEvent = vi.fn();
    const initializeApp = vi.fn(() => app);
    const reporter = createFirebaseAnalyticsReporter({
      config: analyticsConfig(),
      cookieDomain: "none",
      sdkLoader: async () => ({
        getApp: vi.fn(),
        getApps: vi.fn(() => []),
        initializeApp,
        initializeAnalytics,
        getAnalytics,
        isSupported: vi.fn().mockResolvedValue(true),
        logEvent,
      }),
    });

    await reporter.logEvent("beta_session_start", { share_link: 0 });

    expect(initializeApp).toHaveBeenCalledWith(analyticsConfig());
    expect(initializeAnalytics).toHaveBeenCalledWith(app, {
      config: {
        cookie_domain: "none",
      },
    });
    expect(getAnalytics).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("analytics-instance", "beta_session_start", { share_link: 0 });
  });

  it("does not log when analytics is unsupported in the current browser", async () => {
    const logEvent = vi.fn();
    const reporter = createFirebaseAnalyticsReporter({
      config: analyticsConfig(),
      sdkLoader: async () => ({
        getApp: vi.fn(),
        getApps: vi.fn(() => []),
        initializeApp: vi.fn(),
        getAnalytics: vi.fn(),
        isSupported: vi.fn().mockResolvedValue(false),
        logEvent,
      }),
    });

    await reporter.logEvent("beta_session_start");

    expect(logEvent).not.toHaveBeenCalled();
  });
});
