import {
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
  createHarness,
  decodeMessages,
  parseStructuredLogs,
} from "./helpers/connectionShardWebsocketHarness";

describe("ConnectionShardDO websocket sessions", () => {
  it("sends hello on connect via injected socket pair", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    const messages = decodeMessages(serverSocket);
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      t: "hello",
      uid: "u_a",
      name: "Alice",
      token: "test-token",
    });
    expect(harness.upgradeResponseFactory.clientSockets.length).toBe(1);
  });

  it("includes spawn in hello when cursor hub returns a spawn sample", async () => {
    const harness = createHarness();
    const hub = harness.cursorHub.getByName("global");
    hub.setJsonPathResponse("/spawn-sample", {
      x: 320.5,
      y: -160.5,
      source: "edit",
    });

    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_spawn",
      name: "Spawned",
      shard: "shard-a",
    });

    const messages = decodeMessages(serverSocket);
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      t: "hello",
      uid: "u_spawn",
      name: "Spawned",
      token: "test-token",
      spawn: {
        x: 320.5,
        y: -160.5,
      },
    });
  });

  it("subscribes tiles, registers watch, and returns snapshots", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    serverSocket.emitMessage(encodeClientMessageBinary({ t: "sub", cid: "c_sub_1", tiles: ["0:0"] }));

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    expect(tileStub.watchRequests[0]).toEqual({
      tile: "0:0",
      shard: "shard-a",
      action: "sub",
    });

    const messages = decodeMessages(serverSocket);
    expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    expect(messages).toContainEqual({
      t: "subAck",
      cid: "c_sub_1",
      requestedCount: 1,
      changedCount: 1,
      subscribedCount: 1,
    });
  });

  it("does not send subAck for legacy subscribe messages without a cid", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_legacy",
      name: "Legacy",
      shard: "shard-a",
    });

    serverSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    const messages = decodeMessages(serverSocket);
    expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    expect(messages.some((message) => message.t === "subAck")).toBe(false);
  });

  it("rejects setCell for unsubscribed tiles and sends snapshot", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    serverSocket.emitMessage(
      encodeClientMessageBinary({
        t: "setCell",
        tile: "0:0",
        i: 22,
        v: 1,
        op: "op_1",
      })
    );

    await waitFor(() => {
      const messages = decodeMessages(serverSocket);
      expect(messages.some((message) => message.t === "err" && message.code === "not_subscribed")).toBe(true);
      expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    expect(tileStub.setCellRequests.length).toBe(0);
  });

  it("rejects setCell with app_readonly when read-only mode is enabled", async () => {
    const harness = createHarness({
      envOverrides: {
        READONLY_MODE: "1",
      },
    });
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    serverSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    serverSocket.emitMessage(
      encodeClientMessageBinary({
        t: "setCell",
        tile: "0:0",
        i: 22,
        v: 1,
        op: "op_readonly",
      })
    );

    await waitFor(() => {
      const messages = decodeMessages(serverSocket);
      expect(messages.some((message) => message.t === "err" && message.code === "app_readonly")).toBe(true);
    });

    const tileStub = harness.tileOwners.getByName("0:0");
    expect(tileStub.setCellRequests.length).toBe(0);
  });

  it("publishes accepted edit activity to cursor hub for spawn sampling", async () => {
    const harness = createHarness();
    const serverSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    serverSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    serverSocket.emitMessage(
      encodeClientMessageBinary({
        t: "setCell",
        tile: "0:0",
        i: 65,
        v: 1,
        op: "op_spawn_activity",
      })
    );

    await waitFor(() => {
      const hub = harness.cursorHub.getByName("global");
      expect(
        hub.requests.some(
          (entry) =>
            entry.request.method.toUpperCase() === "POST"
            && new URL(entry.request.url).pathname === "/activity"
        )
      ).toBe(true);
    });

    const hub = harness.cursorHub.getByName("global");
    const activityRequest = hub.requests.find((entry) => new URL(entry.request.url).pathname === "/activity");
    expect(activityRequest).toBeDefined();
    expect(activityRequest?.request.method.toUpperCase()).toBe("POST");
    const body = activityRequest?.body ? (JSON.parse(activityRequest.body) as Record<string, unknown>) : {};
    expect(body).toMatchObject({
      from: "shard-a",
      x: 1.5,
      y: 1.5,
    });
    expect(typeof body.atMs).toBe("number");
  });

  it("replaces an existing uid connection without letting stale socket events evict the new client", async () => {
    const harness = createHarness();
    const firstSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_same",
      name: "Alice",
      shard: "shard-a",
    });
    const secondSocket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_same",
      name: "Alice",
      shard: "shard-a",
    });

    firstSocket.emitClose();
    secondSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    const secondMessages = decodeMessages(secondSocket);
    expect(secondMessages.some((message) => message.t === "hello" && message.uid === "u_same")).toBe(true);
  });

  it("logs setcell_not_subscribed diagnostics when a reconnect sends setCell before re-subscribe", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const firstSocket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_reconnect",
        name: "Alice",
        shard: "shard-a",
      });

      firstSocket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));
      await waitFor(() => {
        const tileStub = harness.tileOwners.getByName("0:0");
        expect(tileStub.watchRequests.length).toBe(1);
      });

      firstSocket.emitClose();

      const secondSocket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_reconnect",
        name: "Alice",
        shard: "shard-a",
      });
      secondSocket.emitMessage(
        encodeClientMessageBinary({
          t: "setCell",
          cid: "c_set_before_resub",
          tile: "0:0",
          i: 7,
          v: 1,
          op: "op_before_resub",
        })
      );

      await waitFor(() => {
        const messages = decodeMessages(secondSocket);
        expect(messages.some((message) => message.t === "err" && message.code === "not_subscribed")).toBe(true);
      });

      const events = parseStructuredLogs(logSpy);
      const event = events.find(
        (entry) =>
          entry.scope === "connection_shard_do"
          && entry.event === "setcell_not_subscribed"
          && entry.uid === "u_reconnect"
          && entry.tile === "0:0"
      );

      expect(event).toBeDefined();
      expect(event).toMatchObject({
        cid: "c_set_before_resub",
        i: 7,
        v: 1,
        op: "op_before_resub",
        subscribed_count: 0,
        clients_connected: 1,
      });
      expect(Array.isArray(event?.subscribed_tiles_sample)).toBe(true);
      expect((event?.subscribed_tiles_sample as unknown[]).length).toBe(0);
      expect(typeof event?.connection_age_ms).toBe("number");
      expect((event?.connection_age_ms as number)).toBeGreaterThanOrEqual(0);
      expect((event?.connection_age_ms as number)).toBeLessThan(10_000);

      const errEvent = events.find(
        (entry) =>
          entry.scope === "connection_shard_do"
          && entry.event === "server_error_sent"
          && entry.uid === "u_reconnect"
          && entry.code === "not_subscribed"
      );

      expect(errEvent).toMatchObject({
        cid: "c_set_before_resub",
        msg: "Tile 0:0 is not currently subscribed",
        tile: "0:0",
        i: 7,
        v: 1,
        op: "op_before_resub",
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("includes fallback trace ids on internal websocket errors without an active cursor trace", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const harness = createHarness();
      harness.tileOwners.getByName("0:0").setPathError("/watch", new Error("watch exploded"));
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-a",
      });

      socket.emitMessage(encodeClientMessageBinary({
        t: "sub",
        cid: "c_sub_trace",
        tiles: ["0:0"],
      }));

      let errorMessage: Extract<ServerMessage, { t: "err" }> | undefined;
      await waitFor(() => {
        errorMessage = decodeMessages(socket).find(
          (message): message is Extract<ServerMessage, { t: "err" }> =>
            message.t === "err" && message.code === "internal"
        );
        expect(errorMessage?.trace).toEqual(expect.any(String));
      });

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "internal_error"
            && entry.uid === "u_a"
            && entry.trace_id === errorMessage?.trace
        )
      ).toBe(true);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "server_error_sent"
            && entry.uid === "u_a"
            && entry.code === "internal"
            && entry.trace_id === errorMessage?.trace
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

});
