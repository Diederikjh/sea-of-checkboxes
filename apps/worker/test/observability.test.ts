import { describe, expect, it, vi } from "vitest";

import {
  logStructuredEvent,
  resolveStructuredLogPolicy,
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

  it("samples routine session logs deterministically in sampled mode", () => {
    expect(
      shouldLogStructuredEvent(
        "connection_shard_do",
        "ws_connect",
        {
          shard: "shard-1",
          client_session_id: "sampled-session",
        },
        {
          mode: "sampled",
          sampleRate: "1",
          nowMs: 1_000,
        }
      )
    ).toBe(true);

    expect(
      shouldLogStructuredEvent(
        "connection_shard_do",
        "ws_connect",
        {
          shard: "shard-1",
          client_session_id: "unsampled-session",
        },
        {
          mode: "sampled",
          sampleRate: "0",
          nowMs: 1_000,
        }
      )
    ).toBe(false);
  });

  it("honors forced reduced and forced verbose session policies", () => {
    expect(
      resolveStructuredLogPolicy(
        "connection_shard_do",
        "ws_connect",
        {
          shard: "shard-1",
          client_session_id: "session-a",
        },
        {
          mode: "sampled",
          sampleRate: "0",
          forceReducedSessionIds: "session-a",
          nowMs: 1_000,
        }
      )
    ).toBe("forced_reduced");

    expect(
      resolveStructuredLogPolicy(
        "connection_shard_do",
        "ws_connect",
        {
          shard: "shard-1",
          client_session_id: "session-b",
          client_debug_log_level: "verbose",
          client_debug_log_expires_at_ms: 2_000,
        },
        {
          mode: "sampled",
          sampleRate: "0",
          allowClientVerbose: "1",
          nowMs: 1_000,
        }
      )
    ).toBe("forced_verbose");
  });

  it("keeps backend no-session logs on reduced behavior in sampled mode", () => {
    expect(
      resolveStructuredLogPolicy(
        "tile_owner_persistence",
        "snapshot_write",
        {
          source: "r2",
          error: true,
        },
        {
          mode: "sampled",
          sampleRate: "0",
          nowMs: 1_000,
        }
      )
    ).toBe("always_error");

    expect(
      resolveStructuredLogPolicy(
        "worker",
        "healthcheck",
        {},
        {
          mode: "sampled",
          sampleRate: "0",
          nowMs: 1_000,
        }
      )
    ).toBe("backend_reduced_no_session");
  });

  it("logs override expiry events regardless of sampling", () => {
    expect(
      resolveStructuredLogPolicy(
        "connection_shard_do",
        "log_override_expired",
        {
          client_session_id: "session-expired",
        },
        {
          mode: "sampled",
          sampleRate: "0",
          nowMs: 1_000,
        }
      )
    ).toBe("override_expired");
  });
});
