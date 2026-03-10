const TILE_SIZE = 64;
const TILE_CELL_COUNT = TILE_SIZE * TILE_SIZE;
const SHARD_COUNT = 8;

const CLIENT_TAG = Object.freeze({
  sub: 1,
  unsub: 2,
  setCell: 3,
  cur: 4,
  resyncTile: 5,
});

const SERVER_TAG = Object.freeze({
  hello: 101,
  tileSnap: 102,
  cellUp: 103,
  cellUpBatch: 104,
  curUp: 105,
  err: 106,
  subAck: 107,
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class BinaryWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  writeU8(value) {
    const chunk = new Uint8Array(1);
    chunk[0] = value & 0xff;
    this.#push(chunk);
  }

  writeU16(value) {
    const chunk = new Uint8Array(2);
    new DataView(chunk.buffer).setUint16(0, value);
    this.#push(chunk);
  }

  writeU32(value) {
    const chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setUint32(0, value);
    this.#push(chunk);
  }

  writeI32(value) {
    const chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setInt32(0, value);
    this.#push(chunk);
  }

  writeF32(value) {
    const chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setFloat32(0, value);
    this.#push(chunk);
  }

  writeString(value) {
    const encoded = textEncoder.encode(value);
    this.writeU16(encoded.length);
    this.writeBytes(encoded);
  }

  writeBytes(value) {
    this.#push(value);
  }

  writeLengthPrefixedBytes(value) {
    this.writeU32(value.length);
    this.writeBytes(value);
  }

  writeTileKey(tileKey) {
    const parsed = parseTileKey(tileKey);
    if (!parsed) {
      throw new Error(`Invalid tile key: ${tileKey}`);
    }
    this.writeI32(parsed.tx);
    this.writeI32(parsed.ty);
  }

  toUint8Array() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  #push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }
}

class BinaryReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  readU8() {
    this.#ensure(1);
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  readU16() {
    this.#ensure(2);
    const value = this.#view(2).getUint16(0);
    this.offset += 2;
    return value;
  }

  readU32() {
    this.#ensure(4);
    const value = this.#view(4).getUint32(0);
    this.offset += 4;
    return value;
  }

  readI32() {
    this.#ensure(4);
    const value = this.#view(4).getInt32(0);
    this.offset += 4;
    return value;
  }

  readF32() {
    this.#ensure(4);
    const value = this.#view(4).getFloat32(0);
    this.offset += 4;
    return value;
  }

  readString() {
    const length = this.readU16();
    const bytes = this.readBytes(length);
    return textDecoder.decode(bytes);
  }

  readBytes(length) {
    this.#ensure(length);
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  readLengthPrefixedBytes() {
    const length = this.readU32();
    return this.readBytes(length);
  }

  readTileKey() {
    const tx = this.readI32();
    const ty = this.readI32();
    return `${tx}:${ty}`;
  }

  remainingBytes() {
    return this.bytes.length - this.offset;
  }

  ensureFullyRead() {
    if (this.offset !== this.bytes.length) {
      throw new Error(`Trailing bytes in payload: ${this.bytes.length - this.offset}`);
    }
  }

  #view(length) {
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, length);
  }

  #ensure(length) {
    if (this.offset + length > this.bytes.length) {
      throw new Error("Unexpected end of binary payload");
    }
  }
}

function writeOptionalString(writer, value) {
  writer.writeU8(typeof value === "string" && value.length > 0 ? 1 : 0);
  if (typeof value === "string" && value.length > 0) {
    writer.writeString(value);
  }
}

function readOptionalString(reader) {
  if (reader.remainingBytes() <= 0) {
    return undefined;
  }
  const marker = reader.readU8();
  if (marker === 0) {
    return undefined;
  }
  if (marker !== 1) {
    throw new Error(`Invalid optional string marker: ${marker}`);
  }
  return reader.readString();
}

function writeTileList(writer, tiles) {
  writer.writeU16(tiles.length);
  for (const tile of tiles) {
    writer.writeTileKey(tile);
  }
}

function readTileList(reader) {
  const count = reader.readU16();
  const tiles = [];
  for (let index = 0; index < count; index += 1) {
    tiles.push(reader.readTileKey());
  }
  return tiles;
}

