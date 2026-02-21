import {
  TILE_ENCODING,
  isTileCoordInBounds,
  parseTileKeyStrict,
  tileKeyFromTileCoord,
} from "@sea/domain";

import {
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "./messages";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const CLIENT_TAG = {
  sub: 1,
  unsub: 2,
  setCell: 3,
  cur: 4,
  resyncTile: 5,
} as const;

const SERVER_TAG = {
  hello: 101,
  tileSnap: 102,
  cellUp: 103,
  cellUpBatch: 104,
  curUp: 105,
  err: 106,
} as const;

function encodeBase64Bytes(bytes: Uint8Array): string {
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

function decodeBase64Bytes(encoded: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }

  const atobFn = (globalThis as { atob?: (value: string) => string }).atob;
  if (!atobFn) {
    throw new Error("No base64 decoder available in this runtime");
  }

  const binary = atobFn(encoded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }

  return out;
}

class BinaryWriter {
  #chunks: Uint8Array[];
  #length: number;

  constructor() {
    this.#chunks = [];
    this.#length = 0;
  }

  writeU8(value: number): void {
    const chunk = new Uint8Array(1);
    chunk[0] = value & 0xff;
    this.#push(chunk);
  }

  writeU16(value: number): void {
    const chunk = new Uint8Array(2);
    new DataView(chunk.buffer).setUint16(0, value);
    this.#push(chunk);
  }

  writeU32(value: number): void {
    const chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setUint32(0, value);
    this.#push(chunk);
  }

  writeI32(value: number): void {
    const chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setInt32(0, value);
    this.#push(chunk);
  }

  writeF32(value: number): void {
    const chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setFloat32(0, value);
    this.#push(chunk);
  }

  writeString(value: string): void {
    const encoded = textEncoder.encode(value);
    if (encoded.length > 0xffff) {
      throw new Error(`String too long to encode: ${encoded.length} bytes`);
    }

    this.writeU16(encoded.length);
    this.writeBytes(encoded);
  }

  writeBytes(value: Uint8Array): void {
    this.#push(value);
  }

  writeLengthPrefixedBytes(value: Uint8Array): void {
    this.writeU32(value.length);
    this.writeBytes(value);
  }

  writeTileKey(tileKey: string): void {
    const parsed = parseTileKeyStrict(tileKey);
    if (!parsed || !isTileCoordInBounds(parsed.tx, parsed.ty)) {
      throw new Error(`Invalid tile key for binary encoding: ${tileKey}`);
    }

    this.writeI32(parsed.tx);
    this.writeI32(parsed.ty);
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  #push(chunk: Uint8Array): void {
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }
}

class BinaryReader {
  #bytes: Uint8Array;
  #offset: number;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#offset = 0;
  }

  readU8(): number {
    this.#ensure(1);
    const value = this.#bytes[this.#offset];
    if (value === undefined) {
      throw new Error("Unexpected EOF while reading u8");
    }
    this.#offset += 1;
    return value;
  }

  readU16(): number {
    this.#ensure(2);
    const view = this.#view(2);
    const value = view.getUint16(0);
    this.#offset += 2;
    return value;
  }

  readU32(): number {
    this.#ensure(4);
    const view = this.#view(4);
    const value = view.getUint32(0);
    this.#offset += 4;
    return value;
  }

  readI32(): number {
    this.#ensure(4);
    const view = this.#view(4);
    const value = view.getInt32(0);
    this.#offset += 4;
    return value;
  }

  readF32(): number {
    this.#ensure(4);
    const view = this.#view(4);
    const value = view.getFloat32(0);
    this.#offset += 4;
    return value;
  }

  readString(): string {
    const length = this.readU16();
    const bytes = this.readBytes(length);
    return textDecoder.decode(bytes);
  }

  readBytes(length: number): Uint8Array {
    this.#ensure(length);
    const out = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return out;
  }

  readLengthPrefixedBytes(): Uint8Array {
    const length = this.readU32();
    return this.readBytes(length);
  }

  readTileKey(): string {
    const tx = this.readI32();
    const ty = this.readI32();
    if (!isTileCoordInBounds(tx, ty)) {
      throw new Error(`Decoded out-of-bounds tile coordinates: ${tx}:${ty}`);
    }
    return tileKeyFromTileCoord(tx, ty);
  }

  ensureFullyRead(): void {
    if (this.#offset !== this.#bytes.length) {
      throw new Error(`Trailing bytes in payload: ${this.#bytes.length - this.#offset}`);
    }
  }

  #view(length: number): DataView {
    return new DataView(
      this.#bytes.buffer,
      this.#bytes.byteOffset + this.#offset,
      length
    );
  }

  #ensure(length: number): void {
    if (this.#offset + length > this.#bytes.length) {
      throw new Error("Unexpected end of binary payload");
    }
  }
}

