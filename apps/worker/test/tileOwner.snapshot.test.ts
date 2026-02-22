import { TILE_CELL_COUNT } from "@sea/domain";
import { describe, expect, it } from "vitest";

import { TileOwner } from "../src/local/tileOwner";

describe("TileOwner snapshot loading", () => {
  it("loads snapshot bits and version", () => {
    const owner = new TileOwner("0:0");
    const bits = new Uint8Array(TILE_CELL_COUNT);
    bits[5] = 1;
    bits[1024] = 1;

    owner.loadSnapshot(bits, 42);
    const snapshot = owner.getSnapshotMessage();

    expect(snapshot.ver).toBe(42);
    expect(snapshot.tile).toBe("0:0");
    expect(snapshot.bits.length).toBeGreaterThan(0);
  });

  it("rejects invalid snapshots", () => {
    const owner = new TileOwner("0:0");

    expect(() => owner.loadSnapshot(new Uint8Array(TILE_CELL_COUNT - 1), 1)).toThrow();
    expect(() => owner.loadSnapshot(new Uint8Array(TILE_CELL_COUNT), -1)).toThrow();
  });

  it("dedupes duplicate op ids as no-op writes", () => {
    const owner = new TileOwner("0:0");

    const first = owner.applySetCell({
      i: 5,
      v: 1,
      op: "op_dup",
    });
    const duplicate = owner.applySetCell({
      i: 5,
      v: 0,
      op: "op_dup",
    });
    const snapshot = owner.getSnapshotMessage();

    expect(first).toMatchObject({ accepted: true, changed: true, ver: 1 });
    expect(duplicate).toMatchObject({
      accepted: true,
      changed: false,
      ver: 1,
      reason: "duplicate_op",
    });
    expect(snapshot.ver).toBe(1);
  });
});
