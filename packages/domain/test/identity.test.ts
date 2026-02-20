import { describe, expect, it } from "vitest";

import {
  isValidIdentity,
  normalizeIdentity,
} from "../src";

describe("identity validation", () => {
  it("normalizes and validates persisted identity", () => {
    expect(normalizeIdentity({ uid: " u_saved123 ", name: " BriskOtter481 " })).toEqual({
      uid: "u_saved123",
      name: "BriskOtter481",
    });
  });

  it("rejects malformed identity payloads", () => {
    expect(normalizeIdentity({ uid: "saved123", name: "BriskOtter481" })).toBeNull();
    expect(normalizeIdentity({ uid: "u_saved123", name: "bad name" })).toBeNull();
    expect(normalizeIdentity(null)).toBeNull();
  });

  it("exposes validity helper", () => {
    expect(isValidIdentity({ uid: "u_saved123", name: "BriskOtter481" })).toBe(true);
    expect(isValidIdentity({ uid: "u_saved123", name: "bad name" })).toBe(false);
  });
});
