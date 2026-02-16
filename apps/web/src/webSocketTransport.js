const SOCKET_OPEN = 1;

function toUint8Array(messageData) {
  if (messageData instanceof Uint8Array) {
    return messageData;
  }

  if (messageData instanceof ArrayBuffer) {
    return new Uint8Array(messageData);
  }

  return null;
}

export class WebSocketTransport {
  #url;
  #wsFactory;
  #socket;
  #onServerPayload;
  #pendingSends;

  constructor(url, options = {}) {
    this.#url = url;
    this.#wsFactory = options.wsFactory ?? ((wsUrl) => new WebSocket(wsUrl));
    this.#socket = null;
    this.#onServerPayload = () => {};
    this.#pendingSends = [];
  }

  connect(onServerPayload) {
    this.#onServerPayload = onServerPayload;

    const socket = this.#wsFactory(this.#url);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      const payload = toUint8Array(event.data);
      if (!payload) {
        return;
      }
      this.#onServerPayload(payload);
    };
    socket.onopen = () => {
      this.#flushPending();
    };
    socket.onclose = () => {
      if (this.#socket === socket) {
        this.#socket = null;
      }
    };

    this.#socket = socket;
  }

  send(payload) {
    if (this.#socket && this.#socket.readyState === SOCKET_OPEN) {
      this.#socket.send(payload);
      return;
    }

    this.#pendingSends.push(payload);
  }

  dispose() {
    this.#pendingSends.length = 0;

    if (!this.#socket) {
      return;
    }

    const socket = this.#socket;
    this.#socket = null;
    socket.close();
  }

  #flushPending() {
    if (!this.#socket || this.#socket.readyState !== SOCKET_OPEN) {
      return;
    }

    while (this.#pendingSends.length > 0) {
      const payload = this.#pendingSends.shift();
      if (!payload) {
        continue;
      }
      this.#socket.send(payload);
    }
  }
}

export function createWebSocketTransport(url, options) {
  return new WebSocketTransport(url, options);
}
