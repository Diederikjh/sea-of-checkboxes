import {
  MAX_TILES_SUBSCRIBED,
  MAX_TILE_CHURN_PER_MIN,
  SETCELL_BURST_PER_SEC,
  SETCELL_SUSTAINED_PER_SEC,
  SETCELL_SUSTAINED_WINDOW_MS,
} from "@sea/domain";
import type {
  ClientMessage,
  ServerMessage,
} from "@sea/protocol";

import {
  isValidTileKey,
  type TileSetCellRequest,
  type TileSetCellResponse,
} from "./doCommon";
import type { SocketLike } from "./socketPair";

export interface ConnectedClient {
  uid: string;
  name: string;
  socket: SocketLike;
  subscribed: Set<string>;
  churnTimestamps?: number[];
  setCellBurstTimestamps?: number[];
  setCellSustainedTimestamps?: number[];
  lastCursorX?: number | null;
  lastCursorY?: number | null;
  cursorSubscriptions?: Set<string>;
}

export interface ConnectionShardDOOperationsContext {
  clients: Map<string, ConnectedClient>;
  tileToClients: Map<string, Set<string>>;
  sendServerMessage(client: ConnectedClient, message: ServerMessage): void;
  sendError(client: ConnectedClient, code: string, msg: string): void;
  sendBadTile(client: ConnectedClient, tileKey: string): void;
  watchTile(
    tileKey: string,
    action: "sub" | "unsub"
  ): Promise<{ ok: boolean; code?: string; msg?: string }>;
  setTileCell(payload: TileSetCellRequest): Promise<TileSetCellResponse | null>;
  sendSnapshotToClient(client: ConnectedClient, tileKey: string): Promise<void>;
  nowMs(): number;
}

type SubscriptionMessageResult = {
  requestedCount: number;
  changedCount: number;
  invalidCount: number;
  rejectedCount: number;
  clamped: boolean;
  subscribedCount: number;
};

type UnsubscriptionMessageResult = {
  requestedCount: number;
  changedCount: number;
  subscribedCount: number;
};

type SetCellMessageResult = {
  accepted: boolean;
  changed: boolean;
  reason?: string;
};

function recordWithinLimit(
  timestamps: number[],
  nowMs: number,
  windowMs: number,
  limit: number
): boolean {
  const cutoff = nowMs - windowMs;
  let writeIndex = 0;
  for (const timestamp of timestamps) {
    if (timestamp > cutoff) {
      timestamps[writeIndex] = timestamp;
      writeIndex += 1;
    }
  }
  timestamps.length = writeIndex;

  if (timestamps.length >= limit) {
    return false;
  }

  timestamps.push(nowMs);
  return true;
}

function consumeChurnOrError(
  context: ConnectionShardDOOperationsContext,
  client: ConnectedClient
): boolean {
  const timestamps = client.churnTimestamps ?? [];
  client.churnTimestamps = timestamps;
  const allowed = recordWithinLimit(
    timestamps,
    context.nowMs(),
    60_000,
    MAX_TILE_CHURN_PER_MIN
  );

  if (!allowed) {
    context.sendError(client, "churn_limit", "Tile churn limit exceeded");
    return false;
  }

  return true;
}

function consumeSetCellRateOrError(
  context: ConnectionShardDOOperationsContext,
  client: ConnectedClient
): boolean {
  const nowMs = context.nowMs();
  const burstTimestamps = client.setCellBurstTimestamps ?? [];
  const sustainedTimestamps = client.setCellSustainedTimestamps ?? [];
  client.setCellBurstTimestamps = burstTimestamps;
  client.setCellSustainedTimestamps = sustainedTimestamps;

  const burstAllowed = recordWithinLimit(
    burstTimestamps,
    nowMs,
    1_000,
    SETCELL_BURST_PER_SEC
  );

  const sustainedLimit = Math.floor((SETCELL_SUSTAINED_PER_SEC * SETCELL_SUSTAINED_WINDOW_MS) / 1_000);
  const sustainedAllowed = recordWithinLimit(
    sustainedTimestamps,
    nowMs,
    SETCELL_SUSTAINED_WINDOW_MS,
    sustainedLimit
  );

  if (!burstAllowed || !sustainedAllowed) {
    context.sendError(client, "setcell_limit", "setCell rate limit exceeded");
    return false;
  }

  return true;
}

async function removeClientFromTile(
  context: ConnectionShardDOOperationsContext,
  uid: string,
  tileKey: string
): Promise<void> {
  const subscribers = context.tileToClients.get(tileKey);
  if (!subscribers) {
    return;
  }

  subscribers.delete(uid);
  if (subscribers.size !== 0) {
    return;
  }

  context.tileToClients.delete(tileKey);
  await context.watchTile(tileKey, "unsub");
}

