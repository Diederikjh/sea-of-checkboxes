export const CURSOR_TTL_MS = 5_000;
export const CURSOR_MOVE_EPSILON = 0.01;
export const CURSOR_MIN_RADIUS_PX = 2;
export const CURSOR_RADIUS_SCALE = 0.28;

export function cursorRadiusPx(cellPixelSize) {
  return Math.max(CURSOR_MIN_RADIUS_PX, cellPixelSize * CURSOR_RADIUS_SCALE);
}
