import type {
  SocketLike,
  SocketPairFactory,
  WebSocketUpgradeResponseFactory,
} from "../../src/socketPair";

type SocketEventType = "message" | "close" | "error";
type SocketListener = (event: unknown) => void;

export class MockSocket implements SocketLike {
  readonly sentPayloads: Array<ArrayBuffer | ArrayBufferView | string>;
  #accepted: boolean;
  #listeners: Map<SocketEventType, SocketListener[]>;

  constructor() {
    this.sentPayloads = [];
    this.#accepted = false;
    this.#listeners = new Map();
  }

  accept(): void {
    this.#accepted = true;
  }

  send(payload: ArrayBuffer | ArrayBufferView | string): void {
    this.sentPayloads.push(payload);
  }

  addEventListener(type: SocketEventType, listener: SocketListener): void {
    const listeners = this.#listeners.get(type);
    if (listeners) {
      listeners.push(listener);
      return;
    }
    this.#listeners.set(type, [listener]);
  }

  emitMessage(data: unknown): void {
    this.#emit("message", { data });
  }

  emitClose(): void {
    this.#emit("close", { type: "close" });
  }

  emitError(error: unknown = { type: "error" }): void {
    this.#emit("error", error);
  }

  wasAccepted(): boolean {
    return this.#accepted;
  }

  #emit(type: SocketEventType, event: unknown): void {
    const listeners = this.#listeners.get(type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

export interface MockSocketPair {
  client: MockSocket;
  server: MockSocket;
}

export class MockSocketPairFactory implements SocketPairFactory {
  readonly pairs: MockSocketPair[];

  constructor() {
    this.pairs = [];
  }

  createPair(): { client: WebSocket; server: SocketLike } {
    const pair: MockSocketPair = {
      client: new MockSocket(),
      server: new MockSocket(),
    };
    this.pairs.push(pair);

    return {
      client: pair.client as unknown as WebSocket,
      server: pair.server,
    };
  }
}

export class MockUpgradeResponseFactory implements WebSocketUpgradeResponseFactory {
  readonly clientSockets: WebSocket[];
  readonly status: number;

  constructor(status = 200) {
    this.clientSockets = [];
    this.status = status;
  }

  createResponse(clientSocket: WebSocket): Response {
    this.clientSockets.push(clientSocket);
    return new Response(null, { status: this.status });
  }
}