function encodeBase64Bytes(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function toBit(value) {
  if (value !== 0 && value !== 1) {
    throw new Error(`Invalid bit value: ${value}`);
  }
  return value;
}

export function encodeClientMessageBinary(message) {
  const writer = new BinaryWriter();

  switch (message.t) {
    case "sub":
      writer.writeU8(CLIENT_TAG.sub);
      writeTileList(writer, message.tiles);
      writeOptionalString(writer, message.cid);
      break;
    case "unsub":
      writer.writeU8(CLIENT_TAG.unsub);
      writeTileList(writer, message.tiles);
      writeOptionalString(writer, message.cid);
      break;
    case "setCell":
      writer.writeU8(CLIENT_TAG.setCell);
      writer.writeTileKey(message.tile);
      writer.writeU16(message.i);
      writer.writeU8(message.v);
      writer.writeString(message.op);
      writeOptionalString(writer, message.cid);
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
      writeOptionalString(writer, message.cid);
      break;
    default:
      throw new Error(`Unhandled client message type: ${message.t}`);
  }

  return writer.toUint8Array();
}

export function decodeServerMessageBinary(payload) {
  const reader = new BinaryReader(payload);
  const tag = reader.readU8();

  let decoded;
  switch (tag) {
    case SERVER_TAG.hello:
      decoded = {
        t: "hello",
        uid: reader.readString(),
        name: reader.readString(),
        token: reader.readString(),
      };
      if (reader.remainingBytes() > 0) {
        const hasSpawn = reader.readU8();
        if (hasSpawn === 1) {
          decoded.spawn = {
            x: reader.readF32(),
            y: reader.readF32(),
          };
        } else if (hasSpawn !== 0) {
          throw new Error(`Invalid hello spawn marker: ${hasSpawn}`);
        }
      }
      break;
    case SERVER_TAG.tileSnap:
      decoded = {
        t: "tileSnap",
        tile: reader.readTileKey(),
        ver: reader.readU32(),
        enc: "rle64",
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
      const ops = [];
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
        ver: reader.readU32(),
      };
      break;
    case SERVER_TAG.err:
      decoded = {
        t: "err",
        code: reader.readString(),
        msg: reader.readString(),
      };
      if (reader.remainingBytes() > 0) {
        const hasTrace = reader.readU8();
        if (hasTrace === 1) {
          decoded.trace = reader.readString();
        }
      }
      break;
    case SERVER_TAG.subAck:
      decoded = {
        t: "subAck",
        cid: reader.readString(),
        requestedCount: reader.readU32(),
        changedCount: reader.readU32(),
        subscribedCount: reader.readU32(),
      };
      break;
    default:
      throw new Error(`Unknown server binary tag: ${tag}`);
  }

  reader.ensureFullyRead();
  return decoded;
}

export function decodeRle64(encoded, expectedLength = TILE_CELL_COUNT) {
  if (!encoded) {
    if (expectedLength === 0) {
      return new Uint8Array(0);
    }
    throw new Error("Encoded payload is empty");
  }

  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (bytes.length % 2 !== 0) {
    throw new Error("Corrupt RLE payload: expected even number of bytes");
  }

  const output = [];
  for (let index = 0; index < bytes.length; index += 2) {
    const runLength = bytes[index];
    const value = bytes[index + 1];
    if (runLength === undefined || runLength < 1) {
      throw new Error(`Invalid run length at byte ${index}`);
    }
    if (value !== 0 && value !== 1) {
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

export function parseTileKey(tileKey) {
  const match = /^(-?\d+):(-?\d+)$/.exec(tileKey);
  if (!match) {
    return null;
  }
  return {
    tx: Number.parseInt(match[1], 10),
    ty: Number.parseInt(match[2], 10),
  };
}

export function worldToTileKey(x, y) {
  return `${Math.floor(x / TILE_SIZE)}:${Math.floor(y / TILE_SIZE)}`;
}

export function worldToCellIndex(x, y) {
  const localX = mod(Math.floor(x), TILE_SIZE);
  const localY = mod(Math.floor(y), TILE_SIZE);
  return (localY * TILE_SIZE) + localX;
}

export function shardNameForUid(uid) {
  let hash = 2166136261;
  for (let index = 0; index < uid.length; index += 1) {
    hash ^= uid.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const shard = Math.abs(hash) % SHARD_COUNT;
  return `shard-${shard}`;
}

export function buildSocketUrl(baseUrl, token = "", clientSessionId = "") {
  const parsed = new URL(baseUrl);
  if (typeof token === "string" && token.length > 0) {
    parsed.searchParams.set("token", token);
  }
  if (typeof clientSessionId === "string" && clientSessionId.length > 0) {
    parsed.searchParams.set("clientSessionId", clientSessionId);
  }
  return parsed.toString();
}

export function toUint8Array(messageData) {
  if (messageData instanceof Uint8Array) {
    return messageData;
  }

  if (messageData instanceof ArrayBuffer) {
    return new Uint8Array(messageData);
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(messageData)) {
    return new Uint8Array(messageData.buffer, messageData.byteOffset, messageData.byteLength);
  }

  return null;
}

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}
