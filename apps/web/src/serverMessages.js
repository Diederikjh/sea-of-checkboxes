import {
  decodeRle64,
} from "@sea/protocol";
import { logger } from "./logger";

function applyCellUpdateResult({
  result,
  tile,
  changedIndices,
  transport,
  heatStore,
  source,
}) {
  if (result.gap) {
    logger.protocol("gap_resync", {
      tile,
      haveVer: result.haveVer,
      source,
    });
    transport.send({ t: "resyncTile", tile, haveVer: Math.max(0, result.haveVer) });
    return;
  }

  const now = Date.now();
  for (const index of changedIndices) {
    heatStore.bump(tile, index, now);
  }
}

function logCellRevert({
  tile,
  index,
  fromValue,
  toValue,
  source,
}) {
  if (fromValue !== 1 || toValue !== 0) {
    return;
  }
  logger.protocol("cell_revert_detected", {
    tile,
    i: index,
    from: fromValue,
    to: toValue,
    source,
  });
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

function reapplyPendingSetCellOps({
  tile,
  tileStore,
  getPendingSetCellOpsForTile,
  onlyIndices = null,
}) {
  const pendingOps = getPendingSetCellOpsForTile(tile);
  if (!Array.isArray(pendingOps) || pendingOps.length === 0) {
    return;
  }

  const onlyIndexSet = Array.isArray(onlyIndices) ? new Set(onlyIndices) : null;
  for (const pending of pendingOps) {
    if (!pending || typeof pending.i !== "number" || (pending.v !== 0 && pending.v !== 1)) {
      continue;
    }
    if (onlyIndexSet && !onlyIndexSet.has(pending.i)) {
      continue;
    }
    tileStore.applyOptimistic(tile, pending.i, pending.v);
  }
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
  onIdentityReceived = () => {},
  getPendingSetCellOpsForTile = () => [],
}) {
  const readTile = typeof tileStore.get === "function" ? tileStore.get.bind(tileStore) : () => null;

  return (message) => {
    switch (message.t) {
      case "hello": {
        selfIdentity.uid = message.uid;
        onIdentityReceived({ uid: message.uid, name: message.name, token: message.token });
        identityEl.textContent = `You are ${message.name} (${message.uid})`;
        onVisualStateChanged();
        break;
      }
      case "tileSnap": {
        const localBefore = readTile(message.tile);
        const pendingOps = getPendingSetCellOpsForTile(message.tile);
        if (localBefore) {
          logger.protocol("tileSnap_received", {
            tile: message.tile,
            incomingVer: message.ver,
            localVer: localBefore.ver,
            pendingOps: pendingOps.length,
          });
          if (message.ver < localBefore.ver) {
            logger.protocol("tileSnap_stale_overwrite", {
              tile: message.tile,
              incomingVer: message.ver,
              localVer: localBefore.ver,
            });
          }
        } else {
          logger.protocol("tileSnap_received", {
            tile: message.tile,
            incomingVer: message.ver,
            localVer: null,
            pendingOps: pendingOps.length,
          });
        }
        const bits = decodeRle64(message.bits);
        tileStore.setSnapshot(message.tile, bits, message.ver);
        reapplyPendingSetCellOps({
          tile: message.tile,
          tileStore,
          getPendingSetCellOpsForTile,
        });
        heatStore.ensureTile(message.tile);
        onTileCellsChanged(message.tile, null);
        break;
      }
      case "cellUp": {
        const localBefore = readTile(message.tile);
        const beforeValue = localBefore ? localBefore.bits[message.i] : null;
        const result = tileStore.applySingle(message.tile, message.i, message.v, message.ver);
        applyCellUpdateResult({
          result,
          tile: message.tile,
          changedIndices: [message.i],
          transport,
          heatStore,
          source: {
            t: "cellUp",
            ver: message.ver,
            i: message.i,
            v: message.v,
          },
        });
        if (!result.gap && beforeValue !== null) {
          logCellRevert({
            tile: message.tile,
            index: message.i,
            fromValue: beforeValue,
            toValue: message.v,
            source: {
              t: "cellUp",
              ver: message.ver,
            },
          });
        }
        reapplyPendingSetCellOps({
          tile: message.tile,
          tileStore,
          getPendingSetCellOpsForTile,
          onlyIndices: [message.i],
        });
        onTileCellsChanged(message.tile, [message.i]);
        break;
      }
      case "cellUpBatch": {
        const localBefore = readTile(message.tile);
        const beforeByIndex = new Map();
        if (localBefore) {
          for (const [index] of message.ops) {
            beforeByIndex.set(index, localBefore.bits[index]);
          }
        }
        const changedIndices = message.ops.map(([index]) => index);
        const result = tileStore.applyBatch(message.tile, message.fromVer, message.toVer, message.ops);
        applyCellUpdateResult({
          result,
          tile: message.tile,
          changedIndices,
          transport,
          heatStore,
          source: {
            t: "cellUpBatch",
            fromVer: message.fromVer,
            toVer: message.toVer,
            ops: message.ops.length,
          },
        });
        if (!result.gap && localBefore) {
          for (const [index, value] of message.ops) {
            const previous = beforeByIndex.get(index);
            if (previous === undefined) {
              continue;
            }
            logCellRevert({
              tile: message.tile,
              index,
              fromValue: previous,
              toValue: value,
              source: {
                t: "cellUpBatch",
                fromVer: message.fromVer,
                toVer: message.toVer,
              },
            });
          }
        }
        reapplyPendingSetCellOps({
          tile: message.tile,
          tileStore,
          getPendingSetCellOpsForTile,
          onlyIndices: changedIndices,
        });
        onTileCellsChanged(message.tile, changedIndices);
        break;
      }
      case "curUp": {
        if (selfIdentity.uid && message.uid === selfIdentity.uid) {
          break;
        }

        upsertRemoteCursor(cursors, message, Date.now());
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
