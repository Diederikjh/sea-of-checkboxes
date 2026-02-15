import { describe, expect, it } from "vitest";

import {
  parseClientMessage,
  parseServerMessage,
  setCellMessageSchema,
  tileSnapshotSchema,
} from "../src";

describe("message schemas", () => {
  it("parses valid setCell message", () => {
    const value = setCellMessageSchema.parse({
      t: "setCell",
      tile: "12:44",
      i: 1337,
      v: 1,
      op: "abc",
    });

    expect(value.v).toBe(1);
  });

  it("rejects invalid tile keys", () => {
    expect(() =>
      parseClientMessage({ t: "sub", tiles: ["12:44:55"] })
    ).toThrow();
  });

  it("parses tile snapshot", () => {
    const parsed = tileSnapshotSchema.parse({
      t: "tileSnap",
      tile: "0:0",
      ver: 1,
      enc: "rle64",
      bits: "AA==",
    });

    expect(parsed.enc).toBe("rle64");
  });

  it("rejects invalid server payload", () => {
    expect(() => parseServerMessage({ t: "curUp", uid: "x", name: "y", x: 1 })).toThrow();
  });
});
