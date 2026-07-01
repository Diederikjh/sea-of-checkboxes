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
  createRelayHarness,
  getCursorState,
  getCursorStateWithHeaders,
  parseStructuredLogs,
} from "./helpers/connectionShardWebsocketHarness";

describe("ConnectionShardDO websocket cursor state", () => {
  it("exposes local cursor state via cursor-state endpoint", async () => {
    const harness = createRelayHarness();
    const socket = await connectClient(harness.shard, harness.socketPairFactory, {
      uid: "u_a",
      name: "Alice",
      shard: "shard-0",
    });

    socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 5.5, y: 6.5 }));

    await waitFor(async () => {
      const state = await getCursorState(harness.shard);
      expect(state.from).toBe("shard-0");
      expect(
        state.updates.some(
          (update) => update.uid === "u_a" && update.name === "Alice" && update.x === 5.5 && update.y === 6.5
        )
      ).toBe(true);
    });
  });

  it("logs versioned cursor-state snapshot assembly details", async () => {
    const harness = createRelayHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const socket = await connectClient(harness.shard, harness.socketPairFactory, {
        uid: "u_a",
        name: "Alice",
        shard: "shard-0",
      });

      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 5.5, y: 6.5 }));
      socket.emitMessage(encodeClientMessageBinary({ t: "cur", x: 6.5, y: 7.5 }));

      const state = await getCursorStateWithHeaders(harness.shard, {
        "x-sea-cursor-pull": "1",
        "x-sea-cursor-trace-id": "trace-snapshot",
        "x-sea-cursor-trace-hop": "0",
        "x-sea-cursor-trace-origin": "shard-1",
      });

      expect(state.updates.some((update) => update.uid === "u_a" && update.seq === 2)).toBe(true);

      const events = parseStructuredLogs(logSpy);
      expect(
        events.some(
          (event) =>
            event.scope === "connection_shard_do"
            && event.event === "cursor_state_snapshot_served"
            && event.from_shard === "shard-0"
            && event.update_count === 1
            && event.max_seq === 2
            && Array.isArray(event.uid_sample)
            && event.uid_sample.includes("u_a")
            && event.trace_id === "trace-snapshot"
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

});
