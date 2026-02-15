import { TILE_CELL_COUNT } from "@sea/domain";

export type TileOp = readonly [index: number, value: 0 | 1];

export interface TileState {
  bits: Uint8Array;
  ver: number;
}

export function createEmptyTileState(): TileState {
  return {
    bits: new Uint8Array(TILE_CELL_COUNT),
    ver: 0,
  };
}

export function applyCellOp(bits: Uint8Array, index: number, value: 0 | 1): boolean {
  if (bits[index] === value) {
    return false;
  }

  bits[index] = value;
  return true;
}

export function applyBatch(bits: Uint8Array, ops: readonly TileOp[]): number {
  let changeCount = 0;
  for (const [index, value] of ops) {
    if (applyCellOp(bits, index, value)) {
      changeCount += 1;
    }
  }
  return changeCount;
}
