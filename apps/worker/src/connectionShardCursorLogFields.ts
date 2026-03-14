import type { ConnectedClient } from "./connectionShardDOOperations";

interface CursorLocalPublishLogFieldsInput {
  client: ConnectedClient | undefined;
  connectionAgeMs?: number | undefined;
  cursor: {
    uid: string;
    seq: number;
    tileKey: string;
    x: number;
    y: number;
  };
  fanoutCount: number;
}

export function buildCursorLocalPublishLogFields({
  client,
  connectionAgeMs,
  cursor,
  fanoutCount,
}: CursorLocalPublishLogFieldsInput): Record<string, unknown> {
  return {
    uid: cursor.uid,
    seq: cursor.seq,
    tile: cursor.tileKey,
    x: cursor.x,
    y: cursor.y,
    fanout_count: fanoutCount,
    ...(typeof connectionAgeMs === "number" ? { connection_age_ms: connectionAgeMs } : {}),
    ...(client?.clientSessionId ? { client_session_id: client.clientSessionId } : {}),
  };
}

export function buildCursorFirstLocalPublishLogFields(
  input: CursorLocalPublishLogFieldsInput
): Record<string, unknown> {
  return {
    ...buildCursorLocalPublishLogFields(input),
    subscribed_count: input.client?.subscribed.size ?? 0,
  };
}
