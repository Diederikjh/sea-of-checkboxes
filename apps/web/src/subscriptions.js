import { enumerateVisibleTiles } from "@sea/domain";

export function reconcileSubscriptions({
  camera,
  viewportWidth,
  viewportHeight,
  subscribedTiles,
  transport,
  marginTiles = 1,
}) {
  const visibleTiles = enumerateVisibleTiles({
    cameraX: camera.x,
    cameraY: camera.y,
    viewportWidthPx: viewportWidth,
    viewportHeightPx: viewportHeight,
    cellPixelSize: camera.cellPixelSize,
    marginTiles,
  });

  const nextSubscribedTiles = new Set(visibleTiles.map((tile) => tile.tileKey));
  const toSub = [];
  const toUnsub = [];

  for (const key of nextSubscribedTiles) {
    if (!subscribedTiles.has(key)) {
      toSub.push(key);
    }
  }

  for (const key of subscribedTiles) {
    if (!nextSubscribedTiles.has(key)) {
      toUnsub.push(key);
    }
  }

  if (toSub.length > 0) {
    transport.send({ t: "sub", tiles: toSub });
  }
  if (toUnsub.length > 0) {
    transport.send({ t: "unsub", tiles: toUnsub });
  }

  return {
    visibleTiles,
    subscribedTiles: nextSubscribedTiles,
  };
}
