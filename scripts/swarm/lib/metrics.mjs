function percentile(values, ratio) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarizeLatencies(values) {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: null,
      maxMs: null,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    };
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    avgMs: Number((total / values.length).toFixed(3)),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  };
}

export function createSwarmBotMetrics({ nowMs = () => Date.now() } = {}) {
  const counters = new Map();
  const errorsByCode = new Map();
  const firstRemoteCursorByPeer = new Map();
  const remoteCursorCountsByPeer = new Map();
  const pendingSubscribe = new Map();
  const pendingSetCell = new Map();
  const latencies = {
    hello: [],
    subscribeAck: [],
    setCellSync: [],
    reconnect: [],
    stop: [],
    firstRemoteCursor: [],
  };

  let connectStartedAtMs = null;
  let stoppingStartedAtMs = null;

  function increment(name, delta = 1) {
    counters.set(name, (counters.get(name) ?? 0) + delta);
  }

  function pendingSetCellCount() {
    let count = 0;
    for (const queue of pendingSetCell.values()) {
      count += queue.length;
    }
    return count;
  }

  return {
    markConnectAttempt(startMs = nowMs()) {
      connectStartedAtMs = startMs;
      increment("connectAttempts");
    },
    markHello(receivedAtMs = nowMs()) {
      increment("helloCount");
      if (typeof connectStartedAtMs === "number") {
        latencies.hello.push(receivedAtMs - connectStartedAtMs);
      }
    },
    markSubscribeSent(cid, sentAtMs = nowMs()) {
      pendingSubscribe.set(cid, sentAtMs);
      increment("subscribeSent");
    },
    markUnsubscribeSent() {
      increment("unsubscribeSent");
    },
    markSubscribeAck(cid, receivedAtMs = nowMs()) {
      increment("subscribeAck");
      const sentAtMs = pendingSubscribe.get(cid);
      if (typeof sentAtMs === "number") {
        latencies.subscribeAck.push(receivedAtMs - sentAtMs);
        pendingSubscribe.delete(cid);
      }
    },
    markSetCellSent(tile, index, sentAtMs = nowMs()) {
      const key = `${tile}:${index}`;
      const queue = pendingSetCell.get(key) ?? [];
      queue.push(sentAtMs);
      pendingSetCell.set(key, queue);
      increment("setCellSent");
    },
    markSetCellResolved(tile, index, receivedAtMs = nowMs()) {
      const key = `${tile}:${index}`;
      const queue = pendingSetCell.get(key);
      const sentAtMs = queue?.shift();
      if (typeof sentAtMs === "number") {
        latencies.setCellSync.push(receivedAtMs - sentAtMs);
        if (queue.length === 0) {
          pendingSetCell.delete(key);
        }
        increment("setCellResolved");
      }
    },
    markTileSnapshotResolved(tile, receivedAtMs = nowMs()) {
      const prefix = `${tile}:`;
      for (const [key, queue] of pendingSetCell.entries()) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        for (const sentAtMs of queue) {
          latencies.setCellSync.push(receivedAtMs - sentAtMs);
          increment("setCellResolved");
        }
        pendingSetCell.delete(key);
      }
    },
    markReconnect(durationMs) {
      increment("reconnects");
      latencies.reconnect.push(durationMs);
    },
    markForcedReconnect() {
      increment("forcedReconnects");
    },
    markError(code) {
      increment("errors");
      errorsByCode.set(code, (errorsByCode.get(code) ?? 0) + 1);
    },
    markRemoteCursor(uid, receivedAtMs = nowMs(), firstLocalCursorSentAtMs = null) {
      remoteCursorCountsByPeer.set(uid, (remoteCursorCountsByPeer.get(uid) ?? 0) + 1);
      if (firstRemoteCursorByPeer.has(uid)) {
        return;
      }
      firstRemoteCursorByPeer.set(uid, receivedAtMs);
      increment("firstRemoteCursorPeers");
      if (typeof firstLocalCursorSentAtMs === "number") {
        latencies.firstRemoteCursor.push(receivedAtMs - firstLocalCursorSentAtMs);
      }
    },
    markClose() {
      increment("wsCloses");
    },
    markCursorSent() {
      increment("cursorSent");
    },
    markAuthoritativeUpdate() {
      increment("authoritativeUpdates");
    },
    markViewportMove() {
      increment("viewportMoves");
    },
    markStopping(startMs = nowMs()) {
      stoppingStartedAtMs = startMs;
    },
    markStopped(stoppedAtMs = nowMs()) {
      if (typeof stoppingStartedAtMs === "number") {
        latencies.stop.push(stoppedAtMs - stoppingStartedAtMs);
      }
    },
    summary(extra = {}) {
      return {
        counters: Object.fromEntries(counters.entries()),
        errorsByCode: Object.fromEntries(errorsByCode.entries()),
        remoteCursorCountsByPeer: Object.fromEntries(remoteCursorCountsByPeer.entries()),
        latencyMs: {
          hello: summarizeLatencies(latencies.hello),
          subscribeAck: summarizeLatencies(latencies.subscribeAck),
          setCellSync: summarizeLatencies(latencies.setCellSync),
          reconnect: summarizeLatencies(latencies.reconnect),
          stop: summarizeLatencies(latencies.stop),
          firstRemoteCursor: summarizeLatencies(latencies.firstRemoteCursor),
        },
        pending: {
          subscribe: pendingSubscribe.size,
          setCell: pendingSetCellCount(),
        },
        ...extra,
      };
    },
  };
}
