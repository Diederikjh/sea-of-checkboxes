import { TILE_ENCODING, isCellIndexValid } from "@sea/domain";
import { createEmptyTileState, encodeRle64 } from "@sea/protocol";

import type { TileBatchMessage, TileSnapshotMessage, TileWatcher } from "./types";
import type { CellLastEditInfo, CellLastEditRecord } from "../doCommon";

export interface SetCellIntent {
  i: number;
  v: 0 | 1;
  op: string;
  uid?: string;
  name?: string;
  atMs?: number;
}

export interface SetCellResult {
  accepted: boolean;
  changed: boolean;
  ver: number;
  reason?: string;
}

const RECENT_OP_ID_LIMIT = 4_096;

export class TileOwner {
  readonly tileKey: string;
  readonly recentEdits: Array<{ index: number; atMs: number }>;

  #bits: Uint8Array;
  #ver: number;
  #watchers: Map<string, TileWatcher>;
  #cellLastEdits: Array<CellLastEditInfo | null>;
  #recentOpIds: Map<string, true>;

  constructor(tileKey: string) {
    this.tileKey = tileKey;
    this.#bits = createEmptyTileState().bits;
    this.#ver = 0;
    this.#watchers = new Map();
    this.#cellLastEdits = new Array<CellLastEditInfo | null>(this.#bits.length).fill(null);
    this.#recentOpIds = new Map();
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

  loadSnapshot(bits: Uint8Array, ver: number, edits: CellLastEditRecord[] = []): void {
    if (!Number.isInteger(ver) || ver < 0) {
      throw new Error(`Invalid tile version: ${ver}`);
    }

    if (bits.length !== this.#bits.length) {
      throw new Error(`Invalid bit length: expected ${this.#bits.length}, got ${bits.length}`);
    }

    this.#bits = bits.slice();
    this.#ver = ver;
    this.#cellLastEdits = new Array<CellLastEditInfo | null>(this.#bits.length).fill(null);
    this.#recentOpIds.clear();

    for (const edit of edits) {
      if (!isCellIndexValid(edit.i)) {
        continue;
      }

      this.#cellLastEdits[edit.i] = {
        uid: edit.uid,
        name: edit.name,
        atMs: edit.atMs,
      };
    }
  }

  getCellLastEdit(index: number): CellLastEditInfo | null {
    if (!isCellIndexValid(index)) {
      return null;
    }

    const edit = this.#cellLastEdits[index];
    if (!edit) {
      return null;
    }

    return {
      uid: edit.uid,
      name: edit.name,
      atMs: edit.atMs,
    };
  }

  getPersistedLastEdits(): CellLastEditRecord[] {
    const edits: CellLastEditRecord[] = [];

    for (let index = 0; index < this.#cellLastEdits.length; index += 1) {
      const edit = this.#cellLastEdits[index];
      if (!edit) {
        continue;
      }

      edits.push({
        i: index,
        uid: edit.uid,
        name: edit.name,
        atMs: edit.atMs,
      });
    }

    return edits;
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

    if (this.#recentOpIds.has(intent.op)) {
      return {
        accepted: true,
        changed: false,
        ver: this.#ver,
        reason: "duplicate_op",
      };
    }
    this.#recordRecentOpId(intent.op);

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
    const atMs =
      Number.isInteger(intent.atMs) && typeof intent.atMs === "number" && intent.atMs >= 0
        ? intent.atMs
        : Date.now();
    const uid = typeof intent.uid === "string" && intent.uid.length > 0 ? intent.uid : "unknown";
    const name = typeof intent.name === "string" && intent.name.length > 0 ? intent.name : "Unknown";
    this.#cellLastEdits[intent.i] = { uid, name, atMs };
    this.recentEdits.push({ index: intent.i, atMs });
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

  #recordRecentOpId(opId: string): void {
    if (this.#recentOpIds.has(opId)) {
      this.#recentOpIds.delete(opId);
    }
    this.#recentOpIds.set(opId, true);

    if (this.#recentOpIds.size <= RECENT_OP_ID_LIMIT) {
      return;
    }

    const oldest = this.#recentOpIds.keys().next().value as string | undefined;
    if (!oldest) {
      return;
    }
    this.#recentOpIds.delete(oldest);
  }
}
