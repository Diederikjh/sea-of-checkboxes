interface RuntimeWebSocketPair {
  0: WebSocket & { accept: () => void };
  1: WebSocket & { accept: () => void };
}

export interface SocketLike {
  accept(): void;
  send(payload: ArrayBuffer | ArrayBufferView | string): void;
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: unknown) => void
  ): void;
}

export interface SocketPairFactory {
  createPair(): { client: WebSocket; server: SocketLike };
}

export interface WebSocketUpgradeResponseFactory {
  createResponse(clientSocket: WebSocket): Response;
}

export function createRuntimeSocketPairFactory(): SocketPairFactory {
  return {
    createPair() {
      const pair = new (
        globalThis as unknown as { WebSocketPair: new () => RuntimeWebSocketPair }
      ).WebSocketPair();
      return {
        client: pair[0],
        server: pair[1],
      };
    },
  };
}

export function createCloudflareUpgradeResponseFactory(): WebSocketUpgradeResponseFactory {
  return {
    createResponse(clientSocket: WebSocket): Response {
      return new Response(null, {
        status: 101,
        webSocket: clientSocket,
      } as ResponseInit);
    },
  };
}
