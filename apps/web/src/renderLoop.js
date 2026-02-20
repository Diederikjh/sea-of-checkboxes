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
}) {
  let subscribedTiles = new Set();
  let visibleTiles = [];
  let previousCursorDraw = new Map();
  let needsSubscriptionRefresh = true;
  let needsRender = true;
  const dirtyTileCells = new Map();

  const markNeedsFullRefresh = () => {
    needsSubscriptionRefresh = true;
    needsRender = true;
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
      transport,
      marginTiles: 1,
    });

    visibleTiles = updated.visibleTiles;
    subscribedTiles = updated.subscribedTiles;
    needsSubscriptionRefresh = false;
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
    handleResize: markNeedsFullRefresh,
    dispose() {
      app.ticker.remove(onTick);
    },
  };
}
