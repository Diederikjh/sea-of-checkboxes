import { MAX_TILES_SUBSCRIBED, WORLD_MAX } from "@sea/domain";
import { describe, expect, it } from "vitest";

import { parseClientMessage } from "../src";

describe("client message schema matrix", () => {
  it("parses all client message variants", () => {
    expect(parseClientMessage({ t: "sub", tiles: ["0:0", "1:-2"] }).t).toBe("sub");
    expect(parseClientMessage({ t: "unsub", tiles: ["0:0"] }).t).toBe("unsub");
    expect(
      parseClientMessage({
        t: "setCell",
        tile: "0:0",
        i: 0,
        v: 1,
        op: "op_1",
      }).t
    ).toBe("setCell");
    expect(parseClientMessage({ t: "cur", x: WORLD_MAX, y: -WORLD_MAX }).t).toBe("cur");
    expect(parseClientMessage({ t: "resyncTile", tile: "0:0", haveVer: 10 }).t).toBe("resyncTile");
  });

  it("rejects invalid discriminators and unknown payloads", () => {
    expect(() => parseClientMessage({ t: "unknown" })).toThrow();
    expect(() => parseClientMessage({ tiles: ["0:0"] })).toThrow();
  });

  it("rejects extra fields due to strict schemas", () => {
    expect(() => parseClientMessage({ t: "sub", tiles: ["0:0"], extra: true })).toThrow();
    expect(() => parseClientMessage({ t: "unsub", tiles: ["0:0"], extra: true })).toThrow();
    expect(() =>
      parseClientMessage({
        t: "setCell",
        tile: "0:0",
        i: 10,
        v: 1,
        op: "op_1",
        extra: true,
      })
    ).toThrow();
    expect(() => parseClientMessage({ t: "cur", x: 1, y: 2, extra: true })).toThrow();
    expect(() => parseClientMessage({ t: "resyncTile", tile: "0:0", haveVer: 1, extra: true })).toThrow();
  });

  it("rejects subscribe/unsubscribe overflow and invalid tile keys", () => {
    const tooManyTiles = Array.from({ length: MAX_TILES_SUBSCRIBED + 1 }, (_, index) => `${index}:0`);

    expect(() => parseClientMessage({ t: "sub", tiles: tooManyTiles })).toThrow();
    expect(() => parseClientMessage({ t: "unsub", tiles: ["0:0:1"] })).toThrow();
  });

  it("rejects invalid setCell payloads", () => {
    expect(() =>
      parseClientMessage({
        t: "setCell",
        tile: "0:0",
        i: -1,
        v: 1,
        op: "op",
      })
    ).toThrow();

    expect(() =>
      parseClientMessage({
        t: "setCell",
        tile: "0:0",
        i: 1.5,
        v: 1,
        op: "op",
      })
    ).toThrow();

    expect(() =>
      parseClientMessage({
        t: "setCell",
        tile: "0:0",
        i: 4096,
        v: 1,
        op: "op",
      })
    ).toThrow();

    expect(() =>
      parseClientMessage({
        t: "setCell",
        tile: "0:0",
        i: 10,
        v: 2,
        op: "op",
      })
    ).toThrow();

    expect(() =>
      parseClientMessage({
        t: "setCell",
        tile: "0:0",
        i: 10,
        v: 1,
        op: "",
      })
    ).toThrow();
  });

  it("rejects invalid cursor/resync payloads", () => {
    expect(() => parseClientMessage({ t: "cur", x: WORLD_MAX + 1, y: 0 })).toThrow();
    expect(() => parseClientMessage({ t: "cur", x: Number.NaN, y: 0 })).toThrow();
    expect(() => parseClientMessage({ t: "cur", x: Number.POSITIVE_INFINITY, y: 0 })).toThrow();
    expect(() => parseClientMessage({ t: "resyncTile", tile: "0:0", haveVer: -1 })).toThrow();
    expect(() => parseClientMessage({ t: "resyncTile", tile: "0:0", haveVer: 1.5 })).toThrow();
  });
});
