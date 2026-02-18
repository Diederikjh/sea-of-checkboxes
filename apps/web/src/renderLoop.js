import { smoothCursors } from "./cursorSmoothing";
import { renderDirtyAreas, renderScene } from "./renderer";
import { reconcileSubscriptions } from "./subscriptions";

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

  const markViewportDirty = () => {
    needsSubscriptionRefresh = true;
    needsRender = true;
  };

  const markVisualDirty = () => {
    needsRender = true;
  };

  const markTileCellsDirty = (tileKey, changedIndices) => {
    const previous = dirtyTileCells.get(tileKey);

    if (!changedIndices) {
      dirtyTileCells.set(tileKey, null);
      return;
    }

    if (previous === null) {
      return;
    }

    const next = previous ?? new Set();
    for (const index of changedIndices) {
      next.add(index);
    }
    dirtyTileCells.set(tileKey, next);
  };

  const handleResize = () => {
    needsSubscriptionRefresh = true;
    needsRender = true;
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
    const now = Date.now();
    const hasRecentCursor = cursors.size > 0
      ? [...cursors.values()].some((cursor) => now - cursor.seenAt < 5_000)
      : false;

    if (needsSubscriptionRefresh) {
      syncSubscriptions();
      needsRender = true;
    }

    const canPatchDirtyAreas = !needsRender
      && !hasAnimatedHeat
      && !hasCursorMotion
      && !hasRecentCursor
      && dirtyTileCells.size > 0;

    if (canPatchDirtyAreas) {
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

    if (!needsRender && !hasAnimatedHeat && !hasCursorMotion && !hasRecentCursor) {
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

    cursorLabels.update(
      activeCursors,
      camera,
      app.renderer.width,
      app.renderer.height
    );

    setStatus(`Tiles loaded: ${subscribedTiles.size}`);
    dirtyTileCells.clear();
    needsRender = false;
  };

  app.ticker.add(onTick);
  syncSubscriptions();

  return {
    markViewportDirty,
    markVisualDirty,
    markTileCellsDirty,
    handleResize,
    dispose() {
      app.ticker.remove(onTick);
    },
  };
}
