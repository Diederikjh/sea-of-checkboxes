import type { ServerMessage } from "@sea/protocol";
import { describe, expect, it } from "vitest";

import {
  ConnectionShardTileBatchOrderTracker,
} from "../src/connectionShardTileBatchOrder";

function batch(
  tile: string,
  fromVer: number,
  toVer: number,
  ops: Array<[number, 0 | 1]>
): Extract<ServerMessage, { t: "cellUpBatch" }> {
  return {
    t: "cellUpBatch",
    tile,
    fromVer,
    toVer,
    ops,
  };
}

describe("ConnectionShardTileBatchOrderTracker", () => {
  it("does not report anomalies for monotonic version updates", () => {
    const tracker = new ConnectionShardTileBatchOrderTracker();
    expect(tracker.record(batch("0:0", 10, 10, [[1, 1]]))).toBeNull();
    expect(tracker.record(batch("0:0", 11, 11, [[2, 1]]))).toBeNull();
  });

  it("reports duplicate_or_replay when toVer is repeated", () => {
    const tracker = new ConnectionShardTileBatchOrderTracker();
    expect(tracker.record(batch("0:0", 920, 920, [[1562, 1]]))).toBeNull();

    const anomaly = tracker.record(batch("0:0", 920, 920, [[1498, 1]]));
    expect(anomaly).toMatchObject({
      tile: "0:0",
      kind: "duplicate_or_replay",
      prev_to_ver: 920,
      incoming_to_ver: 920,
    });
  });

  it("reports version_regression when toVer moves backward", () => {
    const tracker = new ConnectionShardTileBatchOrderTracker();
    expect(tracker.record(batch("0:0", 921, 921, [[1626, 1]]))).toBeNull();

    const anomaly = tracker.record(batch("0:0", 920, 920, [[1498, 1]]));
    expect(anomaly).toMatchObject({
      tile: "0:0",
      kind: "version_regression",
      prev_to_ver: 921,
      incoming_to_ver: 920,
    });
  });

  it("reports gap_or_jump when fromVer is not previous toVer + 1", () => {
    const tracker = new ConnectionShardTileBatchOrderTracker();
    expect(tracker.record(batch("0:0", 100, 100, [[1, 1]]))).toBeNull();

    const anomaly = tracker.record(batch("0:0", 103, 103, [[2, 1]]));
    expect(anomaly).toMatchObject({
      tile: "0:0",
      kind: "gap_or_jump",
      prev_to_ver: 100,
      incoming_from_ver: 103,
    });
  });

  it("truncates prev and incoming ops previews to 4 entries", () => {
    const tracker = new ConnectionShardTileBatchOrderTracker();
    expect(
      tracker.record(
        batch("0:0", 200, 200, [
          [1, 1],
          [2, 1],
          [3, 1],
          [4, 1],
          [5, 1],
        ])
      )
    ).toBeNull();

    const anomaly = tracker.record(
      batch("0:0", 200, 200, [
        [6, 1],
        [7, 1],
        [8, 1],
        [9, 1],
        [10, 1],
      ])
    );

    expect(anomaly?.prev_ops_preview).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ]);
    expect(anomaly?.incoming_ops_preview).toEqual([
      [6, 1],
      [7, 1],
      [8, 1],
      [9, 1],
    ]);
  });

  it("evicts oldest tile state when the tracker limit is exceeded", () => {
    const tracker = new ConnectionShardTileBatchOrderTracker({ limit: 1 });
    expect(tracker.record(batch("0:0", 1, 1, [[1, 1]]))).toBeNull();
    expect(tracker.record(batch("1:0", 1, 1, [[2, 1]]))).toBeNull();

    // No anomaly because tile 0:0 state has been evicted at limit=1.
    expect(tracker.record(batch("0:0", 1, 1, [[3, 1]]))).toBeNull();
  });
});