export async function handleSubMessage(
  context: ConnectionShardDOOperationsContext,
  client: ConnectedClient,
  tiles: string[]
): Promise<SubscriptionMessageResult> {
  const result: SubscriptionMessageResult = {
    requestedCount: tiles.length,
    changedCount: 0,
    invalidCount: 0,
    rejectedCount: 0,
    clamped: false,
    subscribedCount: client.subscribed.size,
  };

  for (const tileKey of tiles) {
    if (client.subscribed.has(tileKey)) {
      continue;
    }

    if (client.subscribed.size >= MAX_TILES_SUBSCRIBED) {
      context.sendError(client, "sub_limit", `Max ${MAX_TILES_SUBSCRIBED} tiles subscribed`);
      result.clamped = true;
      result.subscribedCount = client.subscribed.size;
      return result;
    }

    if (!consumeChurnOrError(context, client)) {
      result.clamped = true;
      result.subscribedCount = client.subscribed.size;
      return result;
    }

    if (!isValidTileKey(tileKey)) {
      context.sendBadTile(client, tileKey);
      result.invalidCount += 1;
      continue;
    }

    client.subscribed.add(tileKey);

    let subscribers = context.tileToClients.get(tileKey);
    if (!subscribers) {
      subscribers = new Set();
      context.tileToClients.set(tileKey, subscribers);
    }

    const wasEmpty = subscribers.size === 0;
    subscribers.add(client.uid);

    if (wasEmpty) {
      const watchResult = await context.watchTile(tileKey, "sub");
      if (!watchResult.ok) {
        subscribers.delete(client.uid);
        client.subscribed.delete(tileKey);
        if (subscribers.size === 0) {
          context.tileToClients.delete(tileKey);
        }
        context.sendError(client, watchResult.code ?? "watch_rejected", watchResult.msg ?? "Tile unavailable");
        result.rejectedCount += 1;
        continue;
      }
    }

    await context.sendSnapshotToClient(client, tileKey);
    result.changedCount += 1;
  }

  result.subscribedCount = client.subscribed.size;
  return result;
}

export async function handleUnsubMessage(
  context: ConnectionShardDOOperationsContext,
  client: ConnectedClient,
  tiles: string[]
): Promise<UnsubscriptionMessageResult> {
  const result: UnsubscriptionMessageResult = {
    requestedCount: tiles.length,
    changedCount: 0,
    subscribedCount: client.subscribed.size,
  };

  for (const tileKey of tiles) {
    if (!client.subscribed.has(tileKey)) {
      continue;
    }

    if (!consumeChurnOrError(context, client)) {
      result.subscribedCount = client.subscribed.size;
      return result;
    }

    client.subscribed.delete(tileKey);
    await removeClientFromTile(context, client.uid, tileKey);
    result.changedCount += 1;
  }

  result.subscribedCount = client.subscribed.size;
  return result;
}

export async function handleSetCellMessage(
  context: ConnectionShardDOOperationsContext,
  client: ConnectedClient,
  message: Extract<ClientMessage, { t: "setCell" }>
): Promise<SetCellMessageResult> {
  if (!consumeSetCellRateOrError(context, client)) {
    return { accepted: false, changed: false, reason: "setcell_limit" };
  }

  if (!isValidTileKey(message.tile)) {
    context.sendBadTile(client, message.tile);
    return { accepted: false, changed: false, reason: "bad_tile" };
  }

  if (!client.subscribed.has(message.tile)) {
    context.sendError(client, "not_subscribed", `Tile ${message.tile} is not currently subscribed`);
    await context.sendSnapshotToClient(client, message.tile);
    return { accepted: false, changed: false, reason: "not_subscribed" };
  }

  const result = await context.setTileCell({
    tile: message.tile,
    i: message.i,
    v: message.v,
    op: message.op,
    uid: client.uid,
    name: client.name,
    atMs: context.nowMs(),
  });

  if (!result?.accepted) {
    context.sendError(client, "setcell_rejected", result?.reason ?? "Rejected");
    return {
      accepted: false,
      changed: false,
      ...(result?.reason ? { reason: result.reason } : {}),
    };
  }

  if (!result.changed) {
    // Client may be stale and repeatedly submit no-op writes.
    // Send a fresh snapshot so local cache can converge.
    await context.sendSnapshotToClient(client, message.tile);
  }

  return {
    accepted: true,
    changed: result.changed,
  };
}

export async function handleResyncMessage(
  context: ConnectionShardDOOperationsContext,
  client: ConnectedClient,
  tileKey: string
): Promise<void> {
  if (!isValidTileKey(tileKey)) {
    context.sendBadTile(client, tileKey);
    return;
  }

  await context.sendSnapshotToClient(client, tileKey);
}

export async function disconnectClientFromShard(
  context: ConnectionShardDOOperationsContext,
  uid: string
): Promise<void> {
  const client = context.clients.get(uid);
  if (!client) {
    return;
  }

  context.clients.delete(uid);

  for (const tileKey of client.subscribed) {
    await removeClientFromTile(context, uid, tileKey);
  }
}
