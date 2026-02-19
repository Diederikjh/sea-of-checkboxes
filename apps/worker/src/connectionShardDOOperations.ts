import { MAX_TILES_SUBSCRIBED } from "@sea/domain";
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
  watchTile(tileKey: string, action: "sub" | "unsub"): Promise<void>;
  setTileCell(payload: TileSetCellRequest): Promise<TileSetCellResponse | null>;
  sendSnapshotToClient(client: ConnectedClient, tileKey: string): Promise<void>;
}

export async function handleSubMessage(
  context: ConnectionShardDOOperationsContext,
  client: ConnectedClient,
  tiles: string[]
): Promise<void> {
  for (const tileKey of tiles) {
    if (client.subscribed.has(tileKey)) {
      continue;
    }

    if (client.subscribed.size >= MAX_TILES_SUBSCRIBED) {
      context.sendError(client, "sub_limit", `Max ${MAX_TILES_SUBSCRIBED} tiles subscribed`);
      return;
    }

    if (!isValidTileKey(tileKey)) {
      context.sendBadTile(client, tileKey);
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
      await context.watchTile(tileKey, "sub");
    }

    await context.sendSnapshotToClient(client, tileKey);
  }
}

export async function handleUnsubMessage(
  context: ConnectionShardDOOperationsContext,
  client: ConnectedClient,
  tiles: string[]
): Promise<void> {
  for (const tileKey of tiles) {
    if (!client.subscribed.has(tileKey)) {
      continue;
    }

    client.subscribed.delete(tileKey);
    const subscribers = context.tileToClients.get(tileKey);
    if (!subscribers) {
      continue;
    }

    subscribers.delete(client.uid);
    if (subscribers.size !== 0) {
      continue;
    }

    context.tileToClients.delete(tileKey);
    await context.watchTile(tileKey, "unsub");
  }
}

export async function handleSetCellMessage(
  context: ConnectionShardDOOperationsContext,
  client: ConnectedClient,
  message: Extract<ClientMessage, { t: "setCell" }>
): Promise<void> {
  if (!isValidTileKey(message.tile)) {
    context.sendBadTile(client, message.tile);
    return;
  }

  const isSubscribed = client.subscribed.has(message.tile);
  if (!isSubscribed) {
    context.sendError(client, "not_subscribed", `Tile ${message.tile} is not currently subscribed`);
    await context.sendSnapshotToClient(client, message.tile);
    return;
  }

  // Re-assert watch before writes. This self-heals TileOwnerDO watcher sets
  // if the tile DO was recycled and forgot in-memory shard subscriptions.
  await context.watchTile(message.tile, "sub");

  const result = await context.setTileCell({
    tile: message.tile,
    i: message.i,
    v: message.v,
    op: message.op,
    uid: client.uid,
    name: client.name,
    atMs: Date.now(),
  });

  if (!result?.accepted) {
    context.sendError(client, "setcell_rejected", result?.reason ?? "Rejected");
    return;
  }

  if (!result.changed) {
    // Client may be stale and repeatedly submit no-op writes.
    // Send a fresh snapshot so local cache can converge.
    await context.sendSnapshotToClient(client, message.tile);
  }
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
    const subscribers = context.tileToClients.get(tileKey);
    if (!subscribers) {
      continue;
    }

    subscribers.delete(uid);
    if (subscribers.size !== 0) {
      continue;
    }

    context.tileToClients.delete(tileKey);
    await context.watchTile(tileKey, "unsub");
  }
}
