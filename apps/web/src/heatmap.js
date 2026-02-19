import {
  HEAT_BUMP,
  HEAT_TAU_SECONDS,
  HOT_DISABLE_MS,
  HOT_DISABLE_THRESHOLD,
  TILE_CELL_COUNT,
} from "@sea/domain";

const HEAT_VISIBLE_THRESHOLD = 0.01;

export class HeatStore {
  #tiles;
  #activeTiles;

  constructor() {
    this.#tiles = new Map();
    this.#activeTiles = new Set();
  }

  ensureTile(tileKey) {
    let tile = this.#tiles.get(tileKey);
    if (tile) {
      return tile;
    }

    tile = {
      heat: new Float32Array(TILE_CELL_COUNT),
      disabledUntilMs: new Float64Array(TILE_CELL_COUNT),
      activeHeatIndices: new Set(),
    };
    this.#tiles.set(tileKey, tile);
    return tile;
  }

  bump(tileKey, index, nowMs) {
    const tile = this.ensureTile(tileKey);
    const nextHeat = Math.min(1, tile.heat[index] + HEAT_BUMP);
    tile.heat[index] = nextHeat;
    tile.activeHeatIndices.add(index);
    if (nextHeat > HEAT_VISIBLE_THRESHOLD) {
      this.#activeTiles.add(tileKey);
    }
    if (nextHeat > HOT_DISABLE_THRESHOLD) {
      tile.disabledUntilMs[index] = Math.max(tile.disabledUntilMs[index], nowMs + HOT_DISABLE_MS);
    }
  }

  decay(dtSeconds) {
    if (dtSeconds <= 0) {
      return false;
    }

    let hasVisibleHeat = false;
    const decayFactor = Math.exp(-dtSeconds / HEAT_TAU_SECONDS);
    for (const tileKey of this.#activeTiles) {
      const tile = this.#tiles.get(tileKey);
      if (!tile) {
        this.#activeTiles.delete(tileKey);
        continue;
      }

      for (const index of tile.activeHeatIndices) {
        const decayed = tile.heat[index] * decayFactor;
        if (decayed > HEAT_VISIBLE_THRESHOLD) {
          tile.heat[index] = decayed;
          hasVisibleHeat = true;
          continue;
        }

        tile.heat[index] = 0;
        tile.activeHeatIndices.delete(index);
      }

      if (tile.activeHeatIndices.size === 0) {
        this.#activeTiles.delete(tileKey);
      }
    }

    return hasVisibleHeat;
  }

  getHeat(tileKey, index) {
    const tile = this.#tiles.get(tileKey);
    return tile ? tile.heat[index] : 0;
  }

  isLocallyDisabled(tileKey, index, nowMs) {
    const tile = this.#tiles.get(tileKey);
    if (!tile) {
      return false;
    }
    return tile.disabledUntilMs[index] > nowMs;
  }
}
