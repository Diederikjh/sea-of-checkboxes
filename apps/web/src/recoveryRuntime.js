export function createRecoveryRuntime({
  transport,
  setCellOutboxSync,
  renderLoop,
  setStatus,
}) {
  const handleConnectionLost = () => {
    transport.markOffline();
    setCellOutboxSync.handleConnectionLost();
    setStatus("Connection lost; retrying...");
  };

  return {
    lifecycleHandlers: {
      onOpen: ({ reconnected }) => {
        if (!reconnected) {
          return;
        }
        renderLoop.markTransportReconnected();
        setStatus("Connection restored; resyncing visible tiles...");
        setCellOutboxSync.scheduleReplay(1_000);
      },
      onClose: ({ disposed }) => {
        if (disposed) {
          return;
        }
        handleConnectionLost();
      },
    },
    onBrowserOffline() {
      handleConnectionLost();
    },
    onBrowserOnline() {
      if (!transport.isOnline()) {
        setStatus("Network restored; reconnecting...");
      }
    },
    getPendingSetCellOpsForTile: setCellOutboxSync.getPendingSetCellOpsForTile,
    dropPendingSetCellOpsForTile: setCellOutboxSync.dropPendingSetCellOpsForTile,
  };
}
