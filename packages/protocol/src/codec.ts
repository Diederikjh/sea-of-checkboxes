import { TILE_CELL_COUNT } from "@sea/domain";

function isBit(value: number): value is 0 | 1 {
  return value === 0 || value === 1;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  const btoaFn = (globalThis as { btoa?: (value: string) => string }).btoa;
  if (!btoaFn) {
    throw new Error("No base64 encoder available in this runtime");
  }
  return btoaFn(binary);
}

function fromBase64(encoded: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }

  const atobFn = (globalThis as { atob?: (value: string) => string }).atob;
  if (!atobFn) {
    throw new Error("No base64 decoder available in this runtime");
  }

  const binary = atobFn(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeRle64(bits: Uint8Array): string {
  if (bits.length === 0) {
    return "";
  }

  const output: number[] = [];
  let cursor = 0;

  while (cursor < bits.length) {
    const value = bits[cursor];
    if (value === undefined || !isBit(value)) {
      throw new Error(`Invalid bit value at index ${cursor}: ${value}`);
    }

    let runLength = 1;
    while (
      cursor + runLength < bits.length &&
      bits[cursor + runLength] === value &&
      runLength < 255
    ) {
      runLength += 1;
    }

    output.push(runLength, value);
    cursor += runLength;
  }

  return toBase64(Uint8Array.from(output));
}

export function decodeRle64(encoded: string, expectedLength = TILE_CELL_COUNT): Uint8Array {
  if (!encoded) {
    if (expectedLength === 0) {
      return new Uint8Array(0);
    }
    throw new Error("Encoded payload is empty");
  }

  const bytes = fromBase64(encoded);
  if (bytes.length % 2 !== 0) {
    throw new Error("Corrupt RLE payload: expected even number of bytes");
  }

  const output: number[] = [];
  for (let index = 0; index < bytes.length; index += 2) {
    const runLength = bytes[index];
    const value = bytes[index + 1];

    if (runLength === undefined || runLength < 1) {
      throw new Error(`Invalid run length at byte ${index}`);
    }
    if (value === undefined || !isBit(value)) {
      throw new Error(`Invalid bit value at byte ${index + 1}: ${value}`);
    }

    for (let repeat = 0; repeat < runLength; repeat += 1) {
      output.push(value);
    }
  }

  if (output.length !== expectedLength) {
    throw new Error(`Decoded bit length mismatch: expected ${expectedLength}, got ${output.length}`);
  }

  return Uint8Array.from(output);
}
