import {
  MAX_TILE_CHURN_PER_MIN,
  SETCELL_BURST_PER_SEC,
  SETCELL_SUSTAINED_PER_SEC,
  SETCELL_SUSTAINED_WINDOW_MS,
} from "@sea/domain";
import type { ServerMessage } from "@sea/protocol";
import { describe, expect, it } from "vitest";

import type { TileSetCellRequest, TileSetCellResponse } from "../src/doCommon";
import {
  disconnectClientFromShard,
  handleSetCellMessage,
  handleSubMessage,
  type ConnectedClient,
  type ConnectionShardDOOperationsContext,
} from "../src/connectionShardDOOperations";
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
  };
}

function createContext() {
  const clients = new Map<string, ConnectedClient>();
  const tileToClients = new Map<string, Set<string>>();
  const watched: Array<{ tile: string; action: "sub" | "unsub" }> = [];
  let watchResult: { ok: boolean; code?: string; msg?: string } = { ok: true };
  let currentNowMs = 1_000;
  const snapshots: Array<{ uid: string; tile: string }> = [];
  const sent: Array<{ uid: string; message: ServerMessage }> = [];
  const errors: Array<{ uid: string; code: string; msg: string }> = [];
  const badTiles: Array<{ uid: string; tile: string }> = [];
  const setCellRequests: TileSetCellRequest[] = [];
  let setCellResult: TileSetCellResponse | null = {
    accepted: true,
    changed: true,
    ver: 1,
  };

  const context: ConnectionShardDOOperationsContext = {
    clients,
    tileToClients,
    sendServerMessage(client, message) {
      sent.push({ uid: client.uid, message });
    },
    sendError(client, code, msg) {
      errors.push({ uid: client.uid, code, msg });
    },
    sendBadTile(client, tileKey) {
      badTiles.push({ uid: client.uid, tile: tileKey });
    },
    async watchTile(tileKey, action) {
      watched.push({ tile: tileKey, action });
      return watchResult;
    },
    async setTileCell(payload) {
      setCellRequests.push(payload);
      return setCellResult;
    },
    async sendSnapshotToClient(client, tileKey) {
      snapshots.push({ uid: client.uid, tile: tileKey });
    },
    nowMs() {
      return currentNowMs;
    },
  };

  return {
    context,
    clients,
    tileToClients,
    watched,
    snapshots,
    sent,
    errors,
    badTiles,
    setCellRequests,
    setSetCellResult(value: TileSetCellResponse | null) {
      setCellResult = value;
    },
    setWatchResult(value: { ok: boolean; code?: string; msg?: string }) {
      watchResult = value;
    },
    setNowMs(value: number) {
      currentNowMs = value;
    },
  };
}

