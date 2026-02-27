const OFFLINE_BANNER_DELAY_MS = 30_000;
const SETCELL_OUTBOX_MAX_ENTRIES = 100;
const SETCELL_OUTBOX_TTL_MS = 90_000;
const SETCELL_REPLAY_BATCH_SIZE = 2;
const SETCELL_REPLAY_INTERVAL_MS = 500;
const SETCELL_MAX_REPLAY_ATTEMPTS = 6;

function defaultOfflineBannerMessage(unsyncedCount) {
  if (unsyncedCount <= 0) {
    return "You are offline. 0 unsynced events.";
  }
  return `You are offline. ${unsyncedCount} unsynced event${unsyncedCount === 1 ? "" : "s"}.`;
}

function outboxKeyForSetCell(tile, index) {
  return `${tile}:${index}`;
}

export function createSetCellOutboxSync({
  offlineBannerEl,
  sendToWireTransport,
  isTransportOnline,
  setTimeoutFn = globalThis.setTimeout.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
  offlineBannerMessage = defaultOfflineBannerMessage,
}) {
  let offlineBannerTimerId = null;
  let outboxReplayTimerId = null;
  const setCellOutbox = new Map();

  const refreshOfflineBannerText = () => {
    offlineBannerEl.textContent = offlineBannerMessage(setCellOutbox.size);
  };

  const clearOutboxReplayTimer = () => {
    if (outboxReplayTimerId === null) {
      return;
    }
    clearTimeoutFn(outboxReplayTimerId);
    outboxReplayTimerId = null;
  };

  const clearOfflineBannerTimer = () => {
    if (offlineBannerTimerId === null) {
      return;
    }
    clearTimeoutFn(offlineBannerTimerId);
    offlineBannerTimerId = null;
  };

  const hideOfflineBanner = () => {
    clearOfflineBannerTimer();
    offlineBannerEl.hidden = true;
  };

  const pruneSetCellOutbox = (nowMs) => {
    let changed = false;
    for (const [key, entry] of setCellOutbox.entries()) {
      const staleByAge = nowMs - entry.updatedAtMs > SETCELL_OUTBOX_TTL_MS;
      const staleByAttempts = entry.replayAttempts >= SETCELL_MAX_REPLAY_ATTEMPTS;
      if (staleByAge || staleByAttempts) {
        setCellOutbox.delete(key);
        changed = true;
      }
    }
    if (changed && !offlineBannerEl.hidden) {
      refreshOfflineBannerText();
    }
  };

  const recordSetCellOutboxEntry = (message) => {
    const nowMs = Date.now();
    pruneSetCellOutbox(nowMs);
    const key = outboxKeyForSetCell(message.tile, message.i);
    const existing = setCellOutbox.get(key);
    setCellOutbox.set(key, {
      message: { ...message },
      updatedAtMs: nowMs,
      replayAttempts: existing?.replayAttempts ?? 0,
    });

    if (setCellOutbox.size > SETCELL_OUTBOX_MAX_ENTRIES) {
      let oldestKey = null;
      let oldestUpdatedAt = Number.POSITIVE_INFINITY;
      for (const [entryKey, entry] of setCellOutbox.entries()) {
        if (entry.updatedAtMs < oldestUpdatedAt) {
          oldestUpdatedAt = entry.updatedAtMs;
          oldestKey = entryKey;
        }
      }
      if (oldestKey !== null) {
        setCellOutbox.delete(oldestKey);
      }
    }

    if (!offlineBannerEl.hidden) {
      refreshOfflineBannerText();
    }
  };

  const clearSetCellOutboxEntryForServerUpdate = (tile, index) => {
    const key = outboxKeyForSetCell(tile, index);
    if (!setCellOutbox.has(key)) {
      return;
    }

    setCellOutbox.delete(key);
    if (!offlineBannerEl.hidden) {
      refreshOfflineBannerText();
    }
  };

  const replaySetCellOutbox = () => {
    outboxReplayTimerId = null;
    if (!isTransportOnline()) {
      return;
    }

    const nowMs = Date.now();
    pruneSetCellOutbox(nowMs);
    if (setCellOutbox.size === 0) {
      return;
    }

    const pending = Array.from(setCellOutbox.entries())
      .sort(([, left], [, right]) => left.updatedAtMs - right.updatedAtMs)
      .slice(0, SETCELL_REPLAY_BATCH_SIZE);

    for (const [key, entry] of pending) {
      if (entry.replayAttempts >= SETCELL_MAX_REPLAY_ATTEMPTS) {
        setCellOutbox.delete(key);
        continue;
      }
      entry.replayAttempts += 1;
      sendToWireTransport(entry.message);
    }

    if (setCellOutbox.size > 0) {
      outboxReplayTimerId = setTimeoutFn(replaySetCellOutbox, SETCELL_REPLAY_INTERVAL_MS);
    }
  };

  return {
    trackOutgoingClientMessage(message) {
      if (message.t !== "setCell") {
        return;
      }
      recordSetCellOutboxEntry(message);
    },

    handleServerMessage(message) {
      if (message.t === "cellUp") {
        // Server updates are authoritative; clear local pending intent for that cell
        // even when value diverges, so stale outbox entries cannot override fresh state.
        clearSetCellOutboxEntryForServerUpdate(message.tile, message.i);
        return;
      }

      if (message.t !== "cellUpBatch") {
        return;
      }

      for (const [index] of message.ops) {
        clearSetCellOutboxEntryForServerUpdate(message.tile, index);
      }
    },

    getPendingSetCellOpsForTile(tileKey) {
      pruneSetCellOutbox(Date.now());
      const pending = [];
      for (const entry of setCellOutbox.values()) {
        if (entry.message.tile !== tileKey) {
          continue;
        }
        pending.push({
          i: entry.message.i,
          v: entry.message.v,
        });
      }
      return pending;
    },

    dropPendingSetCellOpsForTile(tileKey) {
      let dropped = 0;
      for (const [key, entry] of setCellOutbox.entries()) {
        if (entry.message.tile !== tileKey) {
          continue;
        }
        setCellOutbox.delete(key);
        dropped += 1;
      }
      if (dropped > 0 && !offlineBannerEl.hidden) {
        refreshOfflineBannerText();
      }
      return dropped;
    },

    handleConnectionOpen() {
      hideOfflineBanner();
      clearOutboxReplayTimer();
    },

    handleConnectionLost() {
      clearOutboxReplayTimer();
      clearOfflineBannerTimer();
      offlineBannerTimerId = setTimeoutFn(() => {
        offlineBannerTimerId = null;
        if (!isTransportOnline()) {
          refreshOfflineBannerText();
          offlineBannerEl.hidden = false;
        }
      }, OFFLINE_BANNER_DELAY_MS);
    },

    scheduleReplay(delayMs) {
      if (!isTransportOnline() || setCellOutbox.size === 0 || outboxReplayTimerId !== null) {
        return;
      }
      outboxReplayTimerId = setTimeoutFn(replaySetCellOutbox, delayMs);
    },

    dispose() {
      clearOutboxReplayTimer();
      hideOfflineBanner();
    },
  };
}
