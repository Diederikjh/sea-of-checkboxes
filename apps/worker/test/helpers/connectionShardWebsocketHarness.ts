import {
  decodeServerMessageBinary,
  type ServerMessage,
} from "@sea/protocol";
import { expect } from "vitest";

import { ConnectionShardDO } from "../../src/worker";
import type { CursorRelayBatch } from "../../src/cursorRelay";
import {
  MockSocket,
  MockSocketPairFactory,
  MockUpgradeResponseFactory,
} from "./socketMocks";
import {
  StubNamespace,
  RecordingDurableObjectStub,
  TileOwnerDurableObjectStub,
} from "./doStubs";
import { NullStorage } from "./storageMocks";

export type StructuredLogSpy = {
  mock: {
    calls: unknown[][];
  };
};

export function decodeMessages(socket: MockSocket): ServerMessage[] {
  const messages: ServerMessage[] = [];

  for (const payload of socket.sentPayloads) {
    if (typeof payload === "string") {
      continue;
    }
    messages.push(decodeServerMessageBinary(toUint8Array(payload)));
  }

  return messages;
}

export function toUint8Array(payload: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

export function parseStructuredLogs(logSpy: StructuredLogSpy) {
  return logSpy.mock.calls
    .flatMap((call) => {
      const payload = call[0];
      if (typeof payload !== "string") {
        return [];
      }
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        return [parsed];
      } catch {
        return [];
      }
    });
}

export function createHarness() {
  const socketPairFactory = new MockSocketPairFactory();
  const upgradeResponseFactory = new MockUpgradeResponseFactory(200);
  const tileOwners = new StubNamespace((name) => new TileOwnerDurableObjectStub(name));
  const cursorHub = new StubNamespace((name) => new RecordingDurableObjectStub(name));

  const env = {
    CONNECTION_SHARD: tileOwners,
    TILE_OWNER: tileOwners,
    CURSOR_HUB: cursorHub,
  };

  const state = {
    id: { toString: () => "shard:test" },
    storage: new NullStorage(),
  };

  const shard = new ConnectionShardDO(state, env, {
    socketPairFactory,
    upgradeResponseFactory,
  });

  return {
    shard,
    socketPairFactory,
    upgradeResponseFactory,
    tileOwners,
    cursorHub,
  };
}

export function createRelayHarness() {
  const socketPairFactory = new MockSocketPairFactory();
  const upgradeResponseFactory = new MockUpgradeResponseFactory(200);
  const connectionShards = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  const tileOwners = new StubNamespace((name) => new TileOwnerDurableObjectStub(name));
  const cursorHub = new StubNamespace((name) => new RecordingDurableObjectStub(name));

  const env = {
    CONNECTION_SHARD: connectionShards,
    TILE_OWNER: tileOwners,
    CURSOR_HUB: cursorHub,
  };

  const state = {
    id: { toString: () => "shard:test" },
    storage: new NullStorage(),
  };

  const shard = new ConnectionShardDO(state, env, {
    socketPairFactory,
    upgradeResponseFactory,
  });

  return {
    shard,
    socketPairFactory,
    connectionShards,
    cursorHub,
  };
}

export type RelayHarness = ReturnType<typeof createRelayHarness>;
export type BasicHarness = ReturnType<typeof createHarness>;
export type ConnectionShardRequestHarness = {
  connectionShards: StubNamespace<RecordingDurableObjectStub>;
};

function countConnectionShardSubrequests(
  harness: ConnectionShardRequestHarness,
  options: { path: string; method?: string }
): number {
  let total = 0;
  const method = options.method?.toUpperCase();
  for (const stub of harness.connectionShards.stubs.values()) {
    total += stub.requests.filter((entry) => {
      const url = new URL(entry.request.url);
      if (url.pathname !== options.path) {
        return false;
      }
      if (!method) {
        return true;
      }
      return entry.request.method.toUpperCase() === method;
    }).length;
  }
  return total;
}

export function countCursorRelaySubrequests(harness: RelayHarness): number {
  return countConnectionShardSubrequests(harness, {
    path: "/cursor-batch",
    method: "POST",
  });
}

export function countCursorStatePullRequests(harness: ConnectionShardRequestHarness): number {
  return countConnectionShardSubrequests(harness, {
    path: "/cursor-state",
    method: "GET",
  });
}

