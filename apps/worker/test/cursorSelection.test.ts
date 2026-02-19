import { describe, expect, it } from "vitest";

import {
  selectCursorSubscriptions,
  type CursorSelectionState,
} from "../src/cursorSelection";

describe("cursor selection", () => {
  it("selects the closest cursors first", () => {
    const nowMs = 10_000;
    const client = {
      uid: "u_viewer",
      subscribed: new Set(["0:0"]),
      lastCursorX: 0.5,
      lastCursorY: 0.5,
    };

    const cursorByUid = new Map<string, CursorSelectionState>();
    const cursorTileIndex = new Map<string, Set<string>>();

    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const uid = `u_${index}`;
      ids.push(uid);
      cursorByUid.set(uid, {
        uid,
        x: index,
        y: 0.5,
        seenAt: nowMs,
        tileKey: "0:0",
      });
    }
    cursorTileIndex.set("0:0", new Set(ids));

    const selected = selectCursorSubscriptions({
      client,
      cursorByUid,
      cursorTileIndex,
      nowMs,
      cursorTtlMs: 5_000,
      nearestLimit: 10,
    });

    expect(selected).toEqual(ids.slice(0, 10));
  });

  it("falls back to global active cursors when subscribed tiles are empty", () => {
    const nowMs = 10_000;
    const client = {
      uid: "u_viewer",
      subscribed: new Set(["999:999"]),
      lastCursorX: 0.5,
      lastCursorY: 0.5,
    };

    const cursorByUid = new Map<string, CursorSelectionState>([
      ["u_near", { uid: "u_near", x: 1, y: 1, seenAt: nowMs, tileKey: "0:0" }],
      ["u_far", { uid: "u_far", x: 100, y: 100, seenAt: nowMs, tileKey: "1:1" }],
    ]);
    const cursorTileIndex = new Map<string, Set<string>>();

    const selected = selectCursorSubscriptions({
      client,
      cursorByUid,
      cursorTileIndex,
      nowMs,
      cursorTtlMs: 5_000,
      nearestLimit: 10,
    });

    expect(selected).toEqual(["u_near", "u_far"]);
  });
});
