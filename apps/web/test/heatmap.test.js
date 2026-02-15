import { describe, expect, it } from "vitest";

import { HeatStore } from "../src/heatmap";

describe("HeatStore", () => {
  it("bumps heat and eventually applies cooldown", () => {
    const store = new HeatStore();
    const now = Date.now();

    for (let index = 0; index < 8; index += 1) {
      store.bump("0:0", 12, now);
    }

    expect(store.getHeat("0:0", 12)).toBeGreaterThan(0.8);
    expect(store.isLocallyDisabled("0:0", 12, now + 50)).toBe(true);
  });

  it("decays heat over time", () => {
    const store = new HeatStore();
    const now = Date.now();
    store.bump("0:0", 0, now);
    const before = store.getHeat("0:0", 0);

    store.decay(5);

    expect(store.getHeat("0:0", 0)).toBeLessThan(before);
  });
});
