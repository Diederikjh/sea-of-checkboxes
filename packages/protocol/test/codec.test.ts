import { TILE_CELL_COUNT } from "@sea/domain";
import { describe, expect, it } from "vitest";

import { decodeRle64, encodeRle64 } from "../src";

function randomBits(length: number, seed: number): Uint8Array {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };

  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = (next() & 1) as 0 | 1;
  }
  return out;
}

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

  it("supports golden vector encode/decode", () => {
    const bits = new Uint8Array([0, 0, 1, 1, 1, 0]);
    const encoded = encodeRle64(bits);

    expect(encoded).toBe("AgADAQEA");
    expect(decodeRle64(encoded, bits.length)).toEqual(bits);
  });

  it("splits long runs (>255) and still roundtrips", () => {
    const bits = new Uint8Array(TILE_CELL_COUNT);
    bits.fill(1, 0, 1024);

    const encoded = encodeRle64(bits);
    const decoded = decodeRle64(encoded, TILE_CELL_COUNT);

    expect(decoded).toEqual(bits);
  });

  it("roundtrips randomized bitstreams (fuzz-lite)", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const length = 1 + (seed * 73) % 2048;
      const bits = randomBits(length, seed);
      const encoded = encodeRle64(bits);
      const decoded = decodeRle64(encoded, bits.length);
      expect(decoded).toEqual(bits);
    }
  });

  it("accepts an empty payload when expected length is zero", () => {
    expect(decodeRle64("", 0)).toEqual(new Uint8Array(0));
  });

  it("rejects corrupt payload", () => {
    expect(() => decodeRle64("AQ==", TILE_CELL_COUNT)).toThrow();
  });

  it("rejects malformed decode payloads", () => {
    expect(() => decodeRle64("AAA=", 1)).toThrow();
    expect(() => decodeRle64("AQI=", 1)).toThrow();
    expect(() => decodeRle64("AgE=", 3)).toThrow();
    expect(() => decodeRle64("", 1)).toThrow();
  });

  it("rejects non-bit values", () => {
    const bits = new Uint8Array([0, 1, 2]);
    expect(() => encodeRle64(bits)).toThrow();
  });
});
