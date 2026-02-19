import { TILE_CELL_COUNT } from "@sea/domain";
import { encodeRle64 } from "@sea/protocol";
import { describe, expect, it, vi } from "vitest";

import { createServerMessageHandler } from "../src/serverMessages";

function createHarness() {
  const identityEl = { textContent: "" };
  const statuses = [];

  const tileStore = {
    setSnapshot: vi.fn(),
    applySingle: vi.fn(),
    applyBatch: vi.fn(),
  };

  const heatStore = {
    ensureTile: vi.fn(),
    bump: vi.fn(),
  };

  const transport = {
    send: vi.fn(),
  };

  const cursors = new Map();
  const selfIdentity = { uid: null };
  const onVisualStateChanged = vi.fn();

  const handler = createServerMessageHandler({
    identityEl,
    setStatus: (value) => statuses.push(value),
    tileStore,
    heatStore,
    transport,
    cursors,
    selfIdentity,
    onVisualStateChanged,
  });

  return {
    handler,
    identityEl,
    statuses,
    tileStore,
    heatStore,
    transport,
    cursors,
    selfIdentity,
    onVisualStateChanged,
  };
}

describe("server message handling", () => {
  it("handles hello by setting identity and self uid", () => {
    const harness = createHarness();

    harness.handler({ t: "hello", uid: "u_self", name: "Alice" });

    expect(harness.selfIdentity.uid).toBe("u_self");
    expect(harness.identityEl.textContent).toContain("u_self");
    expect(harness.onVisualStateChanged).toHaveBeenCalledTimes(1);
  });

  it("handles tileSnap and decodes bits", () => {
    const harness = createHarness();
    const bits = new Uint8Array(TILE_CELL_COUNT);
    bits[7] = 1;

    harness.handler({
      t: "tileSnap",
      tile: "0:0",
      ver: 4,
      enc: "rle64",
      bits: encodeRle64(bits),
    });

    expect(harness.tileStore.setSnapshot).toHaveBeenCalledTimes(1);
    const [tile, decodedBits, ver] = harness.tileStore.setSnapshot.mock.calls[0];
    expect(tile).toBe("0:0");
    expect(ver).toBe(4);
    expect(decodedBits[7]).toBe(1);
    expect(decodedBits.length).toBe(TILE_CELL_COUNT);
    expect(harness.heatStore.ensureTile).toHaveBeenCalledWith("0:0");
  });

  it("resyncs on cellUp/cellUpBatch version gap", () => {
    const harness = createHarness();
    harness.tileStore.applySingle.mockReturnValue({ gap: true, haveVer: 8 });
    harness.tileStore.applyBatch.mockReturnValue({ gap: true, haveVer: 11 });

    harness.handler({ t: "cellUp", tile: "0:0", i: 1, v: 1, ver: 12 });
    harness.handler({
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 13,
      toVer: 14,
      ops: [[1, 1]],
    });

    expect(harness.transport.send).toHaveBeenNthCalledWith(1, {
      t: "resyncTile",
      tile: "0:0",
      haveVer: 8,
    });
    expect(harness.transport.send).toHaveBeenNthCalledWith(2, {
      t: "resyncTile",
      tile: "0:0",
      haveVer: 11,
    });
  });

  it("bumps heat for non-gap updates", () => {
    const harness = createHarness();
    harness.tileStore.applySingle.mockReturnValue({ gap: false, haveVer: 3 });
    harness.tileStore.applyBatch.mockReturnValue({ gap: false, haveVer: 5 });

    harness.handler({ t: "cellUp", tile: "0:0", i: 2, v: 1, ver: 3 });
    harness.handler({
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 4,
      toVer: 5,
      ops: [[7, 1], [9, 0]],
    });

    expect(harness.heatStore.bump).toHaveBeenCalledWith("0:0", 2, expect.any(Number));
    expect(harness.heatStore.bump).toHaveBeenCalledWith("0:0", 7, expect.any(Number));
    expect(harness.heatStore.bump).toHaveBeenCalledWith("0:0", 9, expect.any(Number));
  });

  it("ignores self cursor and tracks remote cursor", () => {
    const harness = createHarness();
    harness.selfIdentity.uid = "u_self";

    harness.handler({ t: "curUp", uid: "u_self", name: "Me", x: 1, y: 2 });
    expect(harness.cursors.size).toBe(0);
    expect(harness.onVisualStateChanged).not.toHaveBeenCalled();

    harness.handler({ t: "curUp", uid: "u_other", name: "Other", x: 10, y: 20 });
    const first = harness.cursors.get("u_other");
    expect(first).toBeDefined();
    expect(first.drawX).toBe(10);
    expect(first.drawY).toBe(20);
    expect(harness.onVisualStateChanged).not.toHaveBeenCalled();

    harness.handler({ t: "curUp", uid: "u_other", name: "Other2", x: 14, y: 25 });
    const second = harness.cursors.get("u_other");
    expect(second.name).toBe("Other2");
    expect(second.x).toBe(14);
    expect(second.y).toBe(25);
    expect(second.drawX).toBe(10);
    expect(second.drawY).toBe(20);
  });

  it("forwards server errors to status", () => {
    const harness = createHarness();

    harness.handler({ t: "err", code: "bad_tile", msg: "Invalid tile" });

    expect(harness.statuses.at(-1)).toBe("Error: Invalid tile");
  });
});
