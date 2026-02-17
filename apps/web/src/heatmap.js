import {
  HEAT_BUMP,
  HEAT_TAU_SECONDS,
  HOT_DISABLE_MS,
  HOT_DISABLE_THRESHOLD,
  TILE_CELL_COUNT,
} from "@sea/domain";

export class HeatStore {
  #tiles;

  constructor() {
    this.#tiles = new Map();
  }

  ensureTile(tileKey) {
    let tile = this.#tiles.get(tileKey);
    if (tile) {
      return tile;
    }

    tile = {
      heat: new Float32Array(TILE_CELL_COUNT),
      disabledUntilMs: new Float64Array(TILE_CELL_COUNT),
    };
    this.#tiles.set(tileKey, tile);
    return tile;
  }

  bump(tileKey, index, nowMs) {
    const tile = this.ensureTile(tileKey);
    const nextHeat = Math.min(1, tile.heat[index] + HEAT_BUMP);
    tile.heat[index] = nextHeat;
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
    for (const tile of this.#tiles.values()) {
      for (let index = 0; index < tile.heat.length; index += 1) {
        tile.heat[index] *= decayFactor;
        if (tile.heat[index] > 0.01) {
          hasVisibleHeat = true;
        }
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
