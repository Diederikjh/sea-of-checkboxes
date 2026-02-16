import { TILE_CELL_COUNT } from "@sea/domain";
import { describe, expect, it } from "vitest";

import {
  decodeClientMessageBinary,
  decodeFrames,
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  encodeFrame,
  encodeRle64,
  encodeServerMessageBinary,
  type ClientMessage,
  type ServerMessage,
} from "../src";

function jsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

describe("binary protocol codec", () => {
  it("roundtrips all client message variants", () => {
    const messages: ClientMessage[] = [
      { t: "sub", tiles: ["0:0", "-4:9"] },
      { t: "unsub", tiles: ["0:0"] },
      { t: "setCell", tile: "-4:9", i: 4095, v: 1, op: "abc-123" },
      { t: "cur", x: 123_456.5, y: -999.25 },
      { t: "resyncTile", tile: "-4:9", haveVer: 44 },
    ];

    for (const message of messages) {
      const encoded = encodeClientMessageBinary(message);
      const decoded = decodeClientMessageBinary(encoded);

      if (message.t === "cur") {
        expect(decoded.t).toBe("cur");
        if (decoded.t !== "cur") {
          continue;
        }
        expect(decoded.x).toBeCloseTo(message.x, 3);
        expect(decoded.y).toBeCloseTo(message.y, 3);
      } else {
        expect(decoded).toEqual(message);
      }
    }
  });

  it("roundtrips all server message variants", () => {
    const bits = new Uint8Array(TILE_CELL_COUNT);
    bits[2] = 1;
    bits[1023] = 1;

    const messages: ServerMessage[] = [
      { t: "hello", uid: "u_abc", name: "Alice" },
      {
        t: "tileSnap",
        tile: "-4:9",
        ver: 77,
        enc: "rle64",
        bits: encodeRle64(bits),
      },
      { t: "cellUp", tile: "-4:9", i: 128, v: 1, ver: 78 },
      {
        t: "cellUpBatch",
        tile: "-4:9",
        fromVer: 79,
        toVer: 81,
        ops: [[4, 1], [5, 0], [300, 1]],
      },
      { t: "curUp", uid: "u_remote", name: "Bob", x: 1200.75, y: -33.125 },
      { t: "err", code: "rate_limited", msg: "slow down" },
    ];

    for (const message of messages) {
      const encoded = encodeServerMessageBinary(message);
      const decoded = decodeServerMessageBinary(encoded);

      if (message.t === "curUp") {
        expect(decoded.t).toBe("curUp");
        if (decoded.t !== "curUp") {
          continue;
        }
        expect(decoded.uid).toBe(message.uid);
        expect(decoded.name).toBe(message.name);
        expect(decoded.x).toBeCloseTo(message.x, 3);
        expect(decoded.y).toBeCloseTo(message.y, 3);
      } else {
        expect(decoded).toEqual(message);
      }
    }
  });

  it("packs tile coordinates without string keys on wire", () => {
    const message: ClientMessage = {
      t: "setCell",
      tile: "-12345:67890",
      i: 1337,
      v: 1,
      op: "op",
    };

    const decoded = decodeClientMessageBinary(encodeClientMessageBinary(message));
    expect(decoded).toEqual(message);
  });

  it("binary payloads are smaller than JSON for hot-path messages", () => {
    const clientBatchLike: ClientMessage = {
      t: "sub",
      tiles: Array.from({ length: 50 }, (_, index) => `${index}:${-index}`),
    };

    const serverBatch: ServerMessage = {
      t: "cellUpBatch",
      tile: "12:44",
      fromVer: 5000,
      toVer: 5099,
      ops: Array.from({ length: 100 }, (_, index) => [index, (index % 2) as 0 | 1]),
    };

    const binaryClientSize = encodeClientMessageBinary(clientBatchLike).length;
    const jsonClientSize = jsonSize(clientBatchLike);

    const binaryServerSize = encodeServerMessageBinary(serverBatch).length;
    const jsonServerSize = jsonSize(serverBatch);

    expect(binaryClientSize).toBeLessThan(jsonClientSize);
    expect(binaryServerSize).toBeLessThan(jsonServerSize);
  });

  it("works with framing utilities", () => {
    const one = encodeFrame(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    const two = encodeFrame(encodeClientMessageBinary({ t: "unsub", tiles: ["0:0"] }));

    const joined = new Uint8Array(one.length + two.length);
    joined.set(one, 0);
    joined.set(two, one.length);

    const { frames, remainder } = decodeFrames(joined);
    expect(remainder.length).toBe(0);
    expect(frames.length).toBe(2);

    const firstFrame = frames[0];
    const secondFrame = frames[1];
    expect(firstFrame).toBeDefined();
    expect(secondFrame).toBeDefined();
    if (!firstFrame || !secondFrame) {
      return;
    }

    expect(decodeClientMessageBinary(firstFrame)).toEqual({ t: "sub", tiles: ["0:0"] });
    expect(decodeClientMessageBinary(secondFrame)).toEqual({ t: "unsub", tiles: ["0:0"] });
  });

  it("rejects unknown tags and truncated payloads", () => {
    expect(() => decodeClientMessageBinary(Uint8Array.from([255]))).toThrow();
    expect(() => decodeServerMessageBinary(Uint8Array.from([255]))).toThrow();

    const encodedClient = encodeClientMessageBinary({ t: "resyncTile", tile: "0:0", haveVer: 10 });
    const encodedServer = encodeServerMessageBinary({ t: "cellUp", tile: "0:0", i: 1, v: 1, ver: 3 });

    expect(() => decodeClientMessageBinary(encodedClient.slice(0, encodedClient.length - 1))).toThrow();
    expect(() => decodeServerMessageBinary(encodedServer.slice(0, encodedServer.length - 1))).toThrow();
  });
});
