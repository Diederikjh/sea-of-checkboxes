export type ObservabilityScope =
  | "worker"
  | "connection_shard_do"
  | "cursor_hub_do"
  | "tile_owner_do"
  | "tile_owner_persistence";

export type WorkerLogMode = "verbose" | "reduced";

interface LogStructuredEventOptions {
  mode?: string | null | undefined;
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
  return mode === "reduced" ? "reduced" : "verbose";
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

export function shouldLogStructuredEvent(
  scope: ObservabilityScope,
  event: string,
  fields: Record<string, unknown> = {},
  options: LogStructuredEventOptions = {}
): boolean {
  const mode = normalizeWorkerLogMode(options.mode);
  if (mode === "verbose") {
    return true;
  }

  if (fields.error === true) {
    return true;
  }

  if (
    event === "internal_error"
    || event === "server_error_sent"
    || event === "cursor_pull_alarm_failed"
    || event === "tile_batch_order_anomaly"
    || event === "tile_pull_gap_resync"
    || event === "setcell_not_subscribed"
    || event === "snapshot_write_deferred"
  ) {
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

export function logStructuredEvent(
  scope: ObservabilityScope,
  event: string,
  fields: Record<string, unknown> = {},
  options: LogStructuredEventOptions = {}
): void {
  if (!shouldLogStructuredEvent(scope, event, fields, options)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    scope,
    event,
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
