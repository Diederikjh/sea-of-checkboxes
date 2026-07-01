import { encodeClientMessageBinary } from "@sea/protocol";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ConnectionShardCursorPullOrchestrator } from "../src/connectionShardCursorPullOrchestrator";
import { ConnectionShardCursorPullScheduler } from "../src/connectionShardCursorPullScheduler";
import {
  connectClient,
  countCursorStatePullRequests,
  createRelayHarness,
  getCursorStateWithHeaders,
  parseStructuredLogs,
  setCursorHubWatchResponse,
} from "./helpers/connectionShardWebsocketHarness";

describe("ConnectionShardDO websocket cursor alarms", () => {
  it("arms a detached alarm before issuing the initial cursor-state pull", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(harness.hasPendingAlarm()).toBe(true);
      expect(countCursorStatePullRequests(harness)).toBe(0);

      await harness.fireAlarm();
      expect(countCursorStatePullRequests(harness)).toBe(1);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs post-ingress reverse pull from a detached alarm instead of directly from the wake callback", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
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

      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(0);
      expect(harness.hasPendingAlarm()).toBe(true);

      await harness.fireAlarm();
      const baseline = countCursorStatePullRequests(harness);
      expect(baseline).toBe(1);

      await getCursorStateWithHeaders(harness.shard, {
        "x-sea-cursor-pull": "1",
        "x-sea-cursor-trace-id": "trace-inbound",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 1.5 }));
      await vi.advanceTimersByTimeAsync(299);
      expect(countCursorStatePullRequests(harness)).toBe(baseline);

      await vi.advanceTimersByTimeAsync(1);
      expect(countCursorStatePullRequests(harness)).toBe(baseline);
      expect(harness.hasPendingAlarm()).toBe(true);

      await harness.fireAlarm();
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(baseline);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs stale detached cursor-pull alarms without throwing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });

      await expect(harness.shard.alarm()).resolves.toBeUndefined();

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_alarm_stale"
            && entry.alarm_armed === false
            && entry.in_flight === false
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs structured context when a detached cursor-pull alarm run throws", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const markRunStartedSpy = vi
      .spyOn(ConnectionShardCursorPullScheduler.prototype, "markRunStarted")
      .mockImplementation(() => {
        throw new Error("alarm exploded");
      });
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(harness.hasPendingAlarm()).toBe(true);
      await expect(harness.fireAlarm()).rejects.toThrow("alarm exploded");

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_alarm_failed"
            && entry.failure_stage === "run_tick"
            && entry.error_name === "Error"
            && entry.error_message === "alarm exploded"
            && typeof entry.error_stack === "string"
            && typeof entry.scheduled_at_ms === "number"
            && entry.in_flight === true
        )
      ).toBe(true);
    } finally {
      markRunStartedSpy.mockRestore();
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs primitive detached alarm failures before runTick begins", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consumeAlarmWakeSpy = vi
      .spyOn(ConnectionShardCursorPullOrchestrator.prototype, "consumeAlarmWake")
      .mockImplementation(() => {
        throw "2026-03-14T21:34:37.497Z";
      });
    try {
      const harness = createRelayHarness({ alarmMode: "manual" });
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(harness.hasPendingAlarm()).toBe(true);

      await expect(harness.fireAlarm()).rejects.toBe("2026-03-14T21:34:37.497Z");

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_alarm_failed"
            && entry.failure_stage === "consume_wake"
            && entry.error_type === "string"
            && entry.error_message === "2026-03-14T21:34:37.497Z"
            && entry.error_datetime_like === true
            && entry.pre_alarm_armed === true
            && entry.pre_pending_wake_reason === "watch_scope_change"
            && typeof entry.pre_scheduled_at_ms === "number"
        )
      ).toBe(true);
    } finally {
      consumeAlarmWakeSpy.mockRestore();
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs watch-scope wake scheduling and alarm execution decisions", async () => {
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

      const eventsBeforeAlarm = parseStructuredLogs(logSpy);
      expect(
        eventsBeforeAlarm.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_scope"
            && entry.shard === "shard-0"
            && entry.previous_peer_count === 0
            && entry.peer_count === 1
        )
      ).toBe(true);
      expect(
        eventsBeforeAlarm.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_watch_scope_wake"
            && entry.shard === "shard-0"
            && entry.action === "scheduled_new"
            && entry.wake_reason === "watch_scope_change"
        )
      ).toBe(true);
      expect(harness.hasPendingAlarm()).toBe(true);

      await harness.fireAlarm();
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

});
