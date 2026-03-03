import type { Env } from "../doCommon";

export type AuthMode = "legacy" | "hybrid" | "firebase_only";

export function resolveAuthMode(env: Env): AuthMode {
  const raw = typeof env.AUTH_MODE === "string" ? env.AUTH_MODE.trim().toLowerCase() : "";
  if (raw === "legacy" || raw === "hybrid" || raw === "firebase_only") {
    return raw;
  }
  return "hybrid";
}
