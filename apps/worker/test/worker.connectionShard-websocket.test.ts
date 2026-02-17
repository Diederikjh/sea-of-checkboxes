import { TILE_ENCODING } from "@sea/domain";
import {
  createEmptyTileState,
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  encodeRle64,
  type ServerMessage,
} from "@sea/protocol";
import { describe, expect, it } from "vitest";

import { ConnectionShardDO } from "../src/worker";
import {
  MockSocket,
  MockSocketPairFactory,
  MockUpgradeResponseFactory,
} from "./helpers/socketMocks";
import { NullStorage } from "./helpers/storageMocks";
import { waitFor } from "./helpers/waitFor";

interface TileSnapshotMessage {
  t: "tileSnap";
  tile: string;
  ver: number;
  enc: typeof TILE_ENCODING;
  bits: string;
}

interface TileWatchRequest {
  tile: string;
  shard: string;
  action: "sub" | "unsub";
}

interface TileSetCellRequest {
  tile: string;
  i: number;
  v: 0 | 1;
  op: string;
}

class FakeTileOwnerStub {
  readonly tileKey: string;
  readonly watchRequests: TileWatchRequest[];
  readonly setCellRequests: TileSetCellRequest[];
  #versions: Map<string, number>;
  #encodedEmptyBits: string;

  constructor(tileKey: string) {
    this.tileKey = tileKey;
    this.watchRequests = [];
    this.setCellRequests = [];
    this.#versions = new Map();
    this.#encodedEmptyBits = encodeRle64(createEmptyTileState().bits);
  }

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = typeof input === "string" ? new Request(input, init) : input;
    const url = new URL(request.url);

    if (url.pathname === "/watch" && request.method === "POST") {
      const payload = (await request.json()) as TileWatchRequest;
      this.watchRequests.push(payload);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/snapshot") {
      const tile = url.searchParams.get("tile");
      if (!tile) {
        return new Response("Missing tile", { status: 400 });
      }

      const snapshot: TileSnapshotMessage = {
        t: "tileSnap",
        tile,
        ver: this.#versions.get(tile) ?? 0,
        enc: TILE_ENCODING,
        bits: this.#encodedEmptyBits,
      };

      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (url.pathname === "/setCell" && request.method === "POST") {
      const payload = (await request.json()) as TileSetCellRequest;
      this.setCellRequests.push(payload);
      const current = this.#versions.get(payload.tile) ?? 0;
      const next = current + 1;
      this.#versions.set(payload.tile, next);

      return new Response(
        JSON.stringify({
          accepted: true,
          changed: true,
          ver: next,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      );
    }

    return new Response("Not found", { status: 404 });
  }
}

class FakeTileOwnerNamespace {
  readonly stubs: Map<string, FakeTileOwnerStub>;

  constructor() {
    this.stubs = new Map();
  }

  getByName(name: string): FakeTileOwnerStub {
    let stub = this.stubs.get(name);
    if (!stub) {
      stub = new FakeTileOwnerStub(name);
      this.stubs.set(name, stub);
    }
    return stub;
  }
}

function decodeMessages(socket: MockSocket): ServerMessage[] {
  const messages: ServerMessage[] = [];

  for (const payload of socket.sentPayloads) {
    if (typeof payload === "string") {
      continue;
    }
    messages.push(decodeServerMessageBinary(toUint8Array(payload)));
  }

  return messages;
}

function toUint8Array(payload: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

function createHarness() {
  const socketPairFactory = new MockSocketPairFactory();
  const upgradeResponseFactory = new MockUpgradeResponseFactory(200);
  const tileOwners = new FakeTileOwnerNamespace();

  const env = {
    CONNECTION_SHARD: tileOwners,
    TILE_OWNER: tileOwners,
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
  };
}

async function connectClient(
  shard: ConnectionShardDO,
  socketPairFactory: MockSocketPairFactory,
  params: { uid: string; name: string; shard: string }
): Promise<MockSocket> {
  const request = new Request(
    `https://connection-shard.internal/ws?uid=${encodeURIComponent(params.uid)}&name=${encodeURIComponent(
      params.name
    )}&shard=${encodeURIComponent(params.shard)}`,
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

describe("ConnectionShardDO websocket handling", () => {
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
    });
    expect(harness.upgradeResponseFactory.clientSockets.length).toBe(1);
  });

  it("subscribes tiles, registers watch, and returns snapshots", async () => {
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

    const tileStub = harness.tileOwners.getByName("0:0");
    expect(tileStub.watchRequests[0]).toEqual({
      tile: "0:0",
      shard: "shard-a",
      action: "sub",
    });

    const messages = decodeMessages(serverSocket);
    expect(messages.some((message) => message.t === "tileSnap" && message.tile === "0:0")).toBe(true);
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

  it("fans out tile batches only to subscribers", async () => {
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

    await waitFor(() => {
      const tileStub = harness.tileOwners.getByName("0:0");
      expect(tileStub.watchRequests.length).toBe(1);
    });

    const batchResponse = await harness.shard.fetch(
      new Request("https://connection-shard.internal/tile-batch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          t: "cellUpBatch",
          tile: "0:0",
          fromVer: 1,
          toVer: 1,
          ops: [[15, 1]],
        }),
      })
    );

    expect(batchResponse.status).toBe(204);

    const messagesA = decodeMessages(socketA);
    const messagesB = decodeMessages(socketB);

    expect(messagesA.some((message) => message.t === "cellUpBatch" && message.tile === "0:0")).toBe(true);
    expect(messagesB.some((message) => message.t === "cellUpBatch")).toBe(false);
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
