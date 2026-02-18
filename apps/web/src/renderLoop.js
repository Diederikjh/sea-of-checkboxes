import { smoothCursors } from "./cursorSmoothing";
import { renderDirtyAreas, renderScene } from "./renderer";
import { reconcileSubscriptions } from "./subscriptions";

function hasRecentCursorActivity(cursors, nowMs) {
  if (cursors.size === 0) {
    return false;
  }
  return [...cursors.values()].some((cursor) => nowMs - cursor.seenAt < 5_000);
}

function shouldPatchDirtyAreas({
  needsRender,
  hasAnimatedHeat,
  hasCursorMotion,
  hasRecentCursor,
  dirtyTileCells,
}) {
  return !needsRender
    && !hasAnimatedHeat
    && !hasCursorMotion
    && !hasRecentCursor
    && dirtyTileCells.size > 0;
}

function shouldSkipFrame({
  needsRender,
  hasAnimatedHeat,
  hasCursorMotion,
  hasRecentCursor,
}) {
  return !needsRender && !hasAnimatedHeat && !hasCursorMotion && !hasRecentCursor;
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
}) {
  let subscribedTiles = new Set();
  let visibleTiles = [];
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
    const dtSeconds = ticker.deltaMS / 1_000;
    const hasAnimatedHeat = heatStore.decay(dtSeconds);
    const hasCursorMotion = smoothCursors(cursors, dtSeconds);
    const hasRecentCursor = hasRecentCursorActivity(cursors, Date.now());

    if (needsSubscriptionRefresh) {
      syncSubscriptions();
      needsRender = true;
    }

    const frameState = {
      needsRender,
      hasAnimatedHeat,
      hasCursorMotion,
      hasRecentCursor,
    };

    if (shouldPatchDirtyAreas({ ...frameState, dirtyTileCells })) {
      renderDirtyAreas({
        graphics,
        camera,
        viewportWidth: app.renderer.width,
        viewportHeight: app.renderer.height,
        visibleTiles,
        dirtyTileCells,
        tileStore,
        heatStore,
      });
      dirtyTileCells.clear();
      return;
    }

    if (shouldSkipFrame(frameState)) {
      return;
    }

    const activeCursors = renderScene({
      graphics,
      camera,
      viewportWidth: app.renderer.width,
      viewportHeight: app.renderer.height,
      visibleTiles,
      tileStore,
      heatStore,
      cursors,
    });

    cursorLabels.update(activeCursors, camera, app.renderer.width, app.renderer.height);

    setStatus(`Tiles loaded: ${subscribedTiles.size}`);
    dirtyTileCells.clear();
    needsRender = false;
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
