import { encodeClientMessageBinary } from "@sea/protocol";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  connectClient,
  countCursorStatePullRequests,
  countCursorStatePullRequestsForShard,
  createRelayHarness,
  getCursorStateWithHeaders,
  parseStructuredLogs,
  setCursorHubWatchResponse,
} from "./helpers/connectionShardWebsocketHarness";

describe("ConnectionShardDO websocket cursor polling", () => {
  it("backs off cursor-state polling after repeated quiet polls", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1", "shard-2"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });
      harness.connectionShards.getByName("shard-2").setJsonPathResponse("/cursor-state", {
        from: "shard-2",
        updates: [],
      });

      await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(2);
      expect(countCursorStatePullRequestsForShard(harness, "shard-1")).toBe(1);
      expect(countCursorStatePullRequestsForShard(harness, "shard-2")).toBe(1);
      expect(countCursorStatePullRequestsForShard(harness, "shard-3")).toBe(0);

      await vi.advanceTimersByTimeAsync(450);
      expect(countCursorStatePullRequests(harness)).toBe(14);

      await vi.advanceTimersByTimeAsync(74);
      expect(countCursorStatePullRequests(harness)).toBe(14);

      await vi.advanceTimersByTimeAsync(1);
      expect(countCursorStatePullRequests(harness)).toBe(16);

      await vi.advanceTimersByTimeAsync(149);
      expect(countCursorStatePullRequests(harness)).toBe(18);

      await vi.advanceTimersByTimeAsync(1);
      expect(countCursorStatePullRequests(harness)).toBe(18);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a tighter quiet-poll cadence when only one remote peer is connected", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const singlePeerHarness = createRelayHarness();
      setCursorHubWatchResponse(singlePeerHarness, {
        peerShards: ["shard-1"],
      });
      singlePeerHarness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });

      const multiPeerHarness = createRelayHarness();
      setCursorHubWatchResponse(multiPeerHarness, {
        peerShards: ["shard-1", "shard-2"],
      });
      multiPeerHarness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });
      multiPeerHarness.connectionShards.getByName("shard-2").setJsonPathResponse("/cursor-state", {
        from: "shard-2",
        updates: [],
      });

      await connectClient(singlePeerHarness.shard, singlePeerHarness.socketPairFactory, {
        uid: "u_single",
        name: "Single",
        shard: "shard-0",
      });
      await connectClient(multiPeerHarness.shard, multiPeerHarness.socketPairFactory, {
        uid: "u_multi",
        name: "Multi",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(countCursorStatePullRequestsForShard(singlePeerHarness, "shard-1")).toBe(12);
      expect(countCursorStatePullRequestsForShard(multiPeerHarness, "shard-1")).toBe(10);
      expect(countCursorStatePullRequestsForShard(multiPeerHarness, "shard-2")).toBe(10);
      expect(countCursorStatePullRequestsForShard(singlePeerHarness, "shard-1")).toBeGreaterThan(
        countCursorStatePullRequestsForShard(multiPeerHarness, "shard-1")
      );
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes cursor-state polling back up when local cursor activity resumes", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1", "shard-2"],
      });
      harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
        from: "shard-1",
        updates: [],
      });
      harness.connectionShards.getByName("shard-2").setJsonPathResponse("/cursor-state", {
        from: "shard-2",
        updates: [],
      });

      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(2);

      await vi.advanceTimersByTimeAsync(150 + 225 + 225 + 225 + 225 + 225);
      expect(countCursorStatePullRequests(harness)).toBe(24);

      await vi.advanceTimersByTimeAsync(224);
      expect(countCursorStatePullRequests(harness)).toBe(24);

      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 1.5 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(26);

      await vi.advanceTimersByTimeAsync(74);
      expect(countCursorStatePullRequests(harness)).toBe(26);

      await vi.advanceTimersByTimeAsync(150);
      expect(countCursorStatePullRequests(harness)).toBe(28);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces repeated local cursor activity into one prompt cursor-state reheat", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
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
      expect(countCursorStatePullRequests(harness)).toBe(1);

      await vi.advanceTimersByTimeAsync(150 + 225 + 225 + 225 + 225 + 225);
      const beforeReheat = countCursorStatePullRequests(harness);

      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 1.5 }));
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.75, y: 1.75 }));
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 3.0, y: 2.0 }));

      await vi.advanceTimersByTimeAsync(0);
      expect(countCursorStatePullRequests(harness)).toBe(beforeReheat + 1);

      await vi.advanceTimersByTimeAsync(149);
      expect(countCursorStatePullRequests(harness)).toBe(beforeReheat + 2);

      await vi.advanceTimersByTimeAsync(1);
      expect(countCursorStatePullRequests(harness)).toBe(beforeReheat + 2);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows timer-driven cursor pulls to resume immediately after inbound cursor-state pull ingress", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
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
      const baseline = countCursorStatePullRequests(harness);
      expect(baseline).toBe(1);

      await getCursorStateWithHeaders(harness.shard, {
        "x-sea-cursor-pull": "1",
        "x-sea-cursor-trace-id": "trace-inbound",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(baseline);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes local-activity pulls immediately after inbound cursor-state pull ingress completes", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
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
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(0);
      const baseline = countCursorStatePullRequests(harness);
      expect(baseline).toBe(1);

      await getCursorStateWithHeaders(harness.shard, {
        "x-sea-cursor-pull": "1",
        "x-sea-cursor-trace-id": "trace-inbound",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 1.5 }));
      await vi.advanceTimersByTimeAsync(100);
      expect(
        parseStructuredLogs(logSpy).some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_local_activity_wake"
            && entry.wake_reason === "local_activity"
            && typeof entry.suppression_remaining_ms === "number"
            && entry.suppression_remaining_ms === 0
        )
      ).toBe(true);
      expect(
        parseStructuredLogs(logSpy).some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_pull_peer"
            && (entry.wake_reason === "local_activity" || entry.wake_reason === "timer")
        )
      ).toBe(true);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(baseline);
      randomSpy.mockRestore();
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

});
