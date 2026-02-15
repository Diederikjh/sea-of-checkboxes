import {
  MAX_TILES_SUBSCRIBED,
  MAX_TILE_CHURN_PER_MIN,
  SETCELL_BURST_PER_SEC,
  SETCELL_SUSTAINED_PER_SEC,
  SETCELL_SUSTAINED_WINDOW_MS,
  isTileCoordInBounds,
  parseTileKeyStrict,
} from "@sea/domain";
import type { ClientMessage } from "@sea/protocol";

import { recordWithinLimit } from "./rateLimiter";
import type { LocalRealtimeRuntime } from "./runtime";
import type { TileWatcher } from "./types";
import { sendClientError, type ClientRecord } from "./connectionShardClient";

interface ConnectionShardOpsContext {
  shardId: string;
  runtime: LocalRealtimeRuntime;
  nowMs: () => number;
  clients: Map<string, ClientRecord>;
  tileToClients: Map<string, Set<string>>;
  watcher: TileWatcher;
}

function isValidTileKey(tileKey: string): boolean {
  const parsed = parseTileKeyStrict(tileKey);
  return parsed !== null && isTileCoordInBounds(parsed.tx, parsed.ty);
}

export function disconnectClientFromShard(context: ConnectionShardOpsContext, uid: string): void {
  const client = context.clients.get(uid);
  if (!client) {
    return;
  }

  for (const tileKey of client.subscribed) {
    const localSubscribers = context.tileToClients.get(tileKey);
    if (!localSubscribers) {
      continue;
    }

    localSubscribers.delete(uid);
    if (localSubscribers.size === 0) {
      context.tileToClients.delete(tileKey);
      context.runtime.getTileOwner(tileKey).unregisterWatcher(context.shardId);
    }
  }

  context.clients.delete(uid);
}

export function handleSubMessage(
  context: ConnectionShardOpsContext,
  client: ClientRecord,
  tileKeys: string[]
): void {
  for (const tileKey of tileKeys) {
    if (client.subscribed.has(tileKey)) {
      continue;
    }

    if (client.subscribed.size >= MAX_TILES_SUBSCRIBED) {
      sendClientError(client, "sub_limit", `Max ${MAX_TILES_SUBSCRIBED} tiles subscribed`);
      return;
    }

    const nowMs = context.nowMs();
    if (!recordWithinLimit(client.churnTimestamps, nowMs, 60_000, MAX_TILE_CHURN_PER_MIN)) {
      sendClientError(client, "churn_limit", "Tile churn limit exceeded");
      return;
    }

    if (!isValidTileKey(tileKey)) {
      sendClientError(client, "bad_tile", `Invalid tile key ${tileKey}`);
      continue;
    }

    client.subscribed.add(tileKey);

    let subscribers = context.tileToClients.get(tileKey);
    if (!subscribers) {
      subscribers = new Set();
      context.tileToClients.set(tileKey, subscribers);
    }

    subscribers.add(client.uid);
    const owner = context.runtime.getTileOwner(tileKey);
    owner.registerWatcher(context.watcher);
    client.sink(owner.getSnapshotMessage());
  }
}

export function handleUnsubMessage(
  context: ConnectionShardOpsContext,
  client: ClientRecord,
  tileKeys: string[]
): void {
  for (const tileKey of tileKeys) {
    if (!client.subscribed.has(tileKey)) {
      continue;
    }

    const nowMs = context.nowMs();
    if (!recordWithinLimit(client.churnTimestamps, nowMs, 60_000, MAX_TILE_CHURN_PER_MIN)) {
      sendClientError(client, "churn_limit", "Tile churn limit exceeded");
      return;
    }

    client.subscribed.delete(tileKey);

    const subscribers = context.tileToClients.get(tileKey);
    if (!subscribers) {
      continue;
    }

    subscribers.delete(client.uid);
    if (subscribers.size === 0) {
      context.tileToClients.delete(tileKey);
      context.runtime.getTileOwner(tileKey).unregisterWatcher(context.shardId);
    }
  }
}

export function handleSetCellMessage(
  context: ConnectionShardOpsContext,
  client: ClientRecord,
  message: Extract<ClientMessage, { t: "setCell" }>
): void {
  const nowMs = context.nowMs();

  const burstAllowed = recordWithinLimit(
    client.setCellBurstTimestamps,
    nowMs,
    1_000,
    SETCELL_BURST_PER_SEC
  );

  const sustainedLimit = Math.floor((SETCELL_SUSTAINED_PER_SEC * SETCELL_SUSTAINED_WINDOW_MS) / 1_000);
  const sustainedAllowed = recordWithinLimit(
    client.setCellSustainedTimestamps,
    nowMs,
    SETCELL_SUSTAINED_WINDOW_MS,
    sustainedLimit
  );

  if (!burstAllowed || !sustainedAllowed) {
    sendClientError(client, "setcell_limit", "setCell rate limit exceeded");
    return;
  }

  if (!isValidTileKey(message.tile)) {
    sendClientError(client, "bad_tile", `Invalid tile key ${message.tile}`);
    return;
  }

  const owner = context.runtime.getTileOwner(message.tile);
  const result = owner.applySetCell({
    i: message.i,
    v: message.v,
    op: message.op,
  });

  if (!result.accepted) {
    sendClientError(client, "setcell_rejected", result.reason ?? "Rejected");
  }
}

export function handleResyncMessage(
  context: ConnectionShardOpsContext,
  client: ClientRecord,
  tileKey: string
): void {
  if (!isValidTileKey(tileKey)) {
    sendClientError(client, "bad_tile", `Invalid tile key ${tileKey}`);
    return;
  }

  const owner = context.runtime.getTileOwner(tileKey);
  client.sink(owner.getSnapshotMessage());
}

export function handleCursorMessage(
  context: ConnectionShardOpsContext,
  client: ClientRecord,
  x: number,
  y: number
): void {
  for (const target of context.clients.values()) {
    if (target.uid === client.uid) {
      continue;
    }

    target.sink({
      t: "curUp",
      uid: client.uid,
      name: client.name,
      x,
      y,
    });
  }
}
