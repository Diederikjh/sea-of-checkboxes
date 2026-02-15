import {
  parseClientMessage,
  type ClientMessage,
} from "@sea/protocol";

import {
  createClientRecord,
  sendClientError,
  type ClientRecord,
} from "./connectionShardClient";
import {
  disconnectClientFromShard,
  handleCursorMessage,
  handleResyncMessage,
  handleSetCellMessage,
  handleSubMessage,
  handleUnsubMessage,
} from "./connectionShardOperations";
import type { LocalRealtimeRuntime } from "./runtime";
import type { ClientSink, TileBatchMessage, TileWatcher } from "./types";

interface ConnectionShardOptions {
  nowMs?: () => number;
}

export class ConnectionShard implements TileWatcher {
  readonly id: string;

  #runtime: LocalRealtimeRuntime;
  #clients: Map<string, ClientRecord>;
  #tileToClients: Map<string, Set<string>>;
  #nowMs: () => number;

  constructor(runtime: LocalRealtimeRuntime, id: string, options: ConnectionShardOptions = {}) {
    this.id = id;
    this.#runtime = runtime;
    this.#clients = new Map();
    this.#tileToClients = new Map();
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  connectClient(uid: string, name: string, sink: ClientSink): void {
    const record = createClientRecord(uid, name, sink);
    this.#clients.set(uid, record);
    sink({ t: "hello", uid, name });
  }

  disconnectClient(uid: string): void {
    disconnectClientFromShard(this.#context(), uid);
  }

  receiveFromClient(uid: string, rawMessage: unknown): void {
    const client = this.#clients.get(uid);
    if (!client) {
      return;
    }

    let message: ClientMessage;
    try {
      message = parseClientMessage(rawMessage);
    } catch {
      sendClientError(client, "bad_message", "Invalid message payload");
      return;
    }

    const context = this.#context();
    switch (message.t) {
      case "sub":
        handleSubMessage(context, client, message.tiles);
        return;
      case "unsub":
        handleUnsubMessage(context, client, message.tiles);
        return;
      case "setCell":
        handleSetCellMessage(context, client, message);
        return;
      case "resyncTile":
        handleResyncMessage(context, client, message.tile);
        return;
      case "cur":
        handleCursorMessage(context, client, message.x, message.y);
        return;
      default:
        return;
    }
  }

  receiveTileBatch(message: TileBatchMessage): void {
    const localSubscribers = this.#tileToClients.get(message.tile);
    if (!localSubscribers || localSubscribers.size === 0) {
      return;
    }

    for (const uid of localSubscribers) {
      const client = this.#clients.get(uid);
      client?.sink(message);
    }
  }

  #context() {
    return {
      shardId: this.id,
      runtime: this.#runtime,
      nowMs: this.#nowMs,
      clients: this.#clients,
      tileToClients: this.#tileToClients,
      watcher: this,
    };
  }
}
