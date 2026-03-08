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
  nowMs = () => Date.now(),
  offlineBannerMessage = defaultOfflineBannerMessage,
  onSyncWaitEvent = () => {},
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

  const emitSyncWaitEvent = (event, entry, fields = {}) => {
    if (!entry || !entry.message) {
      return;
    }

    const elapsedMs = Math.max(0, nowMs() - entry.firstTrackedAtMs);
    onSyncWaitEvent(event, {
      tile: entry.message.tile,
      i: entry.message.i,
      v: entry.message.v,
      op: entry.message.op,
      ...(typeof entry.message.cid === "string" ? { cid: entry.message.cid } : {}),
      pendingCount: setCellOutbox.size,
      pendingForMs: elapsedMs,
      replayAttempts: entry.replayAttempts,
      ...fields,
    });
  };

  const pruneSetCellOutbox = (currentMs) => {
    let changed = false;
    for (const [key, entry] of setCellOutbox.entries()) {
      const staleByAge = currentMs - entry.updatedAtMs > SETCELL_OUTBOX_TTL_MS;
      const staleByAttempts = entry.replayAttempts >= SETCELL_MAX_REPLAY_ATTEMPTS;
      if (staleByAge || staleByAttempts) {
        setCellOutbox.delete(key);
        emitSyncWaitEvent("setcell_sync_wait_dropped", entry, {
          reason: staleByAge ? "ttl_expired" : "replay_attempts_exhausted",
        });
        changed = true;
      }
    }
    if (changed && !offlineBannerEl.hidden) {
      refreshOfflineBannerText();
    }
  };

  const recordSetCellOutboxEntry = (message) => {
    const currentMs = nowMs();
    pruneSetCellOutbox(currentMs);
    const key = outboxKeyForSetCell(message.tile, message.i);
    const existing = setCellOutbox.get(key);
    const nextEntry = {
      message: { ...message },
      firstTrackedAtMs: existing?.firstTrackedAtMs ?? currentMs,
      updatedAtMs: currentMs,
      replayAttempts: existing?.replayAttempts ?? 0,
    };
    setCellOutbox.set(key, nextEntry);
    if (!existing) {
      emitSyncWaitEvent("setcell_sync_wait_started", nextEntry, {
        reason: "outgoing_setcell",
      });
    }

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
        const oldestEntry = setCellOutbox.get(oldestKey);
        setCellOutbox.delete(oldestKey);
        emitSyncWaitEvent("setcell_sync_wait_dropped", oldestEntry, {
          reason: "outbox_capacity",
        });
      }
    }

    if (!offlineBannerEl.hidden) {
      refreshOfflineBannerText();
    }
  };

  const clearSetCellOutboxEntryForServerUpdate = (tile, index, fields = {}) => {
    const key = outboxKeyForSetCell(tile, index);
    const entry = setCellOutbox.get(key);
    if (!entry) {
      return;
    }

    setCellOutbox.delete(key);
    emitSyncWaitEvent("setcell_sync_wait_cleared", entry, fields);
    if (!offlineBannerEl.hidden) {
      refreshOfflineBannerText();
    }
  };

  const replaySetCellOutbox = () => {
    outboxReplayTimerId = null;
    if (!isTransportOnline()) {
      return;
    }

    const currentMs = nowMs();
    pruneSetCellOutbox(currentMs);
    if (setCellOutbox.size === 0) {
      return;
    }

    const pending = Array.from(setCellOutbox.entries())
      .sort(([, left], [, right]) => left.updatedAtMs - right.updatedAtMs)
      .slice(0, SETCELL_REPLAY_BATCH_SIZE);

    for (const [key, entry] of pending) {
      if (entry.replayAttempts >= SETCELL_MAX_REPLAY_ATTEMPTS) {
        setCellOutbox.delete(key);
        emitSyncWaitEvent("setcell_sync_wait_dropped", entry, {
          reason: "replay_attempts_exhausted",
        });
        continue;
      }
      entry.replayAttempts += 1;
      emitSyncWaitEvent("setcell_sync_wait_replayed", entry, {
        reason: "scheduled_replay",
      });
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
        clearSetCellOutboxEntryForServerUpdate(message.tile, message.i, {
          reason: "cellUp",
          serverValue: message.v,
          serverVer: message.ver,
        });
        return;
      }

      if (message.t !== "cellUpBatch") {
        return;
      }

      for (const [index] of message.ops) {
        clearSetCellOutboxEntryForServerUpdate(message.tile, index, {
          reason: "cellUpBatch",
          serverFromVer: message.fromVer,
          serverToVer: message.toVer,
        });
      }
    },

    getPendingSetCellOpsForTile(tileKey) {
      pruneSetCellOutbox(nowMs());
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
        emitSyncWaitEvent("setcell_sync_wait_dropped", entry, {
          reason: "tile_snapshot_authority",
        });
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
