import { tileKeyFromTileCoord, worldToTile } from "./tile";

export interface VisibleTile {
  tileKey: string;
  tx: number;
  ty: number;
}

export interface VisibleTileInput {
  cameraX: number;
  cameraY: number;
  viewportWidthPx: number;
  viewportHeightPx: number;
  cellPixelSize: number;
  marginTiles?: number;
}

export function enumerateVisibleTiles(input: VisibleTileInput): VisibleTile[] {
  const {
    cameraX,
    cameraY,
    viewportWidthPx,
    viewportHeightPx,
    cellPixelSize,
    marginTiles = 1,
  } = input;

  if (cellPixelSize <= 0) {
    return [];
  }

  const halfWidthWorld = viewportWidthPx / (2 * cellPixelSize);
  const halfHeightWorld = viewportHeightPx / (2 * cellPixelSize);

  const minX = Math.floor(cameraX - halfWidthWorld);
  const maxX = Math.ceil(cameraX + halfWidthWorld);
  const minY = Math.floor(cameraY - halfHeightWorld);
  const maxY = Math.ceil(cameraY + halfHeightWorld);

  const minTile = worldToTile(minX, minY);
  const maxTile = worldToTile(maxX, maxY);

  const tiles: VisibleTile[] = [];
  for (let tx = minTile.tx - marginTiles; tx <= maxTile.tx + marginTiles; tx += 1) {
    for (let ty = minTile.ty - marginTiles; ty <= maxTile.ty + marginTiles; ty += 1) {
      tiles.push({
        tileKey: tileKeyFromTileCoord(tx, ty),
        tx,
        ty,
      });
    }
  }

  return tiles;
}
