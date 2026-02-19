import {
  decodeRle64,
} from "@sea/protocol";

function applyCellUpdateResult({
  result,
  tile,
  changedIndices,
  transport,
  heatStore,
}) {
  if (result.gap) {
    transport.send({ t: "resyncTile", tile, haveVer: Math.max(0, result.haveVer) });
    return;
  }

  const now = Date.now();
  for (const index of changedIndices) {
    heatStore.bump(tile, index, now);
  }
}

function upsertRemoteCursor(cursors, message, seenAt) {
  const current = cursors.get(message.uid);
  if (current) {
    current.name = message.name;
    current.x = message.x;
    current.y = message.y;
    current.seenAt = seenAt;
    return;
  }

  cursors.set(message.uid, {
    uid: message.uid,
    name: message.name,
    x: message.x,
    y: message.y,
    drawX: message.x,
    drawY: message.y,
    seenAt,
  });
}

export function createServerMessageHandler({
  identityEl,
  setStatus,
  tileStore,
  heatStore,
  transport,
  cursors,
  selfIdentity,
  onVisualStateChanged = () => {},
  onTileCellsChanged = () => {},
  setInteractionRestriction = () => {},
}) {
  return (message) => {
    switch (message.t) {
      case "hello": {
        selfIdentity.uid = message.uid;
        identityEl.textContent = `You are ${message.name} (${message.uid})`;
        onVisualStateChanged();
        break;
      }
      case "tileSnap": {
        const bits = decodeRle64(message.bits);
        tileStore.setSnapshot(message.tile, bits, message.ver);
        heatStore.ensureTile(message.tile);
        onTileCellsChanged(message.tile, null);
        break;
      }
      case "cellUp": {
        const result = tileStore.applySingle(message.tile, message.i, message.v, message.ver);
        applyCellUpdateResult({
          result,
          tile: message.tile,
          changedIndices: [message.i],
          transport,
          heatStore,
        });
        onTileCellsChanged(message.tile, [message.i]);
        break;
      }
      case "cellUpBatch": {
        const changedIndices = message.ops.map(([index]) => index);
        const result = tileStore.applyBatch(message.tile, message.fromVer, message.toVer, message.ops);
        applyCellUpdateResult({
          result,
          tile: message.tile,
          changedIndices,
          transport,
          heatStore,
        });
        onTileCellsChanged(message.tile, changedIndices);
        break;
      }
      case "curUp": {
        if (selfIdentity.uid && message.uid === selfIdentity.uid) {
          break;
        }

        upsertRemoteCursor(cursors, message, Date.now());
        onVisualStateChanged();
        break;
      }
      case "err": {
        if (message.code === "setcell_rejected" && message.msg === "tile_readonly_hot") {
          setInteractionRestriction("readonly", "Hot tile is read-only right now");
        } else if (message.code === "tile_sub_denied") {
          setInteractionRestriction("deny", "Tile is over capacity; access denied for now");
        }
        setStatus(`Error: ${message.msg}`);
        break;
      }
      default:
        break;
    }
  };
}
