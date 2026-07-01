import { encodeClientMessageBinary } from "@sea/protocol";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { waitFor } from "./helpers/waitFor";
import {
  connectClient,
  countCursorHubPublishes,
  countCursorRelaySubrequests,
  countCursorStatePullRequests,
  countCursorStatePullRequestsForShard,
  createRelayHarness,
  decodeMessages,
  parseStructuredLogs,
  setCursorHubWatchResponse,
} from "./helpers/connectionShardWebsocketHarness";

describe("ConnectionShardDO websocket cursor peers", () => {
  it("pulls peer cursor-state when the hub is configured and never publishes local cursors to the hub", async () => {
    const harness = createRelayHarness();
    setCursorHubWatchResponse(harness, {
      peerShards: ["shard-1"],
    });
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
      from: "shard-1",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 9.5,
          y: 1.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 0.5 }));

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(0);
      expect(countCursorStatePullRequestsForShard(harness, "shard-1")).toBeGreaterThan(0);
      expect(countCursorStatePullRequestsForShard(harness, "shard-2")).toBe(0);
      expect(countCursorHubPublishes(harness)).toBe(0);
    }, { attempts: 80, delayMs: 5 });

    const hub = harness.cursorHub.getByName("global");
    const watchRequest = hub.requests.find((entry) => {
      const url = new URL(entry.request.url);
      return entry.request.method === "POST" && url.pathname === "/watch";
    });
    expect(watchRequest).toBeDefined();
    expect(countCursorRelaySubrequests(harness)).toBe(0);
  });

  it("polls only watched peers returned by the hub watch flow", async () => {
    const harness = createRelayHarness();
    setCursorHubWatchResponse(harness, {
      peerShards: ["shard-2"],
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 4.5,
          y: 5.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
    harness.connectionShards.getByName("shard-2").setJsonPathResponse("/cursor-state", {
      from: "shard-2",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 4.5,
          y: 5.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
    harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
      from: "shard-1",
      updates: [
        {
          uid: "u_irrelevant",
          name: "Irrelevant",
          x: 8.5,
          y: 8.5,
          seenAt: Date.now(),
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
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 0.5 }));

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
      expect(messages.some((message) => message.t === "curUp" && message.uid === "u_irrelevant")).toBe(false);
      expect(countCursorStatePullRequestsForShard(harness, "shard-2")).toBeGreaterThan(0);
    }, { attempts: 80, delayMs: 5 });

    expect(countCursorStatePullRequestsForShard(harness, "shard-1")).toBe(0);
    expect(countCursorStatePullRequestsForShard(harness, "shard-3")).toBe(0);
  });

  it("caps in-flight cursor-state pulls instead of starting every peer at once", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1", "shard-2", "shard-3", "shard-4"],
      });
      for (const shardName of ["shard-1", "shard-2", "shard-3", "shard-4"]) {
        harness.connectionShards.getByName(shardName).setNeverResolvePath("/cursor-state", true);
      }

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
      expect(countCursorStatePullRequestsForShard(harness, "shard-4")).toBe(0);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds jitter to timer-driven cursor-state pulls", async () => {
    vi.useFakeTimers();
    try {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);
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
      expect(countCursorStatePullRequests(harness)).toBe(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(countCursorStatePullRequests(harness)).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(countCursorStatePullRequests(harness)).toBe(2);
      randomSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cursor-state pull failures best-effort and does not emit client errors", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createRelayHarness();
      setCursorHubWatchResponse(harness, {
        peerShards: ["shard-1", "shard-2"],
      });
      harness.connectionShards.getByName("shard-1").setPathStatus("/cursor-state", 500);
      harness.connectionShards.getByName("shard-2").setJsonPathResponse("/cursor-state", {
        from: "shard-2",
        updates: [
          {
            uid: "u_remote",
            name: "Remote",
            x: 3.5,
            y: 2.5,
            seenAt: Date.now(),
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
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 0.5 }));

      await waitFor(() => {
        const messages = decodeMessages(socket);
        expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
      }, { attempts: 80, delayMs: 5 });

      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "err" && message.code === "internal")).toBe(false);

      await waitFor(() => {
        const events = parseStructuredLogs(logSpy);
        expect(
          events.some(
            (entry) =>
              entry.scope === "connection_shard_do"
              && entry.event === "cursor_pull_peer"
              && entry.target_shard === "shard-1"
              && entry.ok === false
          )
        ).toBe(true);
      }, { attempts: 80, delayMs: 5 });

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "server_error_sent"
            && entry.uid === "u_a"
            && entry.code === "internal"
        )
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

});
