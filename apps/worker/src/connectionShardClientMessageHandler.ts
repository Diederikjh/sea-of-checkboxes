import type { ClientMessage, ServerMessage } from "@sea/protocol";

import {
  handleResyncMessage,
  handleSetCellMessage,
  handleSubMessage,
  handleUnsubMessage,
  type ConnectedClient,
  type ConnectionShardDOOperationsContext,
} from "./connectionShardDOOperations";

export interface ConnectionShardClientMessageHandlerOptions {
  context: ConnectionShardDOOperationsContext;
  client: ConnectedClient;
  uid: string;
  message: ClientMessage;
  logEvent: (event: string, fields: Record<string, unknown>) => void;
  recordTileVersion: (tileKey: string, ver: number) => void;
  receiveTileBatch: (message: Extract<ServerMessage, { t: "cellUpBatch" }>) => void;
  recordRecentEditActivity: (tileKey: string, index: number) => void;
  cursorOnActivity: () => void;
  cursorOnSubscriptionsChanged: (force: boolean) => void;
  refreshTilePullSchedule: () => void;
  cursorOnLocalCursor: (client: ConnectedClient, x: number, y: number) => void;
  markLocalCursorDirty: () => void;
  elapsedMs: (startMs: number) => number;
}

export async function handleConnectionShardClientMessage(
  options: ConnectionShardClientMessageHandlerOptions
): Promise<void> {
  const {
    context,
    client,
    uid,
    message,
    logEvent,
    recordTileVersion,
    receiveTileBatch,
    recordRecentEditActivity,
    cursorOnActivity,
    cursorOnSubscriptionsChanged,
    refreshTilePullSchedule,
    cursorOnLocalCursor,
    markLocalCursorDirty,
    elapsedMs,
  } = options;

  switch (message.t) {
    case "sub": {
      const subResult = await handleSubMessage(context, client, message.tiles);
      logEvent("sub", {
        uid,
        requested_count: subResult.requestedCount,
        changed_count: subResult.changedCount,
        invalid_count: subResult.invalidCount,
        rejected_count: subResult.rejectedCount,
        subscribed_count: subResult.subscribedCount,
        clamped: subResult.clamped,
      });
      cursorOnSubscriptionsChanged(true);
      refreshTilePullSchedule();
      return;
    }
    case "unsub": {
      const unsubResult = await handleUnsubMessage(context, client, message.tiles);
      logEvent("unsub", {
        uid,
        requested_count: unsubResult.requestedCount,
        changed_count: unsubResult.changedCount,
        subscribed_count: unsubResult.subscribedCount,
      });
      cursorOnSubscriptionsChanged(true);
      refreshTilePullSchedule();
      return;
    }
    case "setCell": {
      const startMs = Date.now();
      const setCellResult = await handleSetCellMessage(context, client, message);
      if (setCellResult.reason === "not_subscribed" && setCellResult.notSubscribed) {
        logEvent("setcell_not_subscribed", {
          uid,
          tile: message.tile,
          i: message.i,
          v: message.v,
          op: message.op,
          subscribed_count: setCellResult.notSubscribed.subscribedCount,
          subscribed_tiles_sample: setCellResult.notSubscribed.subscribedTilesSample,
          clients_connected: setCellResult.notSubscribed.clientsConnected,
          ...(typeof setCellResult.notSubscribed.connectionAgeMs === "number"
            ? { connection_age_ms: setCellResult.notSubscribed.connectionAgeMs }
            : {}),
        });
      }
      logEvent("setCell", {
        uid,
        tile: message.tile,
        i: message.i,
        v: message.v,
        op: message.op,
        accepted: setCellResult.accepted,
        changed: setCellResult.changed,
        ...(setCellResult.reason ? { reason: setCellResult.reason } : {}),
        ...(typeof setCellResult.ver === "number" ? { ver: setCellResult.ver } : {}),
        ...(typeof setCellResult.watcherCount === "number"
          ? { watcher_count: setCellResult.watcherCount }
          : {}),
        duration_ms: elapsedMs(startMs),
      });
      if (
        setCellResult.accepted &&
        setCellResult.changed &&
        typeof setCellResult.ver === "number"
      ) {
        recordTileVersion(message.tile, setCellResult.ver);
        receiveTileBatch({
          t: "cellUpBatch",
          tile: message.tile,
          fromVer: setCellResult.ver,
          toVer: setCellResult.ver,
          ops: [[message.i, message.v]],
        });
        recordRecentEditActivity(message.tile, message.i);
      }
      cursorOnActivity();
      return;
    }
    case "resyncTile":
      await handleResyncMessage(context, client, message.tile);
      logEvent("resyncTile", {
        uid,
        tile: message.tile,
      });
      return;
    case "cur":
      cursorOnLocalCursor(client, message.x, message.y);
      markLocalCursorDirty();
      return;
    default:
      return;
  }
}
