import { TILE_CELL_COUNT } from "@sea/domain";
import { describe, expect, it } from "vitest";

import { decodeRle64, encodeRle64 } from "../src";

describe("rle64 codec", () => {
  it("encodes and decodes an all-zero tile", () => {
    const bits = new Uint8Array(TILE_CELL_COUNT);
    const encoded = encodeRle64(bits);
    const decoded = decodeRle64(encoded, TILE_CELL_COUNT);

    expect(decoded).toEqual(bits);
  });

  it("roundtrips mixed runs", () => {
    const bits = new Uint8Array(TILE_CELL_COUNT);
    bits.fill(1, 0, 32);
    bits.fill(1, 100, 120);
    bits.fill(1, 4000, TILE_CELL_COUNT);

    const encoded = encodeRle64(bits);
    const decoded = decodeRle64(encoded, TILE_CELL_COUNT);

    expect(decoded).toEqual(bits);
  });

  it("rejects corrupt payload", () => {
    expect(() => decodeRle64("AQ==", TILE_CELL_COUNT)).toThrow();
  });

  it("rejects non-bit values", () => {
    const bits = new Uint8Array([0, 1, 2]);
    expect(() => encodeRle64(bits)).toThrow();
  });
});
