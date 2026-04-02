import {
  parseTileKeyStrict,
  worldFromTileCell,
} from "@sea/domain";

function formatByteCount(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function payloadHeadHex(payload, maxBytes = 8) {
  const head = Array.from(payload.slice(0, maxBytes));
  return head.map((value) => value.toString(16).padStart(2, "0")).join(" ");
}

function round2(value) {
  return Number(value.toFixed(2));
}

function summarizeCursor(message) {
  const x = round2(message.x);
  const y = round2(message.y);
  return {
    t: message.t,
    x,
    y,
    boardX: x,
    boardY: y,
  };
}

function deriveBoardCoordFromSetCell(tileKey, index) {
  const tile = parseTileKeyStrict(tileKey);
  if (!tile) {
    return {};
  }

  try {
    const world = worldFromTileCell(tile.tx, tile.ty, index);
    return {
      worldX: world.x,
      worldY: world.y,
      boardX: Number((world.x + 0.5).toFixed(2)),
      boardY: Number((world.y + 0.5).toFixed(2)),
    };
  } catch {
    return {};
  }
}

export function describePayload(payload) {
  return {
    bytes: payload.length,
    size: formatByteCount(payload.length),
    tag: payload[0] ?? null,
    headHex: payloadHeadHex(payload),
  };
}

export function summarizeMessage(message) {
  switch (message.t) {
    case "sub":
    case "unsub":
      return { t: message.t, cid: message.cid ?? null, tiles: message.tiles.length };
    case "setCell":
      return {
        t: message.t,
        cid: message.cid ?? null,
        tile: message.tile,
        i: message.i,
        v: message.v,
        op: message.op,
        ...deriveBoardCoordFromSetCell(message.tile, message.i),
      };
    case "resyncTile":
      return { t: message.t, cid: message.cid ?? null, tile: message.tile, haveVer: message.haveVer };
    case "cur":
      return summarizeCursor(message);
    case "hello":
      return { t: message.t, uid: message.uid, name: message.name };
    case "tileSnap":
      return { t: message.t, tile: message.tile, ver: message.ver };
    case "cellUp":
      return { t: message.t, tile: message.tile, i: message.i, v: message.v, ver: message.ver };
    case "cellUpBatch":
      return {
        t: message.t,
        tile: message.tile,
        fromVer: message.fromVer,
        toVer: message.toVer,
        ops: message.ops.length,
        opsPreview: message.ops.slice(0, 4),
      };
    case "curUp":
      return {
        uid: message.uid,
        name: message.name,
        ver: message.ver,
        ...summarizeCursor(message),
      };
    case "err":
      return { t: message.t, code: message.code };
    case "subAck":
      return {
        t: message.t,
        cid: message.cid,
        requestedCount: message.requestedCount,
        changedCount: message.changedCount,
        subscribedCount: message.subscribedCount,
      };
    default:
      return { t: message.t };
  }
}
