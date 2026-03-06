import type { ClientMessage } from "@sea/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const operationsMocks = vi.hoisted(() => ({
  handleSubMessage: vi.fn(),
  handleUnsubMessage: vi.fn(),
  handleSetCellMessage: vi.fn(),
  handleResyncMessage: vi.fn(),
}));

vi.mock("../src/connectionShardDOOperations", () => operationsMocks);

import { handleConnectionShardClientMessage } from "../src/connectionShardClientMessageHandler";
import type {
  ConnectedClient,
  ConnectionShardDOOperationsContext,
} from "../src/connectionShardDOOperations";
import type { ConnectionShardClientMessageHandlerOptions } from "../src/connectionShardClientMessageHandler";

function createOptions(message: ClientMessage): ConnectionShardClientMessageHandlerOptions {
  const client: ConnectedClient = {
    uid: "u_a",
    name: "Alice",
    subscribed: new Set(),
    socket: {} as ConnectedClient["socket"],
  };
  const context: ConnectionShardDOOperationsContext = {
    clients: new Map([[client.uid, client]]),
    tileToClients: new Map(),
    shardName: () => "shard-a",
    sendServerMessage: vi.fn(),
    sendError: vi.fn(),
    sendBadTile: vi.fn(),
    watchTile: vi.fn(async () => ({ ok: true })),
    setTileCell: vi.fn(async () => null),
    sendSnapshotToClient: vi.fn(async () => {}),
    nowMs: vi.fn(() => 1_000),
  };

  return {
    context,
    client,
    uid: "u_a",
    message,
    logEvent: vi.fn(),
    recordTileVersion: vi.fn(),
    receiveTileBatch: vi.fn(),
    recordRecentEditActivity: vi.fn(),
    cursorOnActivity: vi.fn(),
    cursorOnSubscriptionsChanged: vi.fn(),
    refreshTilePullSchedule: vi.fn(),
    cursorOnLocalCursor: vi.fn(),
    markLocalCursorDirty: vi.fn(),
    elapsedMs: vi.fn(() => 5),
  };
}

describe("handleConnectionShardClientMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles subscription messages via the shared operations module", async () => {
    operationsMocks.handleSubMessage.mockResolvedValue({
      requestedCount: 1,
      changedCount: 1,
      invalidCount: 0,
      rejectedCount: 0,
      clamped: false,
      subscribedCount: 1,
    });
    const options = createOptions({
      t: "sub",
      tiles: ["0:0"],
    });

    await handleConnectionShardClientMessage(options);

    expect(operationsMocks.handleSubMessage).toHaveBeenCalledWith(
      options.context,
      options.client,
      ["0:0"]
    );
    expect(options.logEvent).toHaveBeenCalledWith("sub", expect.objectContaining({
      uid: "u_a",
      requested_count: 1,
      changed_count: 1,
      subscribed_count: 1,
    }));
    expect(options.cursorOnSubscriptionsChanged).toHaveBeenCalledWith(true);
    expect(options.refreshTilePullSchedule).toHaveBeenCalled();
  });

  it("handles unsubscribe messages via the shared operations module", async () => {
    operationsMocks.handleUnsubMessage.mockResolvedValue({
      requestedCount: 1,
      changedCount: 1,
      subscribedCount: 0,
    });
    const options = createOptions({
      t: "unsub",
      tiles: ["0:0"],
    });

    await handleConnectionShardClientMessage(options);

    expect(operationsMocks.handleUnsubMessage).toHaveBeenCalledWith(
      options.context,
      options.client,
      ["0:0"]
    );
    expect(options.logEvent).toHaveBeenCalledWith("unsub", expect.objectContaining({
      uid: "u_a",
      requested_count: 1,
      changed_count: 1,
      subscribed_count: 0,
    }));
    expect(options.cursorOnSubscriptionsChanged).toHaveBeenCalledWith(true);
    expect(options.refreshTilePullSchedule).toHaveBeenCalled();
  });

  it("fans out accepted setCell updates through the injected callbacks", async () => {
    operationsMocks.handleSetCellMessage.mockResolvedValue({
      accepted: true,
      changed: true,
      ver: 42,
      watcherCount: 1,
    });
    const options = createOptions({
      t: "setCell",
      tile: "0:0",
      i: 5,
      v: 1,
      op: "op_1",
    });

    await handleConnectionShardClientMessage(options);

    expect(operationsMocks.handleSetCellMessage).toHaveBeenCalledWith(
      options.context,
      options.client,
      options.message
    );
    expect(options.recordTileVersion).toHaveBeenCalledWith("0:0", 42);
    expect(options.receiveTileBatch).toHaveBeenCalledWith({
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 42,
      toVer: 42,
      ops: [[5, 1]],
    });
    expect(options.recordRecentEditActivity).toHaveBeenCalledWith("0:0", 5);
    expect(options.cursorOnActivity).toHaveBeenCalled();
  });

  it("logs not-subscribed rejections without fanning out a tile update", async () => {
    operationsMocks.handleSetCellMessage.mockResolvedValue({
      accepted: false,
      changed: false,
      reason: "not_subscribed",
      notSubscribed: {
        subscribedCount: 1,
        subscribedTilesSample: ["0:1"],
        clientsConnected: 2,
        connectionAgeMs: 123,
      },
    });
    const options = createOptions({
      t: "setCell",
      tile: "0:0",
      i: 5,
      v: 1,
      op: "op_1",
    });

    await handleConnectionShardClientMessage(options);

    expect(options.logEvent).toHaveBeenCalledWith(
      "setcell_not_subscribed",
      expect.objectContaining({
        uid: "u_a",
        tile: "0:0",
        subscribed_count: 1,
        clients_connected: 2,
        connection_age_ms: 123,
      })
    );
    expect(options.receiveTileBatch).not.toHaveBeenCalled();
    expect(options.recordRecentEditActivity).not.toHaveBeenCalled();
    expect(options.cursorOnActivity).toHaveBeenCalled();
  });

  it("routes resync messages through the shared operations module", async () => {
    const options = createOptions({
      t: "resyncTile",
      tile: "0:0",
      haveVer: 3,
    });

    await handleConnectionShardClientMessage(options);

    expect(operationsMocks.handleResyncMessage).toHaveBeenCalledWith(
      options.context,
      options.client,
      "0:0"
    );
    expect(options.logEvent).toHaveBeenCalledWith("resyncTile", {
      uid: "u_a",
      tile: "0:0",
    });
  });

  it("routes local cursor updates through the cursor callbacks", async () => {
    const options = createOptions({
      t: "cur",
      x: 3.5,
      y: -4.5,
    });

    await handleConnectionShardClientMessage(options);

    expect(options.cursorOnLocalCursor).toHaveBeenCalledWith(options.client, 3.5, -4.5);
    expect(options.markLocalCursorDirty).toHaveBeenCalled();
  });

  it("ignores unsupported client messages", async () => {
    const options = createOptions({ t: "cur", x: 1, y: 2 });
    options.message = { t: "unknown" } as unknown as ClientMessage;

    await handleConnectionShardClientMessage(options);

    expect(options.logEvent).not.toHaveBeenCalled();
    expect(operationsMocks.handleSubMessage).not.toHaveBeenCalled();
    expect(operationsMocks.handleSetCellMessage).not.toHaveBeenCalled();
  });
});
