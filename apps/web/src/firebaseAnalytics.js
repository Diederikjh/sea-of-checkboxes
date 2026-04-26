import { normalizeFirebaseConfig } from "./firebaseConfig";

async function loadFirebaseAnalyticsSdk() {
  const [appSdk, analyticsSdk] = await Promise.all([
    import("firebase/app"),
    import("firebase/analytics"),
  ]);

  return {
    getApp: appSdk.getApp,
    getApps: appSdk.getApps,
    initializeApp: appSdk.initializeApp,
    getAnalytics: analyticsSdk.getAnalytics,
    isSupported: analyticsSdk.isSupported,
    logEvent: analyticsSdk.logEvent,
  };
}

export function createFirebaseAnalyticsReporter({
  config,
  sdkLoader = loadFirebaseAnalyticsSdk,
  warningLogger = console,
} = {}) {
  const normalizedConfig = normalizeFirebaseConfig(config, { requireMeasurementId: true });
  if (!normalizedConfig) {
    throw new Error("Invalid Firebase Analytics config");
  }

  let analyticsPromise = null;

  const ensureAnalytics = async () => {
    if (!analyticsPromise) {
      analyticsPromise = (async () => {
        const sdk = await sdkLoader();
        const supported = typeof sdk.isSupported === "function" ? await sdk.isSupported() : true;
        if (!supported) {
          return null;
        }

        const app = sdk.getApps().length > 0 ? sdk.getApp() : sdk.initializeApp(normalizedConfig);
        return {
          analytics: sdk.getAnalytics(app),
          logEvent: sdk.logEvent,
        };
      })().catch((error) => {
        warningLogger?.warn?.("firebase_analytics_init_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    }

    return analyticsPromise;
  };

  return {
    async logEvent(name, params = {}) {
      const analytics = await ensureAnalytics();
      if (!analytics) {
        return;
      }

      try {
        analytics.logEvent(analytics.analytics, name, params);
      } catch (error) {
        warningLogger?.warn?.("firebase_analytics_event_failed", {
          event: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
