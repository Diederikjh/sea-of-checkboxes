import {
  EDIT_MIN_CELL_PX,
  MIN_CELL_PX,
  clampCameraCenter,
} from "@sea/domain";

const MAX_CELL_PX = 64;

export function createCamera(initial = {}) {
  const clamped = clampCameraCenter(initial.x ?? 0, initial.y ?? 0);
  return {
    x: clamped.x,
    y: clamped.y,
    cellPixelSize: initial.cellPixelSize ?? 12,
  };
}

export function panCamera(camera, deltaWorldX, deltaWorldY) {
  const clamped = clampCameraCenter(camera.x + deltaWorldX, camera.y + deltaWorldY);
  camera.x = clamped.x;
  camera.y = clamped.y;
}

export function zoomCamera(camera, factor) {
  const next = camera.cellPixelSize * factor;
  camera.cellPixelSize = Math.max(MIN_CELL_PX, Math.min(MAX_CELL_PX, next));
}

export function canEditAtZoom(camera) {
  return camera.cellPixelSize >= EDIT_MIN_CELL_PX;
}
