import { TILE_CELL_COUNT, TILE_ENCODING } from "@sea/domain";
import {
  createEmptyTileState,
  decodeClientMessageBinary,
  encodeRle64,
  encodeServerMessageBinary,
} from "@sea/protocol";

const BOT_NAMES = ["BriskOtter481", "QuietFalcon233", "AmberBadger090"];

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function generateId(prefix) {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Math.floor(Math.random() * 1_000_000_000).toString(16)}`;
}

function createEmptyTileRecord() {
  return {
    state: createEmptyTileState(),
    subscribers: new Set(),
  };
}

export class MockTransport {
  #clientId;
  #name;
  #onServerPayload;
  #tileMap;
  #subscribedTiles;
  #botTimer;

  constructor() {
    this.#clientId = generateId("u");
    this.#name = BOT_NAMES[randomInt(BOT_NAMES.length)];
    this.#onServerPayload = () => {};
    this.#tileMap = new Map();
    this.#subscribedTiles = new Set();
    this.#botTimer = null;
  }

  connect(onServerPayload) {
    this.#onServerPayload = onServerPayload;
    this.#emit({
      t: "hello",
      uid: this.#clientId,
      name: this.#name,
      token: "mock-dev-token",
    });

    this.#startBotCursorFeed();
  }

  dispose() {
    if (this.#botTimer) {
      clearInterval(this.#botTimer);
      this.#botTimer = null;
    }
  }

  send(payload) {
    const message = decodeClientMessageBinary(payload);

    switch (message.t) {
      case "sub": {
        for (const tileKey of message.tiles) {
          this.#subscribedTiles.add(tileKey);
          const record = this.#getOrCreateTile(tileKey);
          record.subscribers.add(this.#clientId);
          this.#emitTileSnapshot(tileKey, record.state.bits, record.state.ver);
        }
        return;
      }
      case "unsub": {
        for (const tileKey of message.tiles) {
          this.#subscribedTiles.delete(tileKey);
          const record = this.#tileMap.get(tileKey);
          if (record) {
            record.subscribers.delete(this.#clientId);
          }
        }
        return;
      }
      case "setCell": {
        const record = this.#getOrCreateTile(message.tile);
        const prev = record.state.bits[message.i];
        if (prev === message.v) {
          return;
        }

        record.state.bits[message.i] = message.v;
        record.state.ver += 1;

        if (!this.#subscribedTiles.has(message.tile)) {
          return;
        }

        this.#emit({
          t: "cellUpBatch",
          tile: message.tile,
          fromVer: record.state.ver,
          toVer: record.state.ver,
          ops: [[message.i, message.v]],
        });
        return;
      }
      case "resyncTile": {
        const record = this.#getOrCreateTile(message.tile);
        this.#emitTileSnapshot(message.tile, record.state.bits, record.state.ver);
        return;
      }
      case "cur": {
        this.#emit({
          t: "curUp",
          uid: this.#clientId,
          name: this.#name,
          x: message.x,
          y: message.y,
        });
        return;
      }
      default:
        return;
    }
  }

  #getOrCreateTile(tileKey) {
    let record = this.#tileMap.get(tileKey);
    if (!record) {
      record = createEmptyTileRecord();
      this.#tileMap.set(tileKey, record);
    }
    return record;
  }

  #emitTileSnapshot(tileKey, bits, ver) {
    this.#emit({
      t: "tileSnap",
      tile: tileKey,
      ver,
      enc: TILE_ENCODING,
      bits: encodeRle64(bits),
    });
  }

  #emit(message) {
    this.#onServerPayload(encodeServerMessageBinary(message));
  }

  #startBotCursorFeed() {
    const bots = [
      { uid: "u_bot_a", name: "MintStoat111", phase: 0 },
      { uid: "u_bot_b", name: "RustFox707", phase: Math.PI / 2 },
    ];

    this.#botTimer = setInterval(() => {
      const now = Date.now() / 1_000;
      for (const bot of bots) {
        const radius = 60;
        const angularSpeed = 0.9;
        this.#emit({
          t: "curUp",
          uid: bot.uid,
          name: bot.name,
          x: Math.cos(now * angularSpeed + bot.phase) * radius,
          y: Math.sin(now * angularSpeed + bot.phase) * radius,
        });
      }
    }, 40);
  }
}

export function createMockTransport() {
  return new MockTransport();
}
