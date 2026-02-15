export function smoothCursors(cursors, dtSeconds) {
  const alpha = 1 - Math.exp(-14 * Math.max(0, dtSeconds));

  for (const cursor of cursors.values()) {
    if (!Number.isFinite(cursor.drawX) || !Number.isFinite(cursor.drawY)) {
      cursor.drawX = cursor.x;
      cursor.drawY = cursor.y;
      continue;
    }

    cursor.drawX += (cursor.x - cursor.drawX) * alpha;
    cursor.drawY += (cursor.y - cursor.drawY) * alpha;
  }
}
