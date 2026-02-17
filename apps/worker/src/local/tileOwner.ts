import { TILE_ENCODING, isCellIndexValid } from "@sea/domain";
import { createEmptyTileState, encodeRle64 } from "@sea/protocol";

import type { TileBatchMessage, TileSnapshotMessage, TileWatcher } from "./types";

export interface SetCellIntent {
  i: number;
  v: 0 | 1;
  op: string;
}

export interface SetCellResult {
  accepted: boolean;
  changed: boolean;
  ver: number;
  reason?: string;
}

export class TileOwner {
  readonly tileKey: string;
  readonly recentEdits: Array<{ index: number; atMs: number }>;

  #bits: Uint8Array;
  #ver: number;
  #watchers: Map<string, TileWatcher>;

  constructor(tileKey: string) {
    this.tileKey = tileKey;
    this.#bits = createEmptyTileState().bits;
    this.#ver = 0;
    this.#watchers = new Map();
    this.recentEdits = [];
  }

  registerWatcher(watcher: TileWatcher): void {
    this.#watchers.set(watcher.id, watcher);
  }

  unregisterWatcher(watcherId: string): void {
    this.#watchers.delete(watcherId);
  }

  getSnapshotMessage(): TileSnapshotMessage {
    return {
      t: "tileSnap",
      tile: this.tileKey,
      ver: this.#ver,
      enc: TILE_ENCODING,
      bits: encodeRle64(this.#bits),
    };
  }

  getVersion(): number {
    return this.#ver;
  }

  loadSnapshot(bits: Uint8Array, ver: number): void {
    if (!Number.isInteger(ver) || ver < 0) {
      throw new Error(`Invalid tile version: ${ver}`);
    }

    if (bits.length !== this.#bits.length) {
      throw new Error(`Invalid bit length: expected ${this.#bits.length}, got ${bits.length}`);
    }

    this.#bits = bits.slice();
    this.#ver = ver;
  }

  applySetCell(intent: SetCellIntent): SetCellResult {
    if (!isCellIndexValid(intent.i)) {
      return {
        accepted: false,
        changed: false,
        ver: this.#ver,
        reason: "invalid_cell_index",
      };
    }

    const current = this.#bits[intent.i] as 0 | 1;
    if (current === intent.v) {
      return {
        accepted: true,
        changed: false,
        ver: this.#ver,
      };
    }

    this.#bits[intent.i] = intent.v;
    this.#ver += 1;
    this.recentEdits.push({ index: intent.i, atMs: Date.now() });
    if (this.recentEdits.length > 5_000) {
      this.recentEdits.shift();
    }

    const batch: TileBatchMessage = {
      t: "cellUpBatch",
      tile: this.tileKey,
      fromVer: this.#ver,
      toVer: this.#ver,
      ops: [[intent.i, intent.v]],
    };

    for (const watcher of this.#watchers.values()) {
      watcher.receiveTileBatch(batch);
    }

    return {
      accepted: true,
      changed: true,
      ver: this.#ver,
    };
  }
}
