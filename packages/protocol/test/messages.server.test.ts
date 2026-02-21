import { WORLD_MAX } from "@sea/domain";
import { describe, expect, it } from "vitest";

import { parseServerMessage } from "../src";

describe("server message schema matrix", () => {
  it("parses all server message variants", () => {
    expect(parseServerMessage({ t: "hello", uid: "u_a", name: "Alice", token: "tok_1" }).t).toBe("hello");

    expect(
      parseServerMessage({
        t: "tileSnap",
        tile: "0:0",
        ver: 1,
        enc: "rle64",
        bits: "AA==",
      }).t
    ).toBe("tileSnap");

    expect(
      parseServerMessage({
        t: "cellUp",
        tile: "0:0",
        i: 1,
        v: 1,
        ver: 2,
      }).t
    ).toBe("cellUp");

    expect(
      parseServerMessage({
        t: "cellUpBatch",
        tile: "0:0",
        fromVer: 3,
        toVer: 4,
        ops: [[1, 1], [2, 0]],
      }).t
    ).toBe("cellUpBatch");

    expect(
      parseServerMessage({
        t: "curUp",
        uid: "u_a",
        name: "Alice",
        x: WORLD_MAX,
        y: -WORLD_MAX,
      }).t
    ).toBe("curUp");

    expect(parseServerMessage({ t: "err", code: "bad", msg: "Nope" }).t).toBe("err");
  });

  it("rejects unknown message discriminator", () => {
    expect(() => parseServerMessage({ t: "nope" })).toThrow();
  });

  it("rejects extra fields due to strict schemas", () => {
    expect(() => parseServerMessage({ t: "hello", uid: "u", name: "n", token: "tok", extra: true })).toThrow();
    expect(() =>
      parseServerMessage({
        t: "tileSnap",
        tile: "0:0",
        ver: 1,
        enc: "rle64",
        bits: "AA==",
        extra: true,
      })
    ).toThrow();
    expect(() =>
      parseServerMessage({
        t: "cellUp",
        tile: "0:0",
        i: 1,
        v: 1,
        ver: 1,
        extra: true,
      })
    ).toThrow();
    expect(() =>
      parseServerMessage({
        t: "cellUpBatch",
        tile: "0:0",
        fromVer: 1,
        toVer: 1,
        ops: [[1, 1]],
        extra: true,
      })
    ).toThrow();
    expect(() => parseServerMessage({ t: "curUp", uid: "u", name: "n", x: 0, y: 0, extra: true })).toThrow();
    expect(() => parseServerMessage({ t: "err", code: "c", msg: "m", extra: true })).toThrow();
  });

  it("rejects invalid tile snapshot payload", () => {
    expect(() =>
      parseServerMessage({
        t: "tileSnap",
        tile: "0:0",
        ver: 1,
        enc: "raw",
        bits: "AA==",
      })
    ).toThrow();

    expect(() =>
      parseServerMessage({
        t: "tileSnap",
        tile: "0:0:1",
        ver: 1,
        enc: "rle64",
        bits: "AA==",
      })
    ).toThrow();
  });

  it("rejects invalid cellUp and cellUpBatch payloads", () => {
    expect(() =>
      parseServerMessage({
        t: "cellUp",
        tile: "0:0",
        i: 1.25,
        v: 1,
        ver: 2,
      })
    ).toThrow();

    expect(() =>
      parseServerMessage({
        t: "cellUp",
        tile: "0:0",
        i: 1,
        v: 2,
        ver: 2,
      })
    ).toThrow();

    expect(() =>
      parseServerMessage({
        t: "cellUpBatch",
        tile: "0:0",
        fromVer: 9,
        toVer: 8,
        ops: [[1, 1]],
      })
    ).toThrow();

    expect(() =>
      parseServerMessage({
        t: "cellUpBatch",
        tile: "0:0",
        fromVer: 1,
        toVer: 2,
        ops: [[1, 2]],
      })
    ).toThrow();
  });

  it("rejects invalid cursor and err payloads", () => {
    expect(() =>
      parseServerMessage({
        t: "curUp",
        uid: "u_a",
        name: "Alice",
        x: WORLD_MAX + 1,
        y: 0,
      })
    ).toThrow();

    expect(() => parseServerMessage({ t: "curUp", uid: "u_a", name: "Alice", x: 1 })).toThrow();
    expect(() => parseServerMessage({ t: "curUp", uid: "u_a", name: "Alice", x: Number.NEGATIVE_INFINITY, y: 0 })).toThrow();

    expect(() => parseServerMessage({ t: "err", code: "", msg: "m" })).toThrow();
    expect(() => parseServerMessage({ t: "err", code: "c", msg: "" })).toThrow();
  });
});
