export type ObservabilityScope =
  | "worker"
  | "connection_shard_do"
  | "tile_owner_do"
  | "tile_owner_persistence";

export function logStructuredEvent(
  scope: ObservabilityScope,
  event: string,
  fields: Record<string, unknown> = {}
): void {
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
