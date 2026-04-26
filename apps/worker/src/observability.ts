export type ObservabilityScope =
  | "worker"
  | "connection_shard_do"
  | "cursor_hub_do"
  | "tile_owner_do"
  | "tile_owner_persistence";

export type WorkerLogMode = "verbose" | "reduced" | "sampled" | "errors";
export type WorkerLogPolicy =
  | "always_error"
  | "verbose_global"
  | "reduced_global"
  | "sampled_in"
  | "forced_reduced"
  | "forced_verbose"
  | "backend_reduced_no_session"
  | "override_expired";

interface WorkerLogControlEnv {
  WORKER_LOG_MODE?: string;
  WORKER_LOG_SAMPLE_RATE?: string;
  WORKER_LOG_FORCE_REDUCED_SESSION_IDS?: string;
  WORKER_LOG_FORCE_VERBOSE_SESSION_IDS?: string;
  WORKER_LOG_FORCE_SESSION_PREFIXES?: string;
  WORKER_LOG_ALLOW_CLIENT_VERBOSE?: string;
}

interface LogStructuredEventOptions {
  mode?: string | null | undefined;
  sampleRate?: string | null | undefined;
  forceReducedSessionIds?: string | null | undefined;
  forceVerboseSessionIds?: string | null | undefined;
  forceSessionPrefixes?: string | null | undefined;
  allowClientVerbose?: string | null | undefined;
  nowMs?: number | undefined;
}

const REDUCED_MODE_CONNECTION_SHARD_EVENTS = new Set([
  "cursor_first_local_publish",
  "cursor_local_publish",
  "cursor_remote_ingest",
  "tile_batch_ingress",
  "tile_batch_no_local_subscribers",
  "cursor_state_snapshot_served",
  "cursor_pull_alarm_fired",
  "cursor_pull_alarm_stale",
  "cursor_pull_scope",
  "cursor_pull_scope_unchanged",
  "cursor_pull_cycle",
  "cursor_pull_peer",
  "cursor_pull_first_peer_visibility",
  "cursor_pull_pre_visibility_observation",
  "setCell_received",
  "sub",
  "unsub",
]);

const REDUCED_MODE_CURSOR_HUB_EVENTS = new Set([
  "watch_sub",
  "watch_unsub",
  "publish",
  "activity",
]);

function normalizeWorkerLogMode(mode: string | null | undefined): WorkerLogMode {
  if (mode === "reduced" || mode === "sampled" || mode === "errors") {
    return mode;
  }
  return "verbose";
}

