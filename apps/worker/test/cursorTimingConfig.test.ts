import { describe, expect, it } from "vitest";

import { cursorPullBackoffProfileForPeerCount } from "../src/cursorTimingConfig";

describe("cursorPullBackoffProfileForPeerCount", () => {
  it("uses the tighter active backoff profile for a single remote peer", () => {
    expect(cursorPullBackoffProfileForPeerCount(0)).toEqual({
      intervalMaxMs: 125,
      intervalBackoffStepMs: 25,
    });
    expect(cursorPullBackoffProfileForPeerCount(1)).toEqual({
      intervalMaxMs: 125,
      intervalBackoffStepMs: 25,
    });
  });

  it("uses the broader active backoff profile for multi-peer cursor pulls", () => {
    expect(cursorPullBackoffProfileForPeerCount(2)).toEqual({
      intervalMaxMs: 225,
      intervalBackoffStepMs: 50,
    });
    expect(cursorPullBackoffProfileForPeerCount(4)).toEqual({
      intervalMaxMs: 225,
      intervalBackoffStepMs: 50,
    });
  });
});
