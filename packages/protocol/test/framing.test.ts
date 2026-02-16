import { describe, expect, it } from "vitest";

import { decodeFrames, encodeFrame } from "../src";

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);

  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }

  return merged;
}

describe("length-prefixed framing", () => {
  it("encodes a frame with 4-byte length prefix", () => {
    const payload = Uint8Array.from([1, 2, 3]);
    const framed = encodeFrame(payload);

    expect(Array.from(framed)).toEqual([0, 0, 0, 3, 1, 2, 3]);
  });

  it("decodes single frame and empty remainder", () => {
    const payload = Uint8Array.from([9, 8, 7]);
    const result = decodeFrames(encodeFrame(payload));

    expect(result.frames).toHaveLength(1);
    const first = result.frames[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    expect(Array.from(first)).toEqual([9, 8, 7]);
    expect(result.remainder.length).toBe(0);
  });

  it("decodes multiple frames", () => {
    const first = encodeFrame(Uint8Array.from([1]));
    const second = encodeFrame(Uint8Array.from([2, 3]));

    const result = decodeFrames(concat(first, second));

    expect(result.frames).toHaveLength(2);
    const frameOne = result.frames[0];
    const frameTwo = result.frames[1];
    expect(frameOne).toBeDefined();
    expect(frameTwo).toBeDefined();
    if (!frameOne || !frameTwo) {
      return;
    }
    expect(Array.from(frameOne)).toEqual([1]);
    expect(Array.from(frameTwo)).toEqual([2, 3]);
    expect(result.remainder.length).toBe(0);
  });

  it("keeps trailing partial frame in remainder", () => {
    const full = encodeFrame(Uint8Array.from([4, 5]));
    const partial = encodeFrame(Uint8Array.from([6, 7, 8])).slice(0, 5);

    const result = decodeFrames(concat(full, partial));

    expect(result.frames).toHaveLength(1);
    const first = result.frames[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    expect(Array.from(first)).toEqual([4, 5]);
    expect(Array.from(result.remainder)).toEqual(Array.from(partial));
  });

  it("handles zero-length frames", () => {
    const emptyFrame = encodeFrame(new Uint8Array(0));
    const result = decodeFrames(emptyFrame);

    expect(result.frames).toHaveLength(1);
    const first = result.frames[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    expect(first.length).toBe(0);
  });

  it("rejects oversized frame header", () => {
    const header = new Uint8Array([0, 0, 0, 5]);
    expect(() => decodeFrames(header, { maxFrameBytes: 4 })).toThrow();
  });
});
