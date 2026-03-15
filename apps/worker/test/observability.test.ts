import { describe, expect, it, vi } from "vitest";

import {
  logStructuredEvent,
  shouldLogStructuredEvent,
} from "../src/observability";

describe("worker observability filtering", () => {
  it("suppresses routine connection shard success logs in reduced mode", () => {
    expect(
      shouldLogStructuredEvent(
        "connection_shard_do",
        "cursor_local_publish",
        { shard: "shard-1" },
        { mode: "reduced" }
      )
    ).toBe(false);

    expect(
      shouldLogStructuredEvent(
        "connection_shard_do",
        "setCell",
        {
          shard: "shard-1",
          accepted: true,
        },
        { mode: "reduced" }
      )
    ).toBe(false);
  });

  it("keeps anomalous and failed logs in reduced mode", () => {
    expect(
      shouldLogStructuredEvent(
        "connection_shard_do",
        "cursor_pull_alarm_failed",
        { shard: "shard-1", error: true },
        { mode: "reduced" }
      )
    ).toBe(true);

    expect(
      shouldLogStructuredEvent(
        "tile_owner_do",
        "setCell",
        {
          tile: "0:0",
          accepted: false,
          reason: "tile_readonly_hot",
        },
        { mode: "reduced" }
      )
    ).toBe(true);

    expect(
      shouldLogStructuredEvent(
        "connection_shard_do",
        "tile_batch_order_anomaly",
        { kind: "duplicate_or_replay" },
        { mode: "reduced" }
      )
    ).toBe(true);
  });

  it("suppresses persistence success logs but keeps persistence errors in reduced mode", () => {
    expect(
      shouldLogStructuredEvent(
        "tile_owner_persistence",
        "snapshot_write",
        { source: "r2" },
        { mode: "reduced" }
      )
    ).toBe(false);

    expect(
      shouldLogStructuredEvent(
        "tile_owner_persistence",
        "snapshot_write",
        {
          source: "r2",
          error: true,
          error_message: "boom",
        },
        { mode: "reduced" }
      )
    ).toBe(true);
  });

  it("does not emit console logs for suppressed reduced-mode events", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      logStructuredEvent(
        "cursor_hub_do",
        "publish",
        { subscriber_count: 3 },
        { mode: "reduced" }
      );
      expect(consoleSpy).not.toHaveBeenCalled();

      logStructuredEvent(
        "connection_shard_do",
        "cursor_pull_alarm_failed",
        {
          shard: "shard-1",
          error: true,
          error_message: "boom",
        },
        { mode: "reduced" }
      );
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
