import type { Env } from "./doCommon";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export type WorkerUnavailableReason = "app_disabled" | "missing_identity_signing_secret";

export interface WorkerRuntimeControls {
  appDisabled: boolean;
  readOnlyMode: boolean;
  anonAuthEnabled: boolean;
  shareLinksEnabled: boolean;
  identitySigningSecret: string | null;
  unavailableReason: WorkerUnavailableReason | null;
}

function readBoolFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== "string") {
    return defaultValue;
  }

  return TRUE_VALUES.has(value.trim().toLowerCase());
}

export function resolveWorkerRuntimeControls(env: Env): WorkerRuntimeControls {
  const identitySigningSecret =
    typeof env.IDENTITY_SIGNING_SECRET === "string" ? env.IDENTITY_SIGNING_SECRET.trim() : "";
  const appDisabled = readBoolFlag(env.APP_DISABLED, false);
  const readOnlyMode = readBoolFlag(env.READONLY_MODE, false);
  const anonAuthEnabled = readBoolFlag(env.ANON_AUTH_ENABLED, true);
  const shareLinksEnabled = readBoolFlag(env.SHARE_LINKS_ENABLED, true);

  return {
    appDisabled,
    readOnlyMode,
    anonAuthEnabled,
    shareLinksEnabled,
    identitySigningSecret: identitySigningSecret.length > 0 ? identitySigningSecret : null,
    unavailableReason: appDisabled
      ? "app_disabled"
      : identitySigningSecret.length > 0
        ? null
        : "missing_identity_signing_secret",
  };
}
