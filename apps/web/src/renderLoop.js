import {
  cellIndexFromWorld,
  tileKeyFromWorld,
} from "@sea/domain";

import {
  CURSOR_MOVE_EPSILON,
  CURSOR_TTL_MS,
  cursorRadiusPx,
} from "./cursorRenderConfig";
import { PERF_COUNTER, PERF_GAUGE, PERF_TIMING } from "./perfMetricKeys";
import { createPerfProbe } from "./perfProbe";
import { smoothCursors } from "./cursorSmoothing";
import { renderDirtyAreas, renderScene } from "./renderer";
import { reconcileSubscriptions } from "./subscriptions";

const VIEWPORT_UNSUB_DRAIN_MS = 250;

function shouldPatchDirtyAreas({
  needsRender,
  hasAnimatedHeat,
  dirtyTileCells,
}) {
  return !needsRender
    && !hasAnimatedHeat
    && dirtyTileCells.size > 0;
}

function shouldSkipFrame({
  needsRender,
  hasAnimatedHeat,
  dirtyTileCells,
}) {
  return !needsRender && !hasAnimatedHeat && dirtyTileCells.size === 0;
}

function cursorWorldPosition(cursor) {
  return {
    x: Number.isFinite(cursor.drawX) ? cursor.drawX : cursor.x,
    y: Number.isFinite(cursor.drawY) ? cursor.drawY : cursor.y,
  };
}

function isCursorActive(cursor, nowMs) {
  return nowMs - cursor.seenAt < CURSOR_TTL_MS;
}

