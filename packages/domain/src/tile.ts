import { TILE_CELL_COUNT, TILE_SIZE } from "./constants";

export interface TileCoord {
  tx: number;
  ty: number;
}

export interface WorldCoord {
  x: number;
  y: number;
}

export function tileKeyFromTileCoord(tx: number, ty: number): string {
  return `${tx}:${ty}`;
}

export function parseTileKeyStrict(tileKey: string): TileCoord | null {
  const match = /^(-?\d+):(-?\d+)$/.exec(tileKey);
  if (!match) {
    return null;
  }

  const [, txRaw, tyRaw] = match;
  if (txRaw === undefined || tyRaw === undefined) {
    return null;
  }

  const tx = Number.parseInt(txRaw, 10);
  const ty = Number.parseInt(tyRaw, 10);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    return null;
  }

  return { tx, ty };
}

export function worldToTile(x: number, y: number): TileCoord {
  return {
    tx: Math.floor(x / TILE_SIZE),
    ty: Math.floor(y / TILE_SIZE),
  };
}

export function tileKeyFromWorld(x: number, y: number): string {
  const { tx, ty } = worldToTile(x, y);
  return tileKeyFromTileCoord(tx, ty);
}

function mod(n: number, d: number): number {
  return ((n % d) + d) % d;
}

export function worldToLocalCell(x: number, y: number): { localX: number; localY: number } {
  return {
    localX: mod(x, TILE_SIZE),
    localY: mod(y, TILE_SIZE),
  };
}

export function cellIndexFromWorld(x: number, y: number): number {
  const { localX, localY } = worldToLocalCell(x, y);
  return localY * TILE_SIZE + localX;
}

export function cellIndexToLocal(index: number): { localX: number; localY: number } {
  if (!Number.isInteger(index) || index < 0 || index >= TILE_CELL_COUNT) {
    throw new RangeError(`cell index out of range: ${index}`);
  }

  return {
    localX: index % TILE_SIZE,
    localY: Math.floor(index / TILE_SIZE),
  };
}

export function worldFromTileCell(tx: number, ty: number, cellIndex: number): WorldCoord {
  const { localX, localY } = cellIndexToLocal(cellIndex);
  return {
    x: tx * TILE_SIZE + localX,
    y: ty * TILE_SIZE + localY,
  };
}
