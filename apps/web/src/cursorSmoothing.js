export function smoothCursors(cursors, dtSeconds) {
  const alpha = 1 - Math.exp(-14 * Math.max(0, dtSeconds));
  let moved = false;

  for (const cursor of cursors.values()) {
    if (!Number.isFinite(cursor.drawX) || !Number.isFinite(cursor.drawY)) {
      cursor.drawX = cursor.x;
      cursor.drawY = cursor.y;
      moved = true;
      continue;
    }

    const previousX = cursor.drawX;
    const previousY = cursor.drawY;
    cursor.drawX += (cursor.x - cursor.drawX) * alpha;
    cursor.drawY += (cursor.y - cursor.drawY) * alpha;

    if (Math.abs(cursor.drawX - previousX) > 0.01 || Math.abs(cursor.drawY - previousY) > 0.01) {
      moved = true;
    }
  }

  return moved;
}
