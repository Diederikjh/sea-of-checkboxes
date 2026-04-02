export function createTransportRuntime({
  wireTransport,
  perfProbe,
  perfCounter,
  perfTiming,
  encodeClientMessage,
  decodeServerMessage,
  protocolLogsEnabled,
  logger,
  describePayload,
  summarizeMessage,
  setCellOutboxSync,
}) {
  let online = false;
  let wsSessionId = 0;
  let wsSessionOpenedAtMs = null;
  let wsFirstSubLogged = false;
  let wsFirstSetCellLogged = false;

  const logOther = (...args) => {
    if (typeof logger.other === "function") {
      logger.other(...args);
    }
  };

  const beginWsSession = (reconnected) => {
    wsSessionId += 1;
    wsSessionOpenedAtMs = Date.now();
    wsFirstSubLogged = false;
    wsFirstSetCellLogged = false;
    logOther("ws session_open", {
      sessionId: wsSessionId,
      reconnected,
    });
  };

  const endWsSession = ({ disposed }) => {
    if (wsSessionOpenedAtMs === null) {
      return;
    }
    logOther("ws session_close", {
      sessionId: wsSessionId,
      disposed,
      uptimeMs: Math.max(0, Date.now() - wsSessionOpenedAtMs),
    });
    wsSessionOpenedAtMs = null;
  };

  const maybeLogFirstClientMessageAfterOpen = (message) => {
    if (!online || wsSessionOpenedAtMs === null) {
      return;
    }

    const elapsedMs = Math.max(0, Date.now() - wsSessionOpenedAtMs);
    if (message.t === "sub" && !wsFirstSubLogged) {
      wsFirstSubLogged = true;
      logOther("ws first_sub_after_open", {
        sessionId: wsSessionId,
        elapsedMs,
        tileCount: message.tiles.length,
      });
      return;
    }

    if (message.t === "setCell" && !wsFirstSetCellLogged) {
      wsFirstSetCellLogged = true;
      logOther("ws first_setcell_after_open", {
        sessionId: wsSessionId,
        elapsedMs,
        tile: message.tile,
        i: message.i,
        op: message.op,
      });
    }
  };

  const sendToWireTransport = (message) => {
    const payload = perfProbe.measure(perfTiming.PROTOCOL_ENCODE_MS, () =>
      encodeClientMessage(message)
    );
    perfProbe.increment(perfCounter.WS_TX_COUNT);
    perfProbe.increment(perfCounter.WS_TX_BYTES, payload.length);
    if (protocolLogsEnabled) {
      logger.protocol("tx", {
        ...describePayload(payload),
        ...summarizeMessage(message),
      });
    }
    wireTransport.send(payload);
  };

  const send = (message, options = {}) => {
    const trackSetCell = options.trackSetCell ?? true;
    if (message.t === "cur" && !online) {
      return;
    }
    maybeLogFirstClientMessageAfterOpen(message);
    if (trackSetCell) {
      setCellOutboxSync.trackOutgoingClientMessage(message);
    }
    sendToWireTransport(message);
  };

  const connect = (onServerMessage, lifecycleHandlers) => {
    const onOpen =
      typeof lifecycleHandlers?.onOpen === "function" ? lifecycleHandlers.onOpen : () => {};
    const onClose =
      typeof lifecycleHandlers?.onClose === "function" ? lifecycleHandlers.onClose : () => {};

    wireTransport.connect((payload) => {
      perfProbe.increment(perfCounter.WS_RX_COUNT);
      perfProbe.increment(perfCounter.WS_RX_BYTES, payload.length);
      const message = perfProbe.measure(perfTiming.PROTOCOL_DECODE_MS, () =>
        decodeServerMessage(payload)
      );
      if (protocolLogsEnabled) {
        logger.protocol("rx", {
          ...describePayload(payload),
          ...summarizeMessage(message),
        });
      }
      setCellOutboxSync.handleServerMessage(message);
      onServerMessage(message);
    }, {
      onOpen(info) {
        online = true;
        beginWsSession(info.reconnected);
        setCellOutboxSync.handleConnectionOpen();
        onOpen(info);
      },
      onClose(info) {
        online = false;
        endWsSession(info);
        onClose(info);
      },
    });
  };

  return {
    connect,
    send,
    isOnline() {
      return online;
    },
    markOffline() {
      online = false;
    },
    dispose() {
      wireTransport.dispose();
    },
  };
}
