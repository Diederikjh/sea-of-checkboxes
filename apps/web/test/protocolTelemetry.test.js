import { describe, expect, it } from "vitest";

import { describePayload, summarizeMessage } from "../src/protocolTelemetry";

describe("protocolTelemetry", () => {
  it("describes payload bytes, tag, and head hex", () => {
    const payload = new Uint8Array([0x31, 0xab, 0x00, 0xff]);

    expect(describePayload(payload)).toEqual({
      bytes: 4,
      size: "4 B",
      tag: 0x31,
      headHex: "31 ab 00 ff",
    });
  });

  it("summarizes setCell with derived board coordinates for valid tile/index", () => {
    const summary = summarizeMessage({
      t: "setCell",
      cid: "c_123",
      tile: "2:3",
      i: 65,
      v: 1,
      op: "op_123",
    });

    expect(summary).toMatchObject({
      t: "setCell",
      cid: "c_123",
      tile: "2:3",
      i: 65,
      v: 1,
      op: "op_123",
      worldX: 129,
      worldY: 193,
      boardX: 129.5,
      boardY: 193.5,
    });
  });

  it("summarizes setCell without board coordinates when tile key is invalid", () => {
    const summary = summarizeMessage({
      t: "setCell",
      cid: "c_bad",
      tile: "bad_tile",
      i: 0,
      v: 1,
      op: "op_bad",
    });

    expect(summary).toEqual({
      t: "setCell",
      cid: "c_bad",
      tile: "bad_tile",
      i: 0,
      v: 1,
      op: "op_bad",
    });
  });

  it("summarizes cellUpBatch with op count and preview", () => {
    const summary = summarizeMessage({
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 5,
      toVer: 6,
      ops: [[1, 1], [2, 0], [3, 1], [4, 1], [5, 0]],
    });

    expect(summary).toEqual({
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 5,
      toVer: 6,
      ops: 5,
      opsPreview: [[1, 1], [2, 0], [3, 1], [4, 1]],
    });
  });

  it("summarizes curUp with rounded coordinates", () => {
    const summary = summarizeMessage({
      t: "curUp",
      uid: "u_1",
      name: "BlueOtter001",
      ver: 7,
      x: 1.234,
      y: 9.876,
    });

    expect(summary).toEqual({
      uid: "u_1",
      name: "BlueOtter001",
      ver: 7,
      t: "curUp",
      x: 1.23,
      y: 9.88,
      boardX: 1.23,
      boardY: 9.88,
    });
  });

  it("summarizes subscription messages with client ids", () => {
    expect(summarizeMessage({
      t: "sub",
      cid: "c_sub",
      tiles: ["0:0", "1:0"],
    })).toEqual({
      t: "sub",
      cid: "c_sub",
      tiles: 2,
    });

    expect(summarizeMessage({
      t: "resyncTile",
      cid: "c_resync",
      tile: "0:0",
      haveVer: 12,
    })).toEqual({
      t: "resyncTile",
      cid: "c_resync",
      tile: "0:0",
      haveVer: 12,
    });
  });

  it("summarizes subAck details for subscription rebuild tracing", () => {
    expect(summarizeMessage({
      t: "subAck",
      cid: "c_ack",
      requestedCount: 8,
      changedCount: 3,
      subscribedCount: 10,
    })).toEqual({
      t: "subAck",
      cid: "c_ack",
      requestedCount: 8,
      changedCount: 3,
      subscribedCount: 10,
    });
  });
});
