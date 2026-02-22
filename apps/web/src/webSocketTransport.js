import { logger } from "./logger";

const SOCKET_OPEN = 1;
const MIN_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 4_000;
const MAX_PENDING_SENDS = 512;
const RECONNECT_DRAIN_BATCH_SIZE = 2;
const RECONNECT_DRAIN_INTERVAL_MS = 500;

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
  #onOpen;
  #onClose;
  #pendingSends;
  #disposed;
  #reconnectDelayMs;
  #reconnectTimer;
  #hasOpened;
  #pacedDrainActive;
  #pacedDrainTimer;

  constructor(url, options = {}) {
    this.#url = url;
    this.#resolveUrl = options.resolveUrl ?? (() => this.#url);
    this.#wsFactory = options.wsFactory ?? ((wsUrl) => new WebSocket(wsUrl));
    this.#socket = null;
    this.#onServerPayload = () => {};
    this.#onOpen = () => {};
    this.#onClose = () => {};
    this.#pendingSends = [];
    this.#disposed = false;
    this.#reconnectDelayMs = MIN_RECONNECT_MS;
    this.#reconnectTimer = null;
    this.#hasOpened = false;
    this.#pacedDrainActive = false;
    this.#pacedDrainTimer = null;
  }

  connect(onServerPayload, lifecycleHandlers = {}) {
    this.#disposed = false;
    this.#onServerPayload = onServerPayload;
    this.#onOpen = lifecycleHandlers.onOpen ?? (() => {});
    this.#onClose = lifecycleHandlers.onClose ?? (() => {});
    this.#hasOpened = false;
    this.#openSocket();
  }

  send(payload) {
    if (this.#isSocketOpen() && !this.#pacedDrainActive && this.#pendingSends.length === 0) {
      this.#socket.send(payload);
      return;
    }

    if (this.#pendingSends.length >= MAX_PENDING_SENDS) {
      this.#pendingSends.shift();
      logger.other("ws queue_drop_oldest", { max: MAX_PENDING_SENDS });
    }
    this.#pendingSends.push(payload);

    if (!this.#isSocketOpen()) {
      return;
    }

    if (!this.#pacedDrainActive) {
      this.#flushPending();
      return;
    }

    this.#schedulePacedDrain();
  }

  dispose() {
    this.#disposed = true;
    this.#pendingSends.length = 0;
    this.#clearReconnectTimer();
    this.#clearPacedDrainTimer();
    this.#pacedDrainActive = false;

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

    if (!this.#pacedDrainActive) {
      while (this.#pendingSends.length > 0) {
        const payload = this.#pendingSends.shift();
        if (!payload) {
          continue;
        }
        this.#socket.send(payload);
      }
      return;
    }

    let sent = 0;
    while (this.#pendingSends.length > 0 && sent < RECONNECT_DRAIN_BATCH_SIZE) {
      const payload = this.#pendingSends.shift();
      if (!payload) {
        continue;
      }
      this.#socket.send(payload);
      sent += 1;
    }

    if (this.#pendingSends.length === 0) {
      this.#pacedDrainActive = false;
      this.#clearPacedDrainTimer();
      return;
    }

    this.#schedulePacedDrain();
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

      const reconnected = this.#hasOpened;
      this.#hasOpened = true;
      this.#pacedDrainActive = reconnected && this.#pendingSends.length > 0;
      this.#reconnectDelayMs = MIN_RECONNECT_MS;
      logger.other("ws open", { url: wsUrl });
      this.#onOpen({ url: wsUrl, reconnected });
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

      this.#onClose({
        url: wsUrl,
        disposed: this.#disposed,
      });
      this.#clearPacedDrainTimer();
      this.#pacedDrainActive = false;

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

  #schedulePacedDrain() {
    if (this.#pacedDrainTimer !== null || !this.#isSocketOpen() || !this.#pacedDrainActive) {
      return;
    }

    this.#pacedDrainTimer = setTimeout(() => {
      this.#pacedDrainTimer = null;
      this.#flushPending();
    }, RECONNECT_DRAIN_INTERVAL_MS);
  }

  #clearPacedDrainTimer() {
    if (this.#pacedDrainTimer === null) {
      return;
    }
    clearTimeout(this.#pacedDrainTimer);
    this.#pacedDrainTimer = null;
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