function readTileList(reader: BinaryReader): string[] {
  const count = reader.readU16();
  const out: string[] = [];

  for (let index = 0; index < count; index += 1) {
    out.push(reader.readTileKey());
  }

  return out;
}

function writeTileList(writer: BinaryWriter, tiles: string[]): void {
  if (tiles.length > 0xffff) {
    throw new Error(`Too many tiles to encode: ${tiles.length}`);
  }

  writer.writeU16(tiles.length);
  for (const tile of tiles) {
    writer.writeTileKey(tile);
  }
}

export function encodeClientMessageBinary(message: ClientMessage): Uint8Array {
  const writer = new BinaryWriter();

  switch (message.t) {
    case "sub":
      writer.writeU8(CLIENT_TAG.sub);
      writeTileList(writer, message.tiles);
      break;
    case "unsub":
      writer.writeU8(CLIENT_TAG.unsub);
      writeTileList(writer, message.tiles);
      break;
    case "setCell":
      writer.writeU8(CLIENT_TAG.setCell);
      writer.writeTileKey(message.tile);
      writer.writeU16(message.i);
      writer.writeU8(message.v);
      writer.writeString(message.op);
      break;
    case "cur":
      writer.writeU8(CLIENT_TAG.cur);
      writer.writeF32(message.x);
      writer.writeF32(message.y);
      break;
    case "resyncTile":
      writer.writeU8(CLIENT_TAG.resyncTile);
      writer.writeTileKey(message.tile);
      writer.writeU32(message.haveVer);
      break;
    default:
      return assertNever(message);
  }

  return writer.toUint8Array();
}

export function decodeClientMessageBinary(payload: Uint8Array): ClientMessage {
  const reader = new BinaryReader(payload);
  const tag = reader.readU8();

  let decoded: ClientMessage;

  switch (tag) {
    case CLIENT_TAG.sub:
      decoded = {
        t: "sub",
        tiles: readTileList(reader),
      };
      break;
    case CLIENT_TAG.unsub:
      decoded = {
        t: "unsub",
        tiles: readTileList(reader),
      };
      break;
    case CLIENT_TAG.setCell:
      decoded = {
        t: "setCell",
        tile: reader.readTileKey(),
        i: reader.readU16(),
        v: toBit(reader.readU8()),
        op: reader.readString(),
      };
      break;
    case CLIENT_TAG.cur:
      decoded = {
        t: "cur",
        x: reader.readF32(),
        y: reader.readF32(),
      };
      break;
    case CLIENT_TAG.resyncTile:
      decoded = {
        t: "resyncTile",
        tile: reader.readTileKey(),
        haveVer: reader.readU32(),
      };
      break;
    default:
      throw new Error(`Unknown client binary tag: ${tag}`);
  }

  reader.ensureFullyRead();
  return parseClientMessage(decoded);
}

