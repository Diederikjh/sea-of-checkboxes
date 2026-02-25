import { describe, expect, it, vi } from "vitest";

import { CursorCoordinator } from "../src/cursorCoordinator";
import type { ConnectedClient } from "../src/connectionShardDOOperations";
import type { SocketLike } from "../src/socketPair";

const noopSocket: SocketLike = {
  accept() {},
  send() {},
  addEventListener() {},
};

function createClient(uid: string, name: string): ConnectedClient {
  return {
    uid,
    name,
    socket: noopSocket,
    subscribed: new Set(),
    cursorSubscriptions: new Set(),
    lastCursorX: null,
    lastCursorY: null,
  };
}

describe("CursorCoordinator", () => {
  it("relays local cursor updates using injected topology and transport", async () => {
    vi.useFakeTimers();
    try {
      const nowMs = 10_000;
      const localClient = createClient("u_local", "Local");
      const clients = new Map<string, ConnectedClient>([[localClient.uid, localClient]]);
      const deferred: Promise<unknown>[] = [];
      const sendServerMessage = vi.fn();
      const peerShardNames = vi.fn((currentShard: string) =>
        currentShard === "shard-5" ? ["shard-1", "shard-2"] : []
      );
      const relayCalls: Array<{ peerShards: string[]; body: string }> = [];
      const relayCursorBatch = async (peerShards: string[], body: string): Promise<void> => {
        relayCalls.push({ peerShards, body });
      };

      const coordinator = new CursorCoordinator({
        clients,
        getCurrentShardName: () => "shard-5",
        defer: (task) => {
          deferred.push(task());
        },
        clock: {
          nowMs: () => nowMs,
        },
        shardTopology: {
          peerShardNames,
        },
        cursorRelayTransport: {
          relayCursorBatch,
        },
        sendServerMessage,
      });

      coordinator.onLocalCursor(localClient, 1.5, 0.5);
      await vi.advanceTimersByTimeAsync(60);
      await Promise.allSettled(deferred);

      expect(peerShardNames).toHaveBeenCalledWith("shard-5");
      expect(relayCalls).toHaveLength(1);
      const firstRelayCall = relayCalls[0];
      expect(firstRelayCall).toBeDefined();
      const peers = firstRelayCall?.peerShards;
      const body = firstRelayCall?.body;
      expect(peers).toEqual(["shard-1", "shard-2"]);
      expect(typeof body).toBe("string");
      if (typeof body !== "string") {
        throw new Error("Expected serialized relay body");
      }

      const payload = JSON.parse(body) as {
        from: string;
        updates: Array<{
          uid: string;
          name: string;
          x: number;
          y: number;
          seenAt: number;
          seq: number;
          tileKey: string;
        }>;
      };
      expect(payload).toEqual({
        from: "shard-5",
        updates: [
          {
            uid: "u_local",
            name: "Local",
            x: 1.5,
            y: 0.5,
            seenAt: nowMs,
            seq: 1,
            tileKey: "0:0",
          },
        ],
      });

      expect(sendServerMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces local cursor bursts into a single relay batch per flush window", async () => {
    vi.useFakeTimers();
    try {
      let nowMs = 10_000;
      const localClient = createClient("u_local", "Local");
      const clients = new Map<string, ConnectedClient>([[localClient.uid, localClient]]);
      const deferred: Promise<unknown>[] = [];
      const relayCalls: Array<{ peerShards: string[]; body: string }> = [];

      const coordinator = new CursorCoordinator({
        clients,
        getCurrentShardName: () => "shard-5",
        defer: (task) => {
          deferred.push(task());
        },
        clock: {
          nowMs: () => nowMs,
        },
        shardTopology: {
          peerShardNames: () => ["shard-1", "shard-2"],
        },
        cursorRelayTransport: {
          relayCursorBatch: async (peerShards, body) => {
            relayCalls.push({ peerShards, body });
          },
        },
        sendServerMessage: vi.fn(),
      });

      coordinator.onLocalCursor(localClient, 1.0, 1.0);
      nowMs += 10;
      coordinator.onLocalCursor(localClient, 2.0, 2.0);
      nowMs += 10;
      coordinator.onLocalCursor(localClient, 3.0, 3.0);

      await vi.advanceTimersByTimeAsync(60);
      await Promise.allSettled(deferred);

      expect(relayCalls).toHaveLength(1);
      const payload = JSON.parse(relayCalls[0]!.body) as {
        from: string;
        updates: Array<{ uid: string; x: number; y: number; seq: number; seenAt: number }>;
      };
      expect(payload.from).toBe("shard-5");
      expect(payload.updates).toHaveLength(1);
      expect(payload.updates[0]).toMatchObject({
        uid: "u_local",
        x: 3.0,
        y: 3.0,
        seq: 3,
      });
      expect(payload.updates[0]?.seenAt).toBe(nowMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not relay non-self cursor batches", () => {
    const localClient = createClient("u_local", "Local");
    const clients = new Map<string, ConnectedClient>([[localClient.uid, localClient]]);
    let relayCalls = 0;
    const relayCursorBatch = async (): Promise<void> => {
      relayCalls += 1;
    };

    const coordinator = new CursorCoordinator({
      clients,
      getCurrentShardName: () => "shard-5",
      defer: () => {},
      clock: {
        nowMs: () => 10_000,
      },
      shardTopology: {
        peerShardNames: () => ["shard-1", "shard-2"],
      },
      cursorRelayTransport: {
        relayCursorBatch,
      },
      sendServerMessage: vi.fn(),
    });

    coordinator.onCursorBatch({
      from: "shard-1",
      updates: [
        {
          uid: "u_remote",
          name: "Remote",
          x: 1.5,
          y: 1.5,
          seenAt: 10_000,
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });

    expect(relayCalls).toBe(0);
  });

  it("ignores self-origin cursor batches", () => {
    let relayCalls = 0;
    const relayCursorBatch = async (): Promise<void> => {
      relayCalls += 1;
    };
    const sendServerMessage = vi.fn();
    const clients = new Map<string, ConnectedClient>([
      ["u_local", createClient("u_local", "Local")],
    ]);

    const coordinator = new CursorCoordinator({
      clients,
      getCurrentShardName: () => "shard-5",
      defer: () => {},
      clock: {
        nowMs: () => 10_000,
      },
      shardTopology: {
        peerShardNames: () => ["shard-1", "shard-2"],
      },
      cursorRelayTransport: {
        relayCursorBatch,
      },
      sendServerMessage,
    });

    coordinator.onCursorBatch({
      from: "shard-5",
      updates: [
        {
          uid: "u_remote_self",
          name: "RemoteSelf",
          x: 2.5,
          y: 2.5,
          seenAt: 10_000,
          seq: 1,
          tileKey: "0:0",
        },
      ],
    });

    expect(relayCalls).toBe(0);
    expect(sendServerMessage).not.toHaveBeenCalled();
  });

  it("suppresses local cursor relay when relay policy blocks during ingress", async () => {
    vi.useFakeTimers();
    try {
      const localClient = createClient("u_local", "Local");
      const clients = new Map<string, ConnectedClient>([[localClient.uid, localClient]]);
      const deferred: Promise<unknown>[] = [];
      const relayCalls: Array<{ peerShards: string[]; body: string }> = [];
      let suppressedCount = 0;

      const coordinator = new CursorCoordinator({
        clients,
        getCurrentShardName: () => "shard-5",
        defer: (task) => {
          deferred.push(task());
        },
        clock: {
          nowMs: () => 10_000,
        },
        shardTopology: {
          peerShardNames: () => ["shard-1", "shard-2"],
        },
        cursorRelayTransport: {
          relayCursorBatch: async (peerShards, body) => {
            relayCalls.push({ peerShards, body });
          },
        },
        canRelayNow: () => false,
        onRelaySuppressed: (dropped) => {
          suppressedCount += dropped;
        },
        sendServerMessage: vi.fn(),
      });

      coordinator.onLocalCursor(localClient, 1.25, 0.75);
      await vi.advanceTimersByTimeAsync(100);
      await Promise.allSettled(deferred);

      expect(relayCalls).toHaveLength(0);
      expect(suppressedCount).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses local cursor relay immediately after inbound cursor batches", async () => {
    vi.useFakeTimers();
    try {
      let nowMs = 10_000;
      const localClient = createClient("u_local", "Local");
      localClient.cursorSubscriptions = new Set(["u_remote"]);
      const clients = new Map<string, ConnectedClient>([[localClient.uid, localClient]]);
      const deferred: Promise<unknown>[] = [];
      let relayCalls = 0;
      let suppressedCount = 0;

      const coordinator = new CursorCoordinator({
        clients,
        getCurrentShardName: () => "shard-5",
        defer: (task) => {
          deferred.push(task());
        },
        clock: {
          nowMs: () => nowMs,
        },
        shardTopology: {
          peerShardNames: () => ["shard-1", "shard-2"],
        },
        cursorRelayTransport: {
          relayCursorBatch: async () => {
            relayCalls += 1;
          },
        },
        onRelaySuppressed: (dropped) => {
          suppressedCount += dropped;
        },
        sendServerMessage: vi.fn(),
      });

      coordinator.onCursorBatch({
        from: "shard-1",
        updates: [
          {
            uid: "u_remote",
            name: "Remote",
            x: 1.5,
            y: 1.5,
            seenAt: nowMs,
            seq: 1,
            tileKey: "0:0",
          },
        ],
      });

      coordinator.onLocalCursor(localClient, 2.5, 2.5);
      await vi.advanceTimersByTimeAsync(60);
      await Promise.allSettled(deferred);

      expect(relayCalls).toBe(0);
      expect(suppressedCount).toBeGreaterThanOrEqual(1);

      nowMs += 400;
      coordinator.onLocalCursor(localClient, 3.5, 3.5);
      await vi.advanceTimersByTimeAsync(60);
      await Promise.allSettled(deferred);
      expect(relayCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