export function createRenderLoop({
  app,
  graphics,
  camera,
  tileStore,
  heatStore,
  cursors,
  cursorLabels,
  transport,
  setStatus,
  perfProbe = createPerfProbe(),
  onSubscriptionRebuildSubSent = () => {},
  onSubscriptionRebuildSkipped = () => {},
  getPendingSetCellOpsForTile = () => [],
  schedulePendingSetCellReplay = () => {},
}) {
  let subscribedTiles = new Set();
  let visibleTiles = [];
  let previousCursorDraw = new Map();
  let needsSubscriptionRefresh = true;
  let needsRender = true;
  let forceResubscribeVisibleTiles = false;
  let pendingSubscriptionRebuildReason = null;
  let pendingViewportUnsubDrain = null;
  const dirtyTileCells = new Map();

  const countPendingSetCellOpsForTiles = (tiles) => {
    if (!Array.isArray(tiles) || tiles.length === 0) {
      return 0;
    }

    let count = 0;
    for (const tile of tiles) {
      const pending = getPendingSetCellOpsForTile(tile);
      if (!Array.isArray(pending) || pending.length === 0) {
        continue;
      }
      count += pending.length;
    }
    return count;
  };

  const toTileSet = (tiles) => new Set(tiles);

  const buildViewportUnsubDrainKey = (tiles) => [...tiles].sort().join(",");

  const requestSubscriptionRefresh = ({
    resetSubscribedTiles = false,
    resubscribeVisibleTiles = false,
  } = {}) => {
    if (resetSubscribedTiles) {
      subscribedTiles = new Set();
    }
    if (resubscribeVisibleTiles) {
      forceResubscribeVisibleTiles = true;
    }
    needsSubscriptionRefresh = true;
    needsRender = true;
  };

  const markNeedsFullRefresh = () => {
    requestSubscriptionRefresh();
  };

  const markVisualDirty = () => {
    needsRender = true;
  };

  const markTileCellsDirty = (tileKey, changedIndices) => {
    const existing = dirtyTileCells.get(tileKey);

    if (!changedIndices) {
      dirtyTileCells.set(tileKey, null);
      return;
    }

    if (existing === null) {
      return;
    }

    const updated = existing ?? new Set();
    for (const index of changedIndices) {
      updated.add(index);
    }
    dirtyTileCells.set(tileKey, updated);
  };

  const markCursorFootprintDirty = (worldX, worldY) => {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || camera.cellPixelSize <= 0) {
      return;
    }

    const radiusWorld = cursorRadiusPx(camera.cellPixelSize) / camera.cellPixelSize;
    const minX = Math.floor(worldX - radiusWorld);
    const maxX = Math.floor(worldX + radiusWorld);
    const minY = Math.floor(worldY - radiusWorld);
    const maxY = Math.floor(worldY + radiusWorld);
    const byTile = new Map();

    for (let worldCellY = minY; worldCellY <= maxY; worldCellY += 1) {
      for (let worldCellX = minX; worldCellX <= maxX; worldCellX += 1) {
        const tileKey = tileKeyFromWorld(worldCellX, worldCellY);
        let indices = byTile.get(tileKey);
        if (!indices) {
          indices = [];
          byTile.set(tileKey, indices);
        }
        indices.push(cellIndexFromWorld(worldCellX, worldCellY));
      }
    }

    for (const [tileKey, indices] of byTile.entries()) {
      markTileCellsDirty(tileKey, indices);
    }
  };

  const updateCursorDirtyRegions = (nowMs) => {
    const nextCursorDraw = new Map();
    const seen = new Set();

    for (const [uid, cursor] of cursors.entries()) {
      const previous = previousCursorDraw.get(uid) ?? null;
      const active = isCursorActive(cursor, nowMs);
      const position = cursorWorldPosition(cursor);

      if (active) {
        nextCursorDraw.set(uid, position);
        seen.add(uid);

        const hasMoved = !previous
          || Math.abs(previous.x - position.x) > CURSOR_MOVE_EPSILON
          || Math.abs(previous.y - position.y) > CURSOR_MOVE_EPSILON;
        if (hasMoved) {
          if (previous) {
            markCursorFootprintDirty(previous.x, previous.y);
          }
          markCursorFootprintDirty(position.x, position.y);
        }
      } else if (previous) {
        markCursorFootprintDirty(previous.x, previous.y);
        seen.add(uid);
      }
    }

    for (const [uid, previous] of previousCursorDraw.entries()) {
      if (seen.has(uid)) {
        continue;
      }
      markCursorFootprintDirty(previous.x, previous.y);
    }

    previousCursorDraw = nextCursorDraw;
  };

  const syncSubscriptions = () => {
    const updated = reconcileSubscriptions({
      camera,
      viewportWidth: app.renderer.width,
      viewportHeight: app.renderer.height,
      subscribedTiles,
      marginTiles: 1,
    });
    const rebuildReason = pendingSubscriptionRebuildReason;
    const isForcedRebuild = forceResubscribeVisibleTiles;
    let rebuildSubSent = false;

    if (updated.toSub.length > 0) {
      const options =
        rebuildReason && !isForcedRebuild
          ? { subscriptionRebuild: { reason: rebuildReason } }
          : undefined;
      const sentMessage = transport.send({ t: "sub", tiles: updated.toSub }, options);
      if (options) {
        rebuildSubSent = true;
        onSubscriptionRebuildSubSent(sentMessage, rebuildReason);
      }
    }

    let deferredViewportUnsub = false;
    if (updated.toUnsub.length > 0) {
      const pendingSetCellCount = countPendingSetCellOpsForTiles(updated.toUnsub);
      if (pendingSetCellCount > 0) {
        const drainKey = buildViewportUnsubDrainKey(updated.toUnsub);
        if (!pendingViewportUnsubDrain || pendingViewportUnsubDrain.key !== drainKey) {
          pendingViewportUnsubDrain = {
            key: drainKey,
            deadlineMs: Date.now() + VIEWPORT_UNSUB_DRAIN_MS,
          };
        }

        if (Date.now() < pendingViewportUnsubDrain.deadlineMs) {
          deferredViewportUnsub = true;
          schedulePendingSetCellReplay(0);
        }
      }

      if (!deferredViewportUnsub) {
        pendingViewportUnsubDrain = null;
        transport.send({ t: "unsub", tiles: updated.toUnsub });
      }
    } else {
      pendingViewportUnsubDrain = null;
    }

    visibleTiles = updated.visibleTiles;
    subscribedTiles = deferredViewportUnsub
      ? new Set([...updated.subscribedTiles, ...toTileSet(updated.toUnsub)])
      : updated.subscribedTiles;
    if (forceResubscribeVisibleTiles) {
      const tiles = Array.from(updated.subscribedTiles);
      if (tiles.length > 0) {
        const options = rebuildReason
          ? { subscriptionRebuild: { reason: rebuildReason } }
          : undefined;
        const sentMessage = transport.send({ t: "sub", tiles }, options);
        if (rebuildReason) {
          rebuildSubSent = true;
          onSubscriptionRebuildSubSent(sentMessage, rebuildReason);
        }
      }
      forceResubscribeVisibleTiles = false;
    }
    if (rebuildReason && !rebuildSubSent) {
      onSubscriptionRebuildSkipped(rebuildReason, {
        visibleTileCount: updated.subscribedTiles.size,
      });
    }
    pendingSubscriptionRebuildReason = null;
    needsSubscriptionRefresh = deferredViewportUnsub;
  };

  const onTick = (ticker) => {
    perfProbe.increment(PERF_COUNTER.FRAME_TOTAL);
    const dtSeconds = ticker.deltaMS / 1_000;
    const hasAnimatedHeat = perfProbe.measure(PERF_TIMING.HEAT_DECAY_MS, () => heatStore.decay(dtSeconds));
    const nowMs = Date.now();
    perfProbe.measure(PERF_TIMING.CURSOR_SMOOTH_MS, () => smoothCursors(cursors, dtSeconds));
    perfProbe.measure(PERF_TIMING.CURSOR_DIRTY_INDEX_MS, () => updateCursorDirtyRegions(nowMs));
    perfProbe.gauge(PERF_GAUGE.CURSOR_COUNT, cursors.size);

    if (needsSubscriptionRefresh) {
      perfProbe.measure(PERF_TIMING.SUBSCRIPTIONS_SYNC_MS, () => syncSubscriptions());
      needsRender = true;
    }

    const frameState = {
      needsRender,
      hasAnimatedHeat,
      dirtyTileCells,
    };

    if (shouldPatchDirtyAreas(frameState)) {
      perfProbe.increment(PERF_COUNTER.FRAME_PATCH);
      perfProbe.gauge(PERF_GAUGE.DIRTY_TILE_COUNT, dirtyTileCells.size);
      const activeCursors = perfProbe.measure(PERF_TIMING.RENDER_PATCH_MS, () => renderDirtyAreas({
        graphics,
        camera,
        viewportWidth: app.renderer.width,
        viewportHeight: app.renderer.height,
        visibleTiles,
        dirtyTileCells,
        tileStore,
        heatStore,
        cursors,
      }));
      perfProbe.measure(PERF_TIMING.CURSOR_LABELS_MS, () =>
        cursorLabels.update(activeCursors, camera, app.renderer.width, app.renderer.height)
      );
      dirtyTileCells.clear();
      perfProbe.flushMaybe();
      return;
    }

    if (shouldSkipFrame(frameState)) {
      perfProbe.increment(PERF_COUNTER.FRAME_SKIP);
      perfProbe.flushMaybe();
      return;
    }

    perfProbe.increment(PERF_COUNTER.FRAME_FULL);
    const activeCursors = perfProbe.measure(PERF_TIMING.RENDER_FULL_MS, () => renderScene({
      graphics,
      camera,
      viewportWidth: app.renderer.width,
      viewportHeight: app.renderer.height,
      visibleTiles,
      tileStore,
      heatStore,
      cursors,
    }));

    perfProbe.measure(PERF_TIMING.CURSOR_LABELS_MS, () =>
      cursorLabels.update(activeCursors, camera, app.renderer.width, app.renderer.height)
    );

    setStatus(`Tiles loaded: ${subscribedTiles.size}`);
    dirtyTileCells.clear();
    needsRender = false;
    perfProbe.flushMaybe();
  };

  app.ticker.add(onTick);
  syncSubscriptions();

  return {
    markViewportDirty: markNeedsFullRefresh,
    markVisualDirty,
    markTileCellsDirty,
    markTransportReconnected(reason = "transport_reconnect") {
      // Rebuild shard-side subscriptions after WS reconnect or worker upgrade.
      requestSubscriptionRefresh({ resetSubscribedTiles: true });
      pendingSubscriptionRebuildReason = reason;
    },
    forceSubscriptionRebuild(reason = "subscription_rebuild") {
      // Re-assert visible tile subscriptions when browser lifecycle events
      // (focus/visibility/pageshow) might have drifted shard watch state.
      requestSubscriptionRefresh({ resubscribeVisibleTiles: true });
      pendingSubscriptionRebuildReason = reason;
    },
    handleResize: markNeedsFullRefresh,
    dispose() {
      app.ticker.remove(onTick);
    },
  };
}
