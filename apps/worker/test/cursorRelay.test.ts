import { describe, expect, it } from "vitest";

import {
  isValidCursorPresence,
  isValidCursorRelayBatch,
} from "../src/cursorRelay";

function validPresence() {
  return {
    uid: "u_a",
    name: "Alice",
    x: 1.5,
    y: -2.5,
    seenAt: Date.now(),
    seq: 1,
    tileKey: "0:0",
  };
}

describe("cursor relay validation", () => {
  it("accepts valid cursor presence payload", () => {
    expect(isValidCursorPresence(validPresence())).toBe(true);
  });

  it("rejects invalid cursor presence payload", () => {
    expect(isValidCursorPresence({ ...validPresence(), seq: 0 })).toBe(false);
    expect(isValidCursorPresence({ ...validPresence(), tileKey: "bad" })).toBe(false);
    expect(isValidCursorPresence({ ...validPresence(), uid: "" })).toBe(false);
  });

  it("accepts and rejects relay batches correctly", () => {
    expect(
      isValidCursorRelayBatch({
        from: "shard-1",
        updates: [validPresence()],
      })
    ).toBe(true);

    expect(isValidCursorRelayBatch({ from: "", updates: [validPresence()] })).toBe(false);
    expect(
      isValidCursorRelayBatch({
        from: "shard-1",
        updates: [{ ...validPresence(), seq: -1 }],
      })
    ).toBe(false);
    expect(isValidCursorRelayBatch({ from: "shard-1", updates: {} })).toBe(false);
  });
});
