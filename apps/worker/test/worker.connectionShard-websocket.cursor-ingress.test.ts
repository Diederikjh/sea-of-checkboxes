import { MAX_REMOTE_CURSORS } from "@sea/domain";
import {
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  type ServerMessage,
} from "@sea/protocol";
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
  createHarness,
  createRelayHarness,
  decodeMessages,
  drainDeferred,
  parseStructuredLogs,
  postCursorBatch,
  postCursorBatchWithHeaders,
  postTileBatch,
  setCursorHubWatchResponse,
  toUint8Array,
} from "./helpers/connectionShardWebsocketHarness";

describe("ConnectionShardDO websocket cursor ingress", () => {
  it("ingests cursor batches and forwards only to clients with cursor subscriptions", async () => {
    const harness = createHarness();
    const socketA = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });
    const socketB = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_b",
      name: "Bob",
      shard: "shard-a",
    });

    socketA.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socketA.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

    const response = await postCursorBatch(harness.shard, {
      from: "shard-1",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 1.5,
          y: 1.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });

    expect(response.status).toBe(204);

    await waitFor(() => {
      const messagesA = decodeMessages(socketA);
      expect(messagesA.some((message) => message.t === "curUp" && message.uid === "u_remote" && message.ver === 1)).toBe(true);
    });

    const messagesB = decodeMessages(socketB);
    expect(messagesB.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(false);
  });

  it("logs first local cursor publish with connection age", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-a",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_first_local_publish"
            && entry.shard === "shard-a"
            && entry.uid === "u_a"
            && entry.seq === 1
            && entry.tile === "0:0"
            && typeof entry.connection_age_ms === "number"
            && entry.connection_age_ms >= 0
            && entry.subscribed_count === 1
        )
      ).toBe(true);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "cursor_local_publish"
            && entry.shard === "shard-a"
            && entry.uid === "u_a"
            && entry.seq === 1
            && typeof entry.connection_age_ms === "number"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("drops re-entrant cursor-batch requests while ingress is active", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      let releaseFirstBody!: () => void;
      const holdFirstBody = new Promise<void>((resolve) => {
        releaseFirstBody = () => resolve();
      });
      const encoder = new TextEncoder();
      const firstBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"from":"shard-1","updates":'));
          void holdFirstBody.then(() => {
            controller.enqueue(encoder.encode("[]}"));
            controller.close();
          });
        },
      });
      const firstRequestInit: RequestInit & { duplex?: "half" } = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sea-cursor-hub": "1",
        },
        body: firstBody,
        duplex: "half",
      };

      const firstResponsePromise = harness.shard.fetch(
        new Request("https://connection-shard.internal/cursor-batch", firstRequestInit)
      );

      let firstSettled = false;
      void firstResponsePromise.then(() => {
        firstSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(firstSettled).toBe(false);

      const nestedResponse = await postCursorBatch(harness.shard, {
        from: "shard-2",
        updates: [],
      });
      expect(nestedResponse.status).toBe(204);

      releaseFirstBody();
      const firstResponse = await firstResponsePromise;
      expect(firstResponse.status).toBe(204);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_batch_reentrant_drop"
            && event.path === "/cursor-batch"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("drops traced cursor-batch loops once hop depth exceeds the safe limit", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await postCursorBatchWithHeaders(
        harness.shard,
        {
          from: "shard-1",
          updates: [],
        },
        {
          "x-sea-cursor-hub": "1",
          "x-sea-cursor-trace-id": "trace-loop",
          "x-sea-cursor-trace-hop": "2",
          "x-sea-cursor-trace-origin": "shard-origin",
        }
      );

      expect(response.status).toBe(204);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_batch_loop_guard_drop"
            && event.trace_id === "trace-loop"
            && event.trace_hop === 2
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("drops duplicate traced cursor-batch deliveries on the same shard", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const requestBody = {
        from: "shard-1",
        updates: [
          {
            uid: "u_remote",
            name: "Remote",
            x: 1.5,
            y: 1.5,
            seenAt: Date.now(),
            seq: 1,
            tileKey: "0:0",
          },
        ],
      };
      const headers = {
        "x-sea-cursor-hub": "1",
        "x-sea-cursor-trace-id": "trace-dup",
        "x-sea-cursor-trace-hop": "1",
        "x-sea-cursor-trace-origin": "shard-origin",
      };

      const firstResponse = await postCursorBatchWithHeaders(harness.shard, requestBody, headers);
      const secondResponse = await postCursorBatchWithHeaders(harness.shard, requestBody, headers);

      expect(firstResponse.status).toBe(204);
      expect(secondResponse.status).toBe(204);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_batch_duplicate_trace_drop"
            && event.trace_id === "trace-dup"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not relay inbound cursor batches to peer shards", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const beforeRelayCount = countCursorRelaySubrequests(harness);

    const response = await postCursorBatch(harness.shard, {
      from: "shard-1",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 1.5,
          y: 1.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });

    expect(response.status).toBe(204);

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
    }, { attempts: 80, delayMs: 5 });

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const afterRelayCount = countCursorRelaySubrequests(harness);
    expect(afterRelayCount).toBe(beforeRelayCount);
  });

  it("logs remote cursor ingest decisions with previous and next versions", async () => {
    const harness = createRelayHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

      await waitFor(() => {
        const messages = decodeMessages(socket);
        expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
      });

      const headers = {
        "x-sea-cursor-trace-id": "trace-ingest",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      };
      const staleHeaders = {
        "x-sea-cursor-trace-id": "trace-ingest-stale",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      };

      await postCursorBatchWithHeaders(
        harness.shard,
        {
          from: "shard-1",
          updates: [
            {
              uid: "u_remote",
              name: "Remote",
              x: 1.5,
              y: 1.5,
              seenAt: Date.now(),
              seq: 1,
              tileKey: "0:0",
            },
          ],
        },
        staleHeaders
      );
      await postCursorBatchWithHeaders(
        harness.shard,
        {
          from: "shard-1",
          updates: [
            {
              uid: "u_remote",
              name: "Remote",
              x: 1.0,
              y: 1.0,
              seenAt: Date.now() - 1,
              seq: 1,
              tileKey: "0:0",
            },
          ],
        },
        headers
      );

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_remote_ingest"
            && event.from_shard === "shard-1"
            && event.uid === "u_remote"
            && event.previous_seq === undefined
            && event.next_seq === 1
            && event.applied === true
            && event.trace_id === "trace-ingest-stale"
        )
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_remote_ingest"
            && event.from_shard === "shard-1"
            && event.uid === "u_remote"
            && event.previous_seq === 1
            && event.next_seq === 1
            && event.fanout_count === 0
            && event.applied === false
            && event.ignored_reason === "stale"
            && event.trace_id === "trace-ingest"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("suppresses local cursor relay re-entry while processing inbound cursor batches", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const beforeRelayCount = countCursorRelaySubrequests(harness);

    const response = await postCursorBatch(harness.shard, {
      from: "shard-1",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 1.5,
          y: 1.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
    expect(response.status).toBe(204);

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote")).toBe(true);
    }, { attempts: 80, delayMs: 5 });

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const afterRelayCount = countCursorRelaySubrequests(harness);
    expect(afterRelayCount).toBe(beforeRelayCount);
  });

  it("does not publish local cursors to the hub during inbound cursor-batch handling and wakes cursor pull", async () => {
    const harness = createRelayHarness();
    setCursorHubWatchResponse(harness, {
      peerShards: ["shard-1"],
    });
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
      from: "shard-1",
      updates: [],
    });

    const response = await postCursorBatch(harness.shard, {
      from: "shard-1",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 1.5,
          y: 1.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
    expect(response.status).toBe(204);
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 1.5 }));

    await waitFor(() => {
      expect(countCursorHubPublishes(harness)).toBe(0);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(0);
    }, { attempts: 120, delayMs: 10 });
  });

  it("does not publish local cursors to the hub after inbound tile-batch handling and wakes cursor pull", async () => {
    const harness = createRelayHarness();
    setCursorHubWatchResponse(harness, {
      peerShards: ["shard-1"],
    });
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    harness.connectionShards.getByName("shard-1").setJsonPathResponse("/cursor-state", {
      from: "shard-1",
      updates: [],
    });

    const originalSend = socket.send.bind(socket);
    let reflectedCursor = false;
    socket.send = (payload) => {
      originalSend(payload);
      if (reflectedCursor || typeof payload === "string") {
        return;
      }

      const message = decodeServerMessageBinary(toUint8Array(payload));
      if (message.t !== "cellUpBatch" || message.tile !== "0:0") {
        return;
      }

      reflectedCursor = true;
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 1.5 }));
    };

    const response = await postTileBatch(harness.shard, {
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 1,
      toVer: 1,
      ops: [[10, 1]],
    });
    expect(response.status).toBe(204);

    await new Promise((resolve) => setTimeout(resolve, 80));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 2.5 }));

    await waitFor(() => {
      expect(countCursorHubPublishes(harness)).toBe(0);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(0);
    }, { attempts: 80, delayMs: 5 });
  });

  it("rejects malformed cursor-batch payloads", async () => {
    const harness = createHarness();
    const badBodies = [
      {},
      { from: "", updates: [] },
      { from: "shard-1", updates: {} },
      {
        from: "shard-1",
        updates: [{ uid: "u_a", name: "A", x: 1, y: 1, seenAt: Date.now(), seq: 0, tileKey: "0:0" }],
      },
      {
        from: "shard-1",
        updates: [{ uid: "u_a", name: "A", x: 1, y: 1, seenAt: Date.now(), seq: 1, tileKey: "bad" }],
      },
    ];

    for (const body of badBodies) {
      const response = await postCursorBatch(harness.shard, body);
      expect(response.status).toBe(400);
    }
  });

  it("ignores self-origin cursor batches without forwarding", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));
    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const beforeRelayCount = countCursorRelaySubrequests(harness);

    const response = await postCursorBatch(harness.shard, {
      from: "shard-0",
      updates: [
        {
          uid: "u_remote_self",
          name: "RemoteSelf",
          x: 2.5,
          y: 2.5,
          seenAt: Date.now(),
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });
    expect(response.status).toBe(204);

    const messages = decodeMessages(socket);
    expect(messages.some((message) => message.t === "curUp" && message.uid === "u_remote_self")).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 70));
    await drainDeferred(harness);
    const afterRelayCount = countCursorRelaySubrequests(harness);
    expect(afterRelayCount).toBe(beforeRelayCount);
  });

  it("limits remote cursor subscription to nearest MAX_REMOTE_CURSORS", async () => {
    const harness = createHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_view",
      name: "Viewer",
      shard: "shard-a",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));

    const updates = Array.from({ length: MAX_REMOTE_CURSORS + 2 }, (_, index) => ({
      uid: `u_remote_${index}`,
      name: `Remote${index}`,
      x: 1 + index,
      y: 0.5,
      seenAt: Date.now(),
      seq: 1,
      tileKey: "0:0",
    }));

    const response = await postCursorBatch(harness.shard, {
      from: "shard-1",
      updates,
    });
    expect(response.status).toBe(204);

    await waitFor(() => {
      const messages = decodeMessages(socket);
      const remoteUids = new Set(
        messages
          .filter((message): message is Extract<ServerMessage, { t: "curUp" }> => message.t === "curUp")
          .filter((message) => message.uid.startsWith("u_remote_"))
          .map((message) => message.uid)
      );

      expect(remoteUids.size).toBe(MAX_REMOTE_CURSORS);
      expect(remoteUids.has("u_remote_0")).toBe(true);
      expect(remoteUids.has(`u_remote_${MAX_REMOTE_CURSORS + 1}`)).toBe(false);
    });
  });

  it("forwards local cursor updates via DO runtime path", async () => {
    const harness = createHarness();
    const socketA = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });
    const socketB = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_b",
      name: "Bob",
      shard: "shard-a",
    });

    socketA.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socketB.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    socketB.emitMessage(encodeClientMessageBinary({ t: "cur", x: 0.5, y: 0.5 }));
    socketA.emitMessage(encodeClientMessageBinary({ t: "cur", x: 1.5, y: 0.5 }));

    await waitFor(() => {
      const messagesB = decodeMessages(socketB);
      expect(messagesB.some((message) => message.t === "curUp" && message.uid === "u_a" && message.ver === 1)).toBe(true);
    });
  });

  it("does not publish local cursors to the hub after an inbound traced cursor batch", async () => {
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

    const response = await postCursorBatchWithHeaders(
      harness.shard,
      {
        from: "shard-1",
        updates: [
          {
            uid: "u_remote",
            name: "Remote",
            x: 1.5,
            y: 1.5,
            seenAt: Date.now(),
            seq: 1,
            tileKey: "0:0",
          },
        ],
      },
      {
        "x-sea-cursor-hub": "1",
        "x-sea-cursor-trace-id": "trace-prop",
        "x-sea-cursor-trace-hop": "1",
        "x-sea-cursor-trace-origin": "shard-origin",
      }
    );
    expect(response.status).toBe(204);
    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 2.5, y: 2.5 }));

    await waitFor(() => {
      expect(countCursorHubPublishes(harness)).toBe(0);
      expect(countCursorStatePullRequests(harness)).toBeGreaterThan(0);
    }, { attempts: 120, delayMs: 10 });
  });

  it("does not generate timer-driven cursor relay from inbound batches", async () => {
    vi.useFakeTimers();
    try {
      const harness = createRelayHarness();
      const response = await postCursorBatch(harness.shard, {
        from: "shard-1",
        updates: [
          {
            uid: "u_remote_timer",
            name: "RemoteTimer",
            x: 3.5,
            y: 3.5,
            seenAt: Date.now(),
            seq: 1,
            tileKey: "0:0",
          },
        ],
      });
      expect(response.status).toBe(204);

      await vi.advanceTimersByTimeAsync(60_000);
      await drainDeferred(harness);
      expect(countCursorRelaySubrequests(harness)).toBe(0);
      expect(countCursorHubPublishes(harness)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribes and unsubscribes shard watch with cursor hub as clients connect/disconnect", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    await waitFor(() => {
      const hub = harness.cursorHub.getByName("global");
      const subWatch = hub.requests.some((entry) => {
        const url = new URL(entry.request.url);
        return entry.request.method === "POST" && url.pathname === "/watch" && entry.body.includes('"action":"sub"');
      });
      expect(subWatch).toBe(true);
    });

    socket.emitClose();

    await waitFor(() => {
      const hub = harness.cursorHub.getByName("global");
      const unsubWatch = hub.requests.some((entry) => {
        const url = new URL(entry.request.url);
        return entry.request.method === "POST" && url.pathname === "/watch" && entry.body.includes('"action":"unsub"');
      });
      expect(unsubWatch).toBe(true);
    });
  });

  it("unsubscribes watcher on socket close when last subscriber disconnects", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    serverSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.some((request) => request.action === "sub")).toBe(true);
    });

    serverSocket.emitClose();

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.some((request) => request.action === "unsub")).toBe(true);
    });
  });
});
