import {
  MAX_TILE_ABS,
  TILE_CELL_COUNT,
  WORLD_MAX,
} from "./constants";

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function clampToWorld(value: number): number {
  return Math.max(-WORLD_MAX, Math.min(WORLD_MAX, value));
}

export function clampCameraCenter(x: number, y: number): { x: number; y: number } {
  return {
    x: clampToWorld(x),
    y: clampToWorld(y),
  };
}

export function isWorldCoordInBounds(x: number, y: number): boolean {
  return (
    isFiniteNumber(x) &&
    isFiniteNumber(y) &&
    Math.abs(x) <= WORLD_MAX &&
    Math.abs(y) <= WORLD_MAX
  );
}

export function isTileCoordInBounds(tx: number, ty: number): boolean {
  return (
    Number.isInteger(tx) &&
    Number.isInteger(ty) &&
    Math.abs(tx) <= MAX_TILE_ABS &&
    Math.abs(ty) <= MAX_TILE_ABS
  );
}

export function isCellIndexValid(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < TILE_CELL_COUNT;
}