export function countCursorStatePullRequestsForShard(
  harness: ConnectionShardRequestHarness,
  shardName: string
): number {
  const stub = harness.connectionShards.stubs.get(shardName);
  if (!stub) {
    return 0;
  }
  return stub.requests.filter((entry) => {
    const url = new URL(entry.request.url);
    return entry.request.method.toUpperCase() === "GET" && url.pathname === "/cursor-state";
  }).length;
}

function countCursorHubRequests(
  harness: RelayHarness,
  options: { path: string; method?: string }
): number {
  let total = 0;
  const method = options.method?.toUpperCase();
  for (const stub of harness.cursorHub.stubs.values()) {
    total += stub.requests.filter((entry) => {
      const url = new URL(entry.request.url);
      if (url.pathname !== options.path) {
        return false;
      }
      if (!method) {
        return true;
      }
      return entry.request.method.toUpperCase() === method;
    }).length;
  }
  return total;
}

export function countCursorHubPublishes(harness: RelayHarness): number {
  return countCursorHubRequests(harness, {
    path: "/publish",
    method: "POST",
  });
}

export function setCursorHubWatchResponse(
  harness: RelayHarness,
  options: { peerShards: string[]; updates?: CursorRelayBatch["updates"] }
): void {
  harness.cursorHub.getByName("global").setJsonPathResponse("/watch", {
    snapshot: {
      from: "cursor-hub",
      updates: options.updates ?? [],
    },
    peerShards: options.peerShards,
  });
}

export function countTileOpsSinceRequests(harness: BasicHarness): number {
  let total = 0;
  for (const stub of harness.tileOwners.stubs.values()) {
    total += stub.requests.filter((entry) => {
      const url = new URL(entry.request.url);
      return entry.request.method.toUpperCase() === "GET" && url.pathname === "/ops-since";
    }).length;
  }

  return total;
}

export async function drainDeferred(harness: RelayHarness): Promise<void> {
  void harness;
  await Promise.resolve();
}

export async function connectClient(
  shard: ConnectionShardDO,
  socketPairFactory: MockSocketPairFactory,
  params: { uid: string; name: string; token?: string; shard: string }
): Promise<MockSocket> {
  const token = params.token ?? "test-token";
  const request = new Request(
    `https://connection-shard.internal/ws?uid=${encodeURIComponent(params.uid)}&name=${encodeURIComponent(
      params.name
    )}&token=${encodeURIComponent(token)}&shard=${encodeURIComponent(params.shard)}`,
    {
      method: "GET",
      headers: {
        upgrade: "websocket",
      },
    }
  );

  const response = await shard.fetch(request);
  expect(response.status).toBe(200);

  const pair = socketPairFactory.pairs[socketPairFactory.pairs.length - 1];
  if (!pair) {
    throw new Error("Expected socket pair");
  }

  expect(pair.server.wasAccepted()).toBe(true);
  return pair.server;
}

async function postJson(
  shard: ConnectionShardDO,
  path: "/tile-batch" | "/cursor-batch",
  body: unknown
): Promise<Response> {
  return shard.fetch(
    new Request(`https://connection-shard.internal${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  );
}

export async function postTileBatch(
  shard: ConnectionShardDO,
  body: Extract<ServerMessage, { t: "cellUpBatch" }>
): Promise<Response> {
  return postJson(shard, "/tile-batch", body);
}

export async function postTileBatchWithHeaders(
  shard: ConnectionShardDO,
  body: Extract<ServerMessage, { t: "cellUpBatch" }>,
  headers: Record<string, string>
): Promise<Response> {
  return shard.fetch(
    new Request("https://connection-shard.internal/tile-batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

export async function postCursorBatch(
  shard: ConnectionShardDO,
  body: unknown
): Promise<Response> {
  return postJson(shard, "/cursor-batch", body);
}

export async function postCursorBatchWithHeaders(
  shard: ConnectionShardDO,
  body: unknown,
  headers: Record<string, string>
): Promise<Response> {
  return shard.fetch(
    new Request("https://connection-shard.internal/cursor-batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

export async function getCursorState(shard: ConnectionShardDO): Promise<CursorRelayBatch> {
  const response = await shard.fetch(
    new Request("https://connection-shard.internal/cursor-state", {
      method: "GET",
    })
  );
  expect(response.status).toBe(200);
  return (await response.json()) as CursorRelayBatch;
}
