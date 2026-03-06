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

function messageCidFields(message: ClientMessage): Record<string, unknown> {
  if (!("cid" in message) || typeof message.cid !== "string" || message.cid.length === 0) {
    return {};
  }
  return { cid: message.cid };
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
  const cidFields = messageCidFields(message);
  const scopedContext: ConnectionShardDOOperationsContext = {
    ...context,
    sendError: (targetClient, code, msg, fields) => {
      context.sendError(targetClient, code, msg, {
        ...cidFields,
        ...fields,
      });
    },
    sendBadTile: (targetClient, tileKey, fields) => {
      context.sendBadTile(targetClient, tileKey, {
        ...cidFields,
        ...fields,
      });
    },
  };

  switch (message.t) {
    case "sub": {
      const subResult = await handleSubMessage(scopedContext, client, message.tiles);
      logEvent("sub", {
        uid,
        ...cidFields,
        requested_count: subResult.requestedCount,
        changed_count: subResult.changedCount,
        invalid_count: subResult.invalidCount,
        rejected_count: subResult.rejectedCount,
        subscribed_count: subResult.subscribedCount,
        clamped: subResult.clamped,
      });
      if (typeof message.cid === "string") {
        logEvent("subAck", {
          uid,
          cid: message.cid,
          requested_count: subResult.requestedCount,
          changed_count: subResult.changedCount,
          subscribed_count: subResult.subscribedCount,
        });
        context.sendServerMessage(client, {
          t: "subAck",
          cid: message.cid,
          requestedCount: subResult.requestedCount,
          changedCount: subResult.changedCount,
          subscribedCount: subResult.subscribedCount,
        });
      }
      cursorOnSubscriptionsChanged(true);
      refreshTilePullSchedule();
      return;
    }
    case "unsub": {
      const unsubResult = await handleUnsubMessage(scopedContext, client, message.tiles);
      logEvent("unsub", {
        uid,
        ...cidFields,
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
      const setCellResult = await handleSetCellMessage(scopedContext, client, message);
      if (setCellResult.reason === "not_subscribed" && setCellResult.notSubscribed) {
        logEvent("setcell_not_subscribed", {
          uid,
          ...cidFields,
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
        ...cidFields,
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
      await handleResyncMessage(scopedContext, client, message.tile);
      logEvent("resyncTile", {
        uid,
        ...cidFields,
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
