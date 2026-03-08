export function createSubscriptionRebuildTracker({
  nowMs = () => Date.now(),
  logEvent = () => {},
  scheduleReplay = () => {},
  guardMessage = "Waiting for tile subscriptions to resync...",
} = {}) {
  let rebuildState = null;
  let replayPendingAfterRebuild = false;

  const clearRebuildState = () => {
    const current = rebuildState;
    rebuildState = null;
    return current;
  };

  const completeRebuild = (source, fields = {}) => {
    const state = clearRebuildState();
    if (!state) {
      return;
    }

    logEvent("ws subscription_rebuild_complete", {
      reason: state.trigger,
      source,
      durationMs: Math.max(0, nowMs() - state.startedAtMs),
      ...(state.pendingCid ? { cid: state.pendingCid } : {}),
      ...(typeof state.pendingTiles === "number" ? { tileCount: state.pendingTiles } : {}),
      ...fields,
    });

    if (!replayPendingAfterRebuild) {
      return;
    }
    replayPendingAfterRebuild = false;
    scheduleReplay(0);
  };

  return {
    begin(trigger) {
      rebuildState = {
        trigger,
        startedAtMs: nowMs(),
        pendingCid: null,
        pendingTiles: null,
      };
    },

    markReplayPending() {
      replayPendingAfterRebuild = true;
    },

    isActive() {
      return rebuildState !== null;
    },

    onDispatch(message, reason) {
      if (!rebuildState || rebuildState.trigger !== reason) {
        rebuildState = {
          trigger: reason,
          startedAtMs: nowMs(),
          pendingCid: null,
          pendingTiles: null,
        };
      }
      rebuildState.pendingCid = message.cid ?? null;
      rebuildState.pendingTiles = message.tiles.length;
      logEvent("ws subscription_rebuild_dispatched", {
        reason,
        cid: message.cid ?? null,
        tileCount: message.tiles.length,
      });
    },

    onSkipped(reason, fields = {}) {
      if (!rebuildState || rebuildState.trigger !== reason) {
        return;
      }
      completeRebuild("noop", fields);
    },

    onAck(message) {
      if (!rebuildState?.pendingCid) {
        return;
      }
      if (message.cid !== rebuildState.pendingCid) {
        logEvent("ws subscription_rebuild_ack_ignored", {
          reason: rebuildState.trigger,
          expectedCid: rebuildState.pendingCid,
          cid: message.cid,
        });
        return;
      }
      completeRebuild("sub_ack", {
        ackRequestedCount: message.requestedCount,
        ackChangedCount: message.changedCount,
        ackSubscribedCount: message.subscribedCount,
      });
    },

    getSetCellGuard() {
      if (!rebuildState) {
        return null;
      }
      return {
        reason: "subscription_rebuild",
        message: guardMessage,
        trigger: rebuildState.trigger,
        ...(rebuildState.pendingCid ? { cid: rebuildState.pendingCid } : {}),
      };
    },
  };
}
