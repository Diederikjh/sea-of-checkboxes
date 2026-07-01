import { encodeClientMessageBinary } from "@sea/protocol";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  connectClient,
  createRelayHarness,
  getCursorStateWithHeaders,
  parseStructuredLogs,
  setCursorHubWatchResponse,
} from "./helpers/connectionShardWebsocketHarness";

describe("ConnectionShardDO websocket cursor visibility", () => {
  it("logs scope-unchanged refreshes and first peer visibility for the current scope epoch", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [
          {
            uid: "u_remote",
            name: "Remote",
            x: 1.5,
            y: 2.5,
            seenAt: 123,
            seq: 1,
            tileKey: "0:0",
          },
        ],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

      for (let index = 0; index < 5 && !harness.hasPendingAlarm(); index += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }

      await harness.fireAlarm();

      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_first_peer_visibility"
            && entry.shard === "shard-0"
            && entry.target_shard === "shard-1"
            && entry.update_count === 1
            && typeof entry.scope_observed_at_ms === "number"
            && typeof entry.scope_age_ms === "number"
        )
      ).toBe(true);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_scope_unchanged"
            && entry.shard === "shard-0"
            && entry.peer_count === 1
            && typeof entry.oldest_scope_age_ms === "number"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs pre-visibility empty snapshots before the first visible peer cursor arrives", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

      for (let index = 0; index < 5 && !harness.hasPendingAlarm(); index += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }

      await harness.fireAlarm();

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_pre_visibility_observation"
            && entry.shard === "shard-0"
            && entry.target_shard === "shard-1"
            && entry.outcome === "empty_snapshot"
            && entry.update_count === 0
            && entry.delta_observed === false
            && typeof entry.scope_observed_at_ms === "number"
            && typeof entry.scope_age_ms === "number"
        )
      ).toBe(true);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_first_peer_visibility"
            && entry.shard === "shard-0"
            && entry.target_shard === "shard-1"
        )
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("starts the first pull after peer scope becomes non-empty without extra cursor-state cooldown", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [
          {
            uid: "u_remote",
            name: "Remote",
            x: 1.5,
            y: 2.5,
            seenAt: 123,
            seq: 1,
            tileKey: "0:0",
          },
        ],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

      for (let index = 0; index < 5 && !harness.hasPendingAlarm(); index += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }

      await getCursorStateWithHeaders(harness.shard, {
        "x-sea-cursor-pull": "1",
        "x-sea-cursor-trace-id": "trace-bypass-first-post-scope",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      });

      await harness.fireAlarm();

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_first_post_scope_decision"
            && entry.shard === "shard-0"
            && entry.action === "started"
            && (entry.wake_reason === "watch_scope_change" || entry.wake_reason === "local_activity")
            && typeof entry.suppression_remaining_ms === "number"
            && entry.suppression_remaining_ms === 0
        )
      ).toBe(true);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_peer"
            && entry.shard === "shard-0"
            && (entry.wake_reason === "watch_scope_change" || entry.wake_reason === "local_activity")
            && entry.ok === true
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

});
