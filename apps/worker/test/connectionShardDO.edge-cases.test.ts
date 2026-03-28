import { encodeClientMessageBinary } from "@sea/protocol";
import { describe, expect, it, vi } from "vitest";

import { waitFor } from "./helpers/waitFor";
import {
  connectClient,
  createHarness,
  decodeMessages,
  parseStructuredLogs,
  postTileBatch,
} from "./helpers/connectionShardWebsocketHarness";

describe("ConnectionShardDO edge cases", () => {
  it("returns 426 for non-websocket /ws requests", async () => {
    const harness = createHarness();

    const response = await harness.shard.fetch(
      new Request("https://connection-shard.internal/ws?uid=u_a&name=Alice&token=test-token&shard=shard-a")
    );

    expect(response.status).toBe(426);
  });

  it("returns 400 when required websocket connect params are missing", async () => {
    const harness = createHarness();

    const response = await harness.shard.fetch(
      new Request("https://connection-shard.internal/ws?uid=u_a&token=test-token&shard=shard-a", {
        headers: {
          upgrade: "websocket",
        },
      })
    );

    expect(response.status).toBe(400);
  });

  it("rejects non-binary and malformed binary websocket payloads", async () => {
    const harness = createHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-a",
    });

    socket.emitMessage("not-binary");
    socket.emitMessage(new Uint8Array([255]));

    await waitFor(() => {
      const messages = decodeMessages(socket);
      expect(messages.filter((message) => message.t === "err" && message.code === "bad_message").length).toBe(2);
    });
  });

  it("returns 400 for invalid tile-batch payloads", async () => {
    const harness = createHarness();

    const response = await postTileBatch(harness.shard, { t: "nope" } as never);

    expect(response.status).toBe(400);
  });

  it("logs socket_error close cleanup and unsubscribes the last watcher", async () => {
    const harness = createHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-a",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "sub", tiles: ["0:0"] }));

      await waitFor(() => {
        const tileStub = harness.tileOwners.getByName("0:0");
        expect(tileStub.watchRequests.length).toBe(1);
      });

      socket.emitError();

      await waitFor(() => {
        const tileStub = harness.tileOwners.getByName("0:0");
        expect(tileStub.watchRequests.length).toBe(2);
      });

      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests[1]).toEqual({
        tile: "0:0",
        shard: "shard-a",
        action: "unsub",
      });

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (entry) =>
            entry.scope === "connection_shard_do"
            && entry.event === "ws_close"
            && entry.uid === "u_a"
            && entry.code === "socket_error"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
