import { applyCellOp } from "@sea/protocol";

import { LruMap } from "./lru";

export class TileStore {
  #cache;

  constructor(maxEntries = 512) {
    this.#cache = new LruMap(maxEntries);
  }

  get(tileKey) {
    return this.#cache.get(tileKey);
  }

  setSnapshot(tileKey, bits, ver) {
    this.#cache.set(tileKey, {
      tileKey,
      bits,
      ver,
    });
  }

  applySingle(tileKey, i, v, ver) {
    const tile = this.#cache.get(tileKey);
    if (!tile) {
      return { gap: true, haveVer: -1 };
    }

    if (ver !== tile.ver + 1) {
      return { gap: true, haveVer: tile.ver };
    }

    applyCellOp(tile.bits, i, v);
    tile.ver = ver;
    return { gap: false, haveVer: tile.ver };
  }

  applyBatch(tileKey, fromVer, toVer, ops) {
    const tile = this.#cache.get(tileKey);
    if (!tile) {
      return { gap: true, haveVer: -1 };
    }

    if (fromVer !== tile.ver + 1) {
      return { gap: true, haveVer: tile.ver };
    }

    for (const [index, value] of ops) {
      applyCellOp(tile.bits, index, value);
    }
    tile.ver = toVer;

    return { gap: false, haveVer: tile.ver };
  }
}