describe("connection shard DO operations", () => {
  it("subscribes tile, registers watcher, and sends snapshot", async () => {
    const harness = createContext();
    const client = createClient("u_a", "Alice");
    harness.clients.set(client.uid, client);

    await handleSubMessage(harness.context, client, ["0:0"]);

    expect(client.subscribed.has("0:0")).toBe(true);
    expect(harness.tileToClients.get("0:0")?.has("u_a")).toBe(true);
    expect(harness.watched).toEqual([{ tile: "0:0", action: "sub" }]);
    expect(harness.snapshots).toEqual([{ uid: "u_a", tile: "0:0" }]);
  });

  it("returns sub_limit when already at cap", async () => {
    const harness = createContext();
    const client = createClient("u_a", "Alice");
    harness.clients.set(client.uid, client);

    for (let index = 0; index < 300; index += 1) {
      client.subscribed.add(`${index}:0`);
    }

    await handleSubMessage(harness.context, client, ["301:0"]);

    expect(harness.errors.length).toBe(1);
    expect(harness.errors[0]?.code).toBe("sub_limit");
    expect(harness.watched.length).toBe(0);
    expect(harness.snapshots.length).toBe(0);
  });

  it("returns churn_limit when tile churn exceeds max per minute", async () => {
    const harness = createContext();
    const client = createClient("u_a", "Alice");
    harness.clients.set(client.uid, client);

    for (let index = 0; index < MAX_TILE_CHURN_PER_MIN; index += 1) {
      client.churnTimestamps = client.churnTimestamps ?? [];
      client.churnTimestamps.push(1_000);
    }

    harness.setNowMs(1_000);
    await handleSubMessage(harness.context, client, ["999:0"]);

    expect(harness.errors.length).toBe(1);
    expect(harness.errors[0]?.code).toBe("churn_limit");
    expect(client.subscribed.has("999:0")).toBe(false);
  });

  it("rejects setCell when tile is not subscribed and sends snapshot", async () => {
    const harness = createContext();
    const client = createClient("u_a", "Alice");

    await handleSetCellMessage(harness.context, client, {
      t: "setCell",
      tile: "0:0",
      i: 22,
      v: 1,
      op: "op_1",
    });

    expect(harness.errors.length).toBe(1);
    expect(harness.errors[0]?.code).toBe("not_subscribed");
    expect(harness.snapshots).toEqual([{ uid: "u_a", tile: "0:0" }]);
    expect(harness.setCellRequests.length).toBe(0);
  });

  it("sends setcell_rejected when setCell is rejected by tile owner", async () => {
    const harness = createContext();
    const client = createClient("u_a", "Alice");
    client.subscribed.add("0:0");
    harness.setSetCellResult({
      accepted: false,
      changed: false,
      ver: 3,
      reason: "rejected",
    });

    await handleSetCellMessage(harness.context, client, {
      t: "setCell",
      tile: "0:0",
      i: 9,
      v: 1,
      op: "op_1",
    });

    expect(harness.watched).toEqual([{ tile: "0:0", action: "sub" }]);
    expect(harness.setCellRequests.length).toBe(1);
    expect(harness.setCellRequests[0]).toMatchObject({
      uid: "u_a",
      name: "Alice",
    });
    expect(harness.errors.length).toBe(1);
    expect(harness.errors[0]?.code).toBe("setcell_rejected");
  });

  it("returns setcell_limit when burst limit is exceeded", async () => {
    const harness = createContext();
    const client = createClient("u_a", "Alice");
    client.subscribed.add("0:0");

    for (let index = 0; index < SETCELL_BURST_PER_SEC; index += 1) {
      client.setCellBurstTimestamps = client.setCellBurstTimestamps ?? [];
      client.setCellBurstTimestamps.push(1_000);
    }

    harness.setNowMs(1_000);
    await handleSetCellMessage(harness.context, client, {
      t: "setCell",
      tile: "0:0",
      i: 9,
      v: 1,
      op: "op_1",
    });

    expect(harness.errors.length).toBe(1);
    expect(harness.errors[0]?.code).toBe("setcell_limit");
    expect(harness.setCellRequests.length).toBe(0);
  });

  it("returns setcell_limit when sustained limit is exceeded", async () => {
    const harness = createContext();
    const client = createClient("u_a", "Alice");
    client.subscribed.add("0:0");

    const sustainedLimit = Math.floor((SETCELL_SUSTAINED_PER_SEC * SETCELL_SUSTAINED_WINDOW_MS) / 1_000);
    for (let index = 0; index < sustainedLimit; index += 1) {
      client.setCellSustainedTimestamps = client.setCellSustainedTimestamps ?? [];
      client.setCellSustainedTimestamps.push(1_000);
    }

    harness.setNowMs(1_000);
    await handleSetCellMessage(harness.context, client, {
      t: "setCell",
      tile: "0:0",
      i: 9,
      v: 1,
      op: "op_1",
    });

    expect(harness.errors.length).toBe(1);
    expect(harness.errors[0]?.code).toBe("setcell_limit");
    expect(harness.setCellRequests.length).toBe(0);
  });

  it("denies subscribe when tile owner rejects watch registration", async () => {
    const harness = createContext();
    const client = createClient("u_a", "Alice");
    harness.clients.set(client.uid, client);
    harness.setWatchResult({
      ok: false,
      code: "tile_sub_denied",
      msg: "Tile is oversubscribed",
    });

    await handleSubMessage(harness.context, client, ["0:0"]);

    expect(client.subscribed.has("0:0")).toBe(false);
    expect(harness.tileToClients.has("0:0")).toBe(false);
    expect(harness.errors[0]?.code).toBe("tile_sub_denied");
    expect(harness.snapshots.length).toBe(0);
  });

  it("returns watch rejection before setCell when watch reassert fails", async () => {
    const harness = createContext();
    const client = createClient("u_a", "Alice");
    client.subscribed.add("0:0");
    harness.setWatchResult({ ok: false, code: "tile_sub_denied", msg: "Tile unavailable" });

    await handleSetCellMessage(harness.context, client, {
      t: "setCell",
      tile: "0:0",
      i: 9,
      v: 1,
      op: "op_1",
    });

    expect(harness.setCellRequests.length).toBe(0);
    expect(harness.errors[0]?.code).toBe("tile_sub_denied");
  });

  it("disconnect removes subscriptions and unsubscribes last tile watcher", async () => {
    const harness = createContext();
    const clientA = createClient("u_a", "Alice");
    clientA.subscribed.add("0:0");
    clientA.subscribed.add("1:0");
    const clientB = createClient("u_b", "Bob");

    harness.clients.set(clientA.uid, clientA);
    harness.clients.set(clientB.uid, clientB);
    harness.tileToClients.set("0:0", new Set(["u_a"]));
    harness.tileToClients.set("1:0", new Set(["u_a", "u_b"]));

    await disconnectClientFromShard(harness.context, "u_a");

    expect(harness.clients.has("u_a")).toBe(false);
    expect(harness.tileToClients.has("0:0")).toBe(false);
    expect(harness.tileToClients.get("1:0")).toEqual(new Set(["u_b"]));
    expect(harness.watched).toEqual([{ tile: "0:0", action: "unsub" }]);
  });
});
