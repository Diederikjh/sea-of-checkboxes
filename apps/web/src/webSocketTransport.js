import { logger } from "./logger";

const SOCKET_OPEN = 1;
const MIN_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 4_000;
const MAX_PENDING_SENDS = 512;

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
  #resolveUrl;
  #wsFactory;
  #socket;
  #onServerPayload;
  #pendingSends;
  #disposed;
  #reconnectDelayMs;
  #reconnectTimer;

  constructor(url, options = {}) {
    this.#url = url;
    this.#resolveUrl = options.resolveUrl ?? (() => this.#url);
    this.#wsFactory = options.wsFactory ?? ((wsUrl) => new WebSocket(wsUrl));
    this.#socket = null;
    this.#onServerPayload = () => {};
    this.#pendingSends = [];
    this.#disposed = false;
    this.#reconnectDelayMs = MIN_RECONNECT_MS;
    this.#reconnectTimer = null;
  }

  connect(onServerPayload) {
    this.#disposed = false;
    this.#onServerPayload = onServerPayload;
    this.#openSocket();
  }

  send(payload) {
    if (this.#isSocketOpen()) {
      this.#socket.send(payload);
      return;
    }

    if (this.#pendingSends.length >= MAX_PENDING_SENDS) {
      this.#pendingSends.shift();
      logger.other("ws queue_drop_oldest", { max: MAX_PENDING_SENDS });
    }
    this.#pendingSends.push(payload);
  }

  dispose() {
    this.#disposed = true;
    this.#pendingSends.length = 0;
    this.#clearReconnectTimer();

    if (!this.#socket) {
      return;
    }

    const socket = this.#socket;
    this.#socket = null;
    socket.close();
  }

  #flushPending() {
    if (!this.#isSocketOpen()) {
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

  #openSocket() {
    this.#clearReconnectTimer();
    if (this.#disposed) {
      return;
    }

    const wsUrl = this.#resolveUrl();
    const socket = this.#wsFactory(wsUrl);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      const payload = toUint8Array(event.data);
      if (!payload) {
        return;
      }
      this.#onServerPayload(payload);
    };
    socket.onopen = () => {
      if (this.#socket !== socket) {
        return;
      }

      this.#reconnectDelayMs = MIN_RECONNECT_MS;
      logger.other("ws open", { url: wsUrl });
      this.#flushPending();
    };
    socket.onclose = () => {
      if (this.#socket === socket) {
        this.#socket = null;
      }

      logger.other("ws close", {
        url: wsUrl,
        pending: this.#pendingSends.length,
        disposed: this.#disposed,
      });

      if (!this.#disposed) {
        this.#scheduleReconnect();
      }
    };
    socket.onerror = () => {
      // onclose drives reconnect scheduling
    };

    this.#socket = socket;
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer !== null || this.#disposed) {
      return;
    }

    const delayMs = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(MAX_RECONNECT_MS, this.#reconnectDelayMs * 2);
    logger.other("ws reconnect_scheduled", {
      delayMs,
      pending: this.#pendingSends.length,
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#openSocket();
    }, delayMs);
  }

  #clearReconnectTimer() {
    if (this.#reconnectTimer === null) {
      return;
    }
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #isSocketOpen() {
    return this.#socket !== null && this.#socket.readyState === SOCKET_OPEN;
  }
}

export function createWebSocketTransport(url, options) {
  return new WebSocketTransport(url, options);
}
