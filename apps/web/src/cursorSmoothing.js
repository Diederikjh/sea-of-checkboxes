import { CURSOR_MOVE_EPSILON } from "./cursorRenderConfig";

export function smoothCursors(cursors, dtSeconds) {
  const alpha = 1 - Math.exp(-14 * Math.max(0, dtSeconds));

  for (const cursor of cursors.values()) {
    if (!Number.isFinite(cursor.drawX) || !Number.isFinite(cursor.drawY)) {
      cursor.drawX = cursor.x;
      cursor.drawY = cursor.y;
      continue;
    }

    const nextX = cursor.drawX + (cursor.x - cursor.drawX) * alpha;
    const nextY = cursor.drawY + (cursor.y - cursor.drawY) * alpha;
    cursor.drawX = Math.abs(nextX - cursor.drawX) <= CURSOR_MOVE_EPSILON ? cursor.drawX : nextX;
    cursor.drawY = Math.abs(nextY - cursor.drawY) <= CURSOR_MOVE_EPSILON ? cursor.drawY : nextY;
  }
}
