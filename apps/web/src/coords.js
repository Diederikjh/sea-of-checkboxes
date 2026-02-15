export function toWorldCell(screenX, screenY, camera, viewportWidth, viewportHeight) {
  return {
    x: Math.floor((screenX - viewportWidth / 2) / camera.cellPixelSize + camera.x),
    y: Math.floor((screenY - viewportHeight / 2) / camera.cellPixelSize + camera.y),
  };
}

export function toScreenPoint(worldX, worldY, camera, viewportWidth, viewportHeight) {
  return {
    x: (worldX - camera.x) * camera.cellPixelSize + viewportWidth / 2,
    y: (worldY - camera.y) * camera.cellPixelSize + viewportHeight / 2,
  };
}
