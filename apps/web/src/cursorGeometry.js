import { toScreenPoint } from "./coords";

export function cursorWorldPosition(cursor) {
  return {
    x: Number.isFinite(cursor.drawX) ? cursor.drawX : cursor.x,
    y: Number.isFinite(cursor.drawY) ? cursor.drawY : cursor.y,
  };
}

export function worldToScreenPoint(worldX, worldY, camera, viewportWidth, viewportHeight) {
  return toScreenPoint(worldX, worldY, camera, viewportWidth, viewportHeight);
}

export function isScreenPointInViewport(screenX, screenY, viewportWidth, viewportHeight, marginPx = 0) {
  return !(
    screenX < -marginPx
    || screenX > viewportWidth + marginPx
    || screenY < -marginPx
    || screenY > viewportHeight + marginPx
  );
}

export function isScreenCellInViewport(screenX, screenY, cellPx, viewportWidth, viewportHeight, marginPx = 0) {
  return !(
    screenX + cellPx < -marginPx
    || screenX > viewportWidth + marginPx
    || screenY + cellPx < -marginPx
    || screenY > viewportHeight + marginPx
  );
}

export function isScreenCircleInViewport(screenX, screenY, radiusPx, viewportWidth, viewportHeight, marginPx = 0) {
  return !(
    screenX + radiusPx < -marginPx
    || screenX - radiusPx > viewportWidth + marginPx
    || screenY + radiusPx < -marginPx
    || screenY - radiusPx > viewportHeight + marginPx
  );
}