export function encodeServerMessageBinary(message: ServerMessage): Uint8Array {
  const writer = new BinaryWriter();

  switch (message.t) {
    case "hello":
      writer.writeU8(SERVER_TAG.hello);
      writer.writeString(message.uid);
      writer.writeString(message.name);
      writer.writeString(message.token);
      break;
    case "tileSnap": {
      if (message.enc !== TILE_ENCODING) {
        throw new Error(`Unsupported tile encoding for binary payload: ${message.enc}`);
      }
      writer.writeU8(SERVER_TAG.tileSnap);
      writer.writeTileKey(message.tile);
      writer.writeU32(message.ver);
      writer.writeLengthPrefixedBytes(decodeBase64Bytes(message.bits));
      break;
    }
    case "cellUp":
      writer.writeU8(SERVER_TAG.cellUp);
      writer.writeTileKey(message.tile);
      writer.writeU16(message.i);
      writer.writeU8(message.v);
      writer.writeU32(message.ver);
      break;
    case "cellUpBatch": {
      writer.writeU8(SERVER_TAG.cellUpBatch);
      writer.writeTileKey(message.tile);
      writer.writeU32(message.fromVer);
      writer.writeU32(message.toVer);
      if (message.ops.length > 0xffff) {
        throw new Error(`Too many ops in batch: ${message.ops.length}`);
      }
      writer.writeU16(message.ops.length);
      for (const [index, value] of message.ops) {
        writer.writeU16(index);
        writer.writeU8(value);
      }
      break;
    }
    case "curUp":
      writer.writeU8(SERVER_TAG.curUp);
      writer.writeString(message.uid);
      writer.writeString(message.name);
      writer.writeF32(message.x);
      writer.writeF32(message.y);
      break;
    case "err":
      writer.writeU8(SERVER_TAG.err);
      writer.writeString(message.code);
      writer.writeString(message.msg);
      break;
    default:
      return assertNever(message);
  }

  return writer.toUint8Array();
}

export function decodeServerMessageBinary(payload: Uint8Array): ServerMessage {
  const reader = new BinaryReader(payload);
  const tag = reader.readU8();

  let decoded: ServerMessage;

  switch (tag) {
    case SERVER_TAG.hello:
      decoded = {
        t: "hello",
        uid: reader.readString(),
        name: reader.readString(),
        token: reader.readString(),
      };
      break;
    case SERVER_TAG.tileSnap:
      decoded = {
        t: "tileSnap",
        tile: reader.readTileKey(),
        ver: reader.readU32(),
        enc: TILE_ENCODING,
        bits: encodeBase64Bytes(reader.readLengthPrefixedBytes()),
      };
      break;
    case SERVER_TAG.cellUp:
      decoded = {
        t: "cellUp",
        tile: reader.readTileKey(),
        i: reader.readU16(),
        v: toBit(reader.readU8()),
        ver: reader.readU32(),
      };
      break;
    case SERVER_TAG.cellUpBatch: {
      const tile = reader.readTileKey();
      const fromVer = reader.readU32();
      const toVer = reader.readU32();
      const opCount = reader.readU16();

      const ops: Array<[number, 0 | 1]> = [];
      for (let index = 0; index < opCount; index += 1) {
        ops.push([reader.readU16(), toBit(reader.readU8())]);
      }

      decoded = {
        t: "cellUpBatch",
        tile,
        fromVer,
        toVer,
        ops,
      };
      break;
    }
    case SERVER_TAG.curUp:
      decoded = {
        t: "curUp",
        uid: reader.readString(),
        name: reader.readString(),
        x: reader.readF32(),
        y: reader.readF32(),
      };
      break;
    case SERVER_TAG.err:
      decoded = {
        t: "err",
        code: reader.readString(),
        msg: reader.readString(),
      };
      break;
    default:
      throw new Error(`Unknown server binary tag: ${tag}`);
  }

  reader.ensureFullyRead();
  return parseServerMessage(decoded);
}

function toBit(value: number): 0 | 1 {
  if (value !== 0 && value !== 1) {
    throw new Error(`Invalid bit value in binary payload: ${value}`);
  }
  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled protocol message: ${JSON.stringify(value)}`);
}