function toBool(value: string | null | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseCsvList(value: string | null | undefined): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseSampleRate(value: string | null | undefined): number {
  if (typeof value !== "string") {
    return 0;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.min(1, parsed));
}

function resolveClientSessionId(fields: Record<string, unknown>): string | null {
  const sessionId = typeof fields.client_session_id === "string" ? fields.client_session_id.trim() : "";
  return sessionId.length > 0 ? sessionId : null;
}

function resolveClientDebugLogLevel(fields: Record<string, unknown>): "reduced" | "verbose" | null {
  const level =
    typeof fields.client_debug_log_level === "string"
      ? fields.client_debug_log_level.trim().toLowerCase()
      : "";
  if (level === "reduced" || level === "verbose") {
    return level;
  }
  return null;
}

function resolveClientDebugLogExpiresAtMs(fields: Record<string, unknown>): number | null {
  const raw = fields.client_debug_log_expires_at_ms;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function sampleSessionId(sessionId: string, sampleRate: number): boolean {
  if (sampleRate >= 1) {
    return true;
  }
  if (sampleRate <= 0) {
    return false;
  }

  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const normalized = (hash >>> 0) / 0xffffffff;
  return normalized < sampleRate;
}

function shouldAlwaysLogEvent(event: string, fields: Record<string, unknown>): boolean {
  if (event === "log_override_expired") {
    return true;
  }

  if (fields.error === true) {
    return true;
  }

  return (
    event === "internal_error"
    || event === "server_error_sent"
    || event === "cursor_pull_alarm_failed"
    || event === "tile_batch_order_anomaly"
    || event === "tile_pull_gap_resync"
    || event === "setcell_not_subscribed"
    || event === "snapshot_write_deferred"
  );
}

function isTileOwnerSuccessEvent(event: string, fields: Record<string, unknown>): boolean {
  if (event === "sub") {
    return fields.accepted === true;
  }
  if (event !== "setCell") {
    return false;
  }
  return fields.accepted === true && typeof fields.reason === "undefined";
}

function isPersistenceSuccessEvent(event: string, fields: Record<string, unknown>): boolean {
  return (event === "snapshot_read" || event === "snapshot_write") && fields.error !== true;
}

function shouldLogInReducedMode(
  scope: ObservabilityScope,
  event: string,
  fields: Record<string, unknown> = {}
): boolean {
  if (shouldAlwaysLogEvent(event, fields)) {
    return true;
  }

  switch (scope) {
    case "connection_shard_do":
      if (event === "setCell") {
        return fields.accepted !== true || typeof fields.reason !== "undefined";
      }
      return !REDUCED_MODE_CONNECTION_SHARD_EVENTS.has(event);
    case "cursor_hub_do":
      return !REDUCED_MODE_CURSOR_HUB_EVENTS.has(event);
    case "tile_owner_do":
      return !isTileOwnerSuccessEvent(event, fields);
    case "tile_owner_persistence":
      return !isPersistenceSuccessEvent(event, fields);
    default:
      return true;
  }
}

export function buildLogStructuredEventOptions(
  env: WorkerLogControlEnv,
  nowMs?: number
): LogStructuredEventOptions {
  return {
    mode: env.WORKER_LOG_MODE,
    sampleRate: env.WORKER_LOG_SAMPLE_RATE,
    forceReducedSessionIds: env.WORKER_LOG_FORCE_REDUCED_SESSION_IDS,
    forceVerboseSessionIds: env.WORKER_LOG_FORCE_VERBOSE_SESSION_IDS,
    forceSessionPrefixes: env.WORKER_LOG_FORCE_SESSION_PREFIXES,
    allowClientVerbose: env.WORKER_LOG_ALLOW_CLIENT_VERBOSE,
    ...(typeof nowMs === "number" ? { nowMs } : {}),
  };
}

export function resolveStructuredLogPolicy(
  scope: ObservabilityScope,
  event: string,
  fields: Record<string, unknown> = {},
  options: LogStructuredEventOptions = {}
): WorkerLogPolicy | null {
  if (event === "log_override_expired") {
    return "override_expired";
  }

  if (shouldAlwaysLogEvent(event, fields)) {
    return "always_error";
  }

  const mode = normalizeWorkerLogMode(options.mode);
  if (mode === "verbose") {
    return "verbose_global";
  }

  const sessionId = resolveClientSessionId(fields);
  const nowMs = typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const clientDebugLevel = resolveClientDebugLogLevel(fields);
  const clientDebugExpiresAtMs = resolveClientDebugLogExpiresAtMs(fields);
  const clientDebugActive =
    clientDebugLevel !== null
    && clientDebugExpiresAtMs !== null
    && clientDebugExpiresAtMs > nowMs;

  if (sessionId) {
    const forceVerboseSessions = new Set(parseCsvList(options.forceVerboseSessionIds));
    if (forceVerboseSessions.has(sessionId)) {
      return "forced_verbose";
    }

    const forceSessionPrefixes = parseCsvList(options.forceSessionPrefixes);
    if (forceSessionPrefixes.some((prefix) => sessionId.startsWith(prefix))) {
      return "forced_verbose";
    }

    if (clientDebugActive && clientDebugLevel === "verbose" && toBool(options.allowClientVerbose)) {
      return "forced_verbose";
    }
  }

  if (!shouldLogInReducedMode(scope, event, fields)) {
    return null;
  }

  if (mode === "reduced") {
    return "reduced_global";
  }

  if (!sessionId) {
    return mode === "sampled" ? "backend_reduced_no_session" : null;
  }

  const forceReducedSessions = new Set(parseCsvList(options.forceReducedSessionIds));
  if (forceReducedSessions.has(sessionId)) {
    return "forced_reduced";
  }

  if (clientDebugActive && clientDebugLevel === "reduced") {
    return "forced_reduced";
  }

  if (mode === "errors") {
    return null;
  }

  return sampleSessionId(sessionId, parseSampleRate(options.sampleRate)) ? "sampled_in" : null;
}

export function shouldLogStructuredEvent(
  scope: ObservabilityScope,
  event: string,
  fields: Record<string, unknown> = {},
  options: LogStructuredEventOptions = {}
): boolean {
  return resolveStructuredLogPolicy(scope, event, fields, options) !== null;
}

export function logStructuredEvent(
  scope: ObservabilityScope,
  event: string,
  fields: Record<string, unknown> = {},
  options: LogStructuredEventOptions = {}
): void {
  const logPolicy = resolveStructuredLogPolicy(scope, event, fields, options);
  if (!logPolicy) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    scope,
    event,
    ...(typeof fields.log_policy === "string" ? {} : { log_policy: logPolicy }),
    ...fields,
  };

  try {
    console.log(JSON.stringify(payload));
  } catch {
    console.log(
      JSON.stringify({
        ts: payload.ts,
        scope,
        event,
      })
    );
  }
}

export function elapsedMs(startMs: number): number {
  return Date.now() - startMs;
}
