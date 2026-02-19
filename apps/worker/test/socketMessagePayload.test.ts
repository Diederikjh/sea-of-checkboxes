import { describe, expect, it } from "vitest";

import {
  readBinaryMessageEventPayload,
  readMessageEventData,
  toBinaryPayload,
} from "../src/socketMessagePayload";

describe("socket message payload helpers", () => {
  it("converts binary payload inputs", () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const arr = new Uint8Array([4, 5, 6]).buffer;

    expect(toBinaryPayload(bytes)).toEqual(bytes);
    expect(toBinaryPayload(arr)).toEqual(new Uint8Array([4, 5, 6]));
    expect(toBinaryPayload("nope")).toBeNull();
  });

  it("reads event data defensively", () => {
    expect(readMessageEventData(null)).toBeNull();
    expect(readMessageEventData({})).toBeNull();
    expect(readMessageEventData({ data: "x" })).toBe("x");
    expect(readMessageEventData({ data: Uint8Array.from([7]) })).toEqual(Uint8Array.from([7]));
  });

  it("reads binary message payload from event shape", () => {
    const payload = readBinaryMessageEventPayload({ data: Uint8Array.from([9, 10]) });
    expect(payload).toEqual(Uint8Array.from([9, 10]));

    expect(readBinaryMessageEventPayload({ data: "text" })).toBeNull();
    expect(readBinaryMessageEventPayload({})).toBeNull();
  });
});
