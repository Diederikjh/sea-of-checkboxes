import { MAX_REMOTE_CURSORS, TILE_SIZE } from "@sea/domain";

function heatToColor(heat) {
  if (heat < 0.05) {
    return 0x14191f;
  }
  if (heat < 0.25) {
    return 0x234f69;
  }
  if (heat < 0.5) {
    return 0x2a7f98;
  }
  if (heat < 0.8) {
    return 0xb8832f;
  }
  return 0xc7484d;
}

function stableCursorColor(uid) {
  let hash = 0;
  for (let index = 0; index < uid.length; index += 1) {
    hash = (hash * 31 + uid.charCodeAt(index)) | 0;
  }

  const hue = Math.abs(hash % 360);
  return hslToHex(hue, 72, 56);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;

  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));

  const r = Math.round(255 * f(0));
  const g = Math.round(255 * f(8));
  const b = Math.round(255 * f(4));

  return (r << 16) | (g << 8) | b;
}

function toScreen(worldX, worldY, camera, viewportWidth, viewportHeight) {
  return {
    x: (worldX - camera.x) * camera.cellPixelSize + viewportWidth / 2,
    y: (worldY - camera.y) * camera.cellPixelSize + viewportHeight / 2,
  };
}

function isCellOnScreen(screen, cellPx, viewportWidth, viewportHeight) {
  return !(
    screen.x + cellPx < 0
    || screen.x > viewportWidth
    || screen.y + cellPx < 0
    || screen.y > viewportHeight
  );
}

function drawBackground(graphics, viewportWidth, viewportHeight) {
  graphics.beginFill(0x0a0f14, 1);
  graphics.drawRect(0, 0, viewportWidth, viewportHeight);
  graphics.endFill();
}

function drawCell({
  graphics,
  screenX,
  screenY,
  cellPx,
  value,
  heat,
}) {
  graphics.beginFill(0x0a0f14, 1);
  graphics.drawRect(screenX, screenY, cellPx, cellPx);
  graphics.endFill();

  if (value === 0 && heat < 0.03 && cellPx < 10) {
    return;
  }

  const fillColor = value === 1 ? 0x27c67b : heatToColor(heat);
  const alpha = value === 1 ? 0.95 : Math.min(0.85, 0.3 + heat * 0.6);
  graphics.beginFill(fillColor, alpha);
  graphics.drawRect(screenX, screenY, cellPx, cellPx);
  graphics.endFill();

  if (cellPx >= 12) {
    graphics.lineStyle(1, 0x253441, 0.28);
    graphics.drawRect(screenX, screenY, cellPx, cellPx);
    graphics.lineStyle(0);
  }
}

function indicesFromDirtyBlock(dirtyIndices) {
  if (!dirtyIndices) {
    return null;
  }

  let minX = TILE_SIZE;
  let minY = TILE_SIZE;
  let maxX = -1;
  let maxY = -1;

  for (const index of dirtyIndices) {
    const x = index % TILE_SIZE;
    const y = Math.floor(index / TILE_SIZE);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (maxX < 0 || maxY < 0) {
    return [];
  }

  const indices = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      indices.push(y * TILE_SIZE + x);
    }
  }

  return indices;
}

function drawTileCells({
  graphics,
  camera,
  viewportWidth,
  viewportHeight,
  tile,
  tileData,
  heatStore,
  dirtyIndices,
}) {
  const cellPx = camera.cellPixelSize;
  const tileWorldX = tile.tx * TILE_SIZE;
  const tileWorldY = tile.ty * TILE_SIZE;
  const blockIndices = indicesFromDirtyBlock(dirtyIndices);
  const indices = blockIndices ?? tileData.bits.keys();

  for (const index of indices) {
    const localX = index % TILE_SIZE;
    const localY = Math.floor(index / TILE_SIZE);
    const worldX = tileWorldX + localX;
    const worldY = tileWorldY + localY;

    const screen = toScreen(worldX, worldY, camera, viewportWidth, viewportHeight);
    if (!isCellOnScreen(screen, cellPx, viewportWidth, viewportHeight)) {
      continue;
    }

    const value = tileData.bits[index];
    const heat = heatStore.getHeat(tile.tileKey, index);
    drawCell({
      graphics,
      screenX: screen.x,
      screenY: screen.y,
      cellPx,
      value,
      heat,
    });
  }
}

function* iterateVisibleTiles(visibleTiles, tileStore, dirtyTileCells = null) {
  const visibleByKey = dirtyTileCells
    ? new Map(visibleTiles.map((tile) => [tile.tileKey, tile]))
    : null;

  if (dirtyTileCells) {
    for (const [tileKey, dirtyIndices] of dirtyTileCells.entries()) {
      const tile = visibleByKey.get(tileKey);
      if (!tile) {
        continue;
      }
      const tileData = tileStore.get(tileKey);
      if (!tileData) {
        continue;
      }
      yield { tile, tileData, dirtyIndices };
    }
    return;
  }

  for (const tile of visibleTiles) {
    const tileData = tileStore.get(tile.tileKey);
    if (!tileData) {
      continue;
    }
    yield { tile, tileData, dirtyIndices: null };
  }
}

function getActiveCursors(cursors, nowMs) {
  return [...cursors.values()]
    .filter((cursor) => nowMs - cursor.seenAt < 5_000)
    .sort((a, b) => b.seenAt - a.seenAt)
    .slice(0, MAX_REMOTE_CURSORS);
}

function drawCursors({ graphics, cursors, camera, viewportWidth, viewportHeight }) {
  const cellPx = camera.cellPixelSize;
  for (const cursor of cursors) {
    const worldX = Number.isFinite(cursor.drawX) ? cursor.drawX : cursor.x;
    const worldY = Number.isFinite(cursor.drawY) ? cursor.drawY : cursor.y;
    const screen = toScreen(worldX, worldY, camera, viewportWidth, viewportHeight);
    const color = stableCursorColor(cursor.uid);

    graphics.beginFill(color, 0.9);
    graphics.drawCircle(screen.x, screen.y, Math.max(2, cellPx * 0.28));
    graphics.endFill();
  }
}

export function renderDirtyAreas({
  graphics,
  camera,
  viewportWidth,
  viewportHeight,
  visibleTiles,
  dirtyTileCells,
  tileStore,
  heatStore,
}) {
  if (dirtyTileCells.size === 0) {
    return;
  }

  for (const { tile, tileData, dirtyIndices } of iterateVisibleTiles(visibleTiles, tileStore, dirtyTileCells)) {
    drawTileCells({
      graphics,
      camera,
      viewportWidth,
      viewportHeight,
      tile,
      tileData,
      heatStore,
      dirtyIndices,
    });
  }
}

export function renderScene({
  graphics,
  camera,
  viewportWidth,
  viewportHeight,
  visibleTiles,
  tileStore,
  heatStore,
  cursors,
}) {
  graphics.clear();
  drawBackground(graphics, viewportWidth, viewportHeight);

  for (const { tile, tileData } of iterateVisibleTiles(visibleTiles, tileStore)) {
    drawTileCells({
      graphics,
      camera,
      viewportWidth,
      viewportHeight,
      tile,
      tileData,
      heatStore,
      dirtyIndices: null,
    });
  }

  const activeCursors = getActiveCursors(cursors, Date.now());
  drawCursors({
    graphics,
    cursors: activeCursors,
    camera,
    viewportWidth,
    viewportHeight,
  });

  return activeCursors;
}
