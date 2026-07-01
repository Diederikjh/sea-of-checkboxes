import {
  MIN_CELL_PX,
  WORLD_MAX,
} from "@sea/domain";
import { describe, expect, it } from "vitest";

import {
  SHARE_LINK_MAX_ZOOM,
  SHARE_LINK_URL_PARAM,
  clampShareLinkZoom,
  normalizeShareLinkCameraPayload,
  normalizeShareLinkId,
} from "../src";

describe("share link contracts", () => {
  it("normalizes UUID share ids", () => {
    expect(SHARE_LINK_URL_PARAM).toBe("share");
    expect(normalizeShareLinkId(" F7D8A15E-14F6-4B3B-8D4A-FF8E51D4E425 ")).toBe(
      "f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425"
    );
  });

  it("rejects malformed share ids", () => {
    expect(normalizeShareLinkId("not-a-guid")).toBeNull();
    expect(normalizeShareLinkId("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(normalizeShareLinkId(null)).toBeNull();
  });

  it("clamps share camera payloads consistently", () => {
    expect(
      normalizeShareLinkCameraPayload({
        x: WORLD_MAX + 100,
        y: -WORLD_MAX - 100,
        zoom: SHARE_LINK_MAX_ZOOM + 10,
      })
    ).toEqual({
      x: WORLD_MAX,
      y: -WORLD_MAX,
      zoom: SHARE_LINK_MAX_ZOOM,
    });

    expect(clampShareLinkZoom(1)).toBe(MIN_CELL_PX);
  });

  it("rejects non-finite share camera payloads", () => {
    expect(normalizeShareLinkCameraPayload({ x: "1", y: 2, zoom: 3 })).toBeNull();
    expect(normalizeShareLinkCameraPayload({ x: 1, y: Number.NaN, zoom: 3 })).toBeNull();
    expect(normalizeShareLinkCameraPayload({ x: 1, y: 2, zoom: Number.POSITIVE_INFINITY })).toBeNull();
  });
});
