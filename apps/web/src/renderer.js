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

  graphics.beginFill(0x0a0f14, 1);
  graphics.drawRect(0, 0, viewportWidth, viewportHeight);
  graphics.endFill();

  const cellPx = camera.cellPixelSize;

  for (const tile of visibleTiles) {
    const tileData = tileStore.get(tile.tileKey);
    if (!tileData) {
      continue;
    }

    const tileWorldX = tile.tx * TILE_SIZE;
    const tileWorldY = tile.ty * TILE_SIZE;

    for (let index = 0; index < tileData.bits.length; index += 1) {
      const localX = index % TILE_SIZE;
      const localY = Math.floor(index / TILE_SIZE);
      const worldX = tileWorldX + localX;
      const worldY = tileWorldY + localY;

      const screen = toScreen(worldX, worldY, camera, viewportWidth, viewportHeight);
      if (
        screen.x + cellPx < 0 ||
        screen.x > viewportWidth ||
        screen.y + cellPx < 0 ||
        screen.y > viewportHeight
      ) {
        continue;
      }

      const value = tileData.bits[index];
      const heat = heatStore.getHeat(tile.tileKey, index);
      if (value === 0 && heat < 0.03 && cellPx < 10) {
        continue;
      }

      const fillColor = value === 1 ? 0x27c67b : heatToColor(heat);
      const alpha = value === 1 ? 0.95 : Math.min(0.85, 0.3 + heat * 0.6);
      graphics.beginFill(fillColor, alpha);
      graphics.drawRect(screen.x, screen.y, cellPx, cellPx);
      graphics.endFill();

      if (cellPx >= 12) {
        graphics.lineStyle(1, 0x253441, 0.28);
        graphics.drawRect(screen.x, screen.y, cellPx, cellPx);
        graphics.lineStyle(0);
      }
    }
  }

  const now = Date.now();
  const activeCursors = [...cursors.values()]
    .filter((cursor) => now - cursor.seenAt < 5_000)
    .sort((a, b) => b.seenAt - a.seenAt)
    .slice(0, MAX_REMOTE_CURSORS);

  for (const cursor of activeCursors) {
    const worldX = Number.isFinite(cursor.drawX) ? cursor.drawX : cursor.x;
    const worldY = Number.isFinite(cursor.drawY) ? cursor.drawY : cursor.y;
    const screen = toScreen(worldX, worldY, camera, viewportWidth, viewportHeight);
    const color = stableCursorColor(cursor.uid);

    graphics.beginFill(color, 0.9);
    graphics.drawCircle(screen.x, screen.y, Math.max(2, cellPx * 0.28));
    graphics.endFill();
  }

  return activeCursors;
}
