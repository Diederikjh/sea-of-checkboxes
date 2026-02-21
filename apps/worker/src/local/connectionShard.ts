import {
  decodeClientMessageBinary,
  decodeServerMessageBinary,
  parseClientMessage,
  type ClientMessage,
} from "@sea/protocol";

import {
  createClientRecord,
  sendClientError,
  sendServerMessage,
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
import type {
  ClientSink,
  JsonClientSink,
  TileBatchMessage,
  TileWatcher,
} from "./types";
import { fanoutTileBatchToSubscribers } from "../tileBatchFanout";

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

  connectClient(uid: string, name: string, sink: ClientSink, token = "local-dev-token"): void {
    const record = createClientRecord(uid, name, sink);
    this.#clients.set(uid, record);
    sendServerMessage(record, { t: "hello", uid, name, token });
  }

  /** @deprecated Prefer `connectClient` with binary `ClientSink` payloads. */
  connectClientJson(uid: string, name: string, sink: JsonClientSink): void {
    this.connectClient(uid, name, (payload) => {
      sink(decodeServerMessageBinary(payload));
    });
  }

  disconnectClient(uid: string): void {
    disconnectClientFromShard(this.#context(), uid);
  }

  receiveFromClient(uid: string, payload: Uint8Array): void {
    const client = this.#clients.get(uid);
    if (!client) {
      return;
    }

    let message: ClientMessage;
    try {
      message = decodeClientMessageBinary(payload);
    } catch {
      sendClientError(client, "bad_message", "Invalid message payload");
      return;
    }

    this.#handleClientMessage(client, message);
  }

  /** @deprecated Prefer `receiveFromClient` with binary payloads. */
  receiveFromClientJson(uid: string, rawMessage: unknown): void {
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

    this.#handleClientMessage(client, message);
  }

  receiveTileBatch(message: TileBatchMessage): void {
    fanoutTileBatchToSubscribers({
      message,
      tileToClients: this.#tileToClients,
      clients: this.#clients,
      sendServerMessage: (client, batch) => {
        sendServerMessage(client, batch);
      },
    });
  }

  #handleClientMessage(client: ClientRecord, message: ClientMessage): void {
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
