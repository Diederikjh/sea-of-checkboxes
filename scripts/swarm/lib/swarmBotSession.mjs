import fs from "node:fs";
import path from "node:path";

import {
  buildSocketUrl,
  decodeRle64,
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  parseTileKey,
  shardNameForUid,
  toUint8Array,
  worldToCellIndex,
  worldToTileKey,
} from "./protocol.mjs";
import { createSwarmBotMetrics } from "./metrics.mjs";
import { applyTileOffset, buildScenarioRuntime } from "../scenarios/runtime.mjs";

function defaultWebSocketFactory(url) {
  return new WebSocket(url);
}

function noop() {}

export class SwarmBotSession {
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger;
    this.wsFactory = options.wsFactory ?? defaultWebSocketFactory;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
    this.metrics = options.metrics ?? createSwarmBotMetrics({ nowMs: this.nowMs });
    this.onSummary = options.onSummary ?? noop;
    this.scenario = buildScenarioRuntime(config);

    this.socket = null;
    this.currentToken = "";
    this.identity = null;
    this.startedAtMs = null;
    this.stopping = false;
    this.stopped = false;
    this.stoppedPromise = null;
    this.resolveStopped = null;
    this.durationTimer = null;
    this.reconnectTimer = null;
    this.reconnectBurstTimer = null;
    this.reconnectBurstDeadlineMs = null;
    this.reconnectBurstTriggered = false;
    this.cursorTimer = null;
    this.setCellTimer = null;
    this.viewportTimer = null;
    this.firstLocalCursorSentAtMs = null;
    this.sequence = {
      cid: 0,
      op: 0,
      cursor: 0,
      setCell: 0,
    };
    this.tileState = new Map();
    this.pendingSetCells = new Map();
    this.currentViewportIndex = 0;
    this.currentAnchor = {
      x: this.config.originX,
      y: this.config.originY,
    };
    this.currentSubscriptionTiles = [];
  }

  async start() {
    if (this.stoppedPromise) {
      return this.stoppedPromise;
    }
    this.startedAtMs = this.nowMs();
    this.reconnectBurstDeadlineMs = typeof this.scenario.reconnectBurstDelayMs === "number"
      ? this.startedAtMs + this.scenario.reconnectBurstDelayMs
      : null;
    this.currentAnchor = this.#anchorForViewportIndex(0);
    this.currentSubscriptionTiles = this.#subscriptionTilesForAnchor(this.currentAnchor);
    this.stoppedPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
    this.#log("bot_start", {
      clientSessionId: this.config.clientSessionId,
      wsUrl: this.config.wsUrl,
      originX: this.config.originX,
      originY: this.config.originY,
      readonly: this.scenario.readonly,
      durationMs: this.config.durationMs,
    });
    this.#openSocket();
    this.durationTimer = this.setTimeoutFn(() => {
      void this.stop("duration_elapsed");
    }, this.config.durationMs);
    return this.stoppedPromise;
  }

  async stop(reason = "manual_stop") {
    if (this.stopping) {
      return this.stoppedPromise ?? Promise.resolve();
    }
    this.stopping = true;
    this.metrics.markStopping(this.nowMs());
    this.#log("bot_stopping", {
      reason,
    });
    this.#clearActionTimers();
    this.#clearReconnectTimer();
    if (this.durationTimer !== null) {
      this.clearTimeoutFn(this.durationTimer);
      this.durationTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore close failures during forced stop.
      }
      this.socket = null;
    }
    this.#finish(reason);
    return this.stoppedPromise ?? Promise.resolve();
  }

  #openSocket() {
    const wsUrl = buildSocketUrl(this.config.wsUrl, this.currentToken, this.config.clientSessionId);
    this.metrics.markConnectAttempt(this.nowMs());
    this.#log("ws_connect_attempt", {
      wsUrl,
    });
    const socket = this.wsFactory(wsUrl);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.stopping) {
        return;
      }
      this.#log("ws_open");
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.stopping) {
        return;
      }
      const payload = toUint8Array(event.data);
      if (!payload) {
        this.#log("bad_server_payload", {
          type: typeof event.data,
        });
        return;
      }
      try {
        const message = decodeServerMessageBinary(payload);
        this.#handleServerMessage(message);
      } catch (error) {
        this.metrics.markError("bad_server_message");
        this.#log("bad_server_message", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.metrics.markClose();
      this.#log("ws_close", {
        stopping: this.stopping,
      });
      this.#clearActionTimers();
      if (this.stopping) {
        this.#finish("socket_closed");
        return;
      }
      const reconnectStartedAt = this.nowMs();
      this.reconnectTimer = this.setTimeoutFn(() => {
        this.reconnectTimer = null;
        this.metrics.markReconnect(this.nowMs() - reconnectStartedAt);
        this.#openSocket();
      }, this.config.reconnectDelayMs);
    });
    socket.addEventListener("error", () => {
      this.#log("ws_error");
    });

    this.socket = socket;
  }

  #handleServerMessage(message) {
    this.#log("server_message", {
      type: message.t,
      ...(typeof message.cid === "string" ? { cid: message.cid } : {}),
      ...(typeof message.tile === "string" ? { tile: message.tile } : {}),
      ...(typeof message.code === "string" ? { code: message.code } : {}),
    });

    switch (message.t) {
      case "hello":
        this.metrics.markHello(this.nowMs());
        this.currentToken = message.token;
        this.identity = {
          uid: message.uid,
          name: message.name,
          token: message.token,
          shard: shardNameForUid(message.uid),
          clientSessionId: this.config.clientSessionId,
        };
        this.#log("hello_received", {
          uid: message.uid,
          name: message.name,
          shard: this.identity.shard,
          clientSessionId: this.config.clientSessionId,
          hasSpawn: Boolean(message.spawn),
        });
        this.#syncSubscriptions(true);
        this.#startActionLoops();
        return;
      case "subAck":
        this.metrics.markSubscribeAck(message.cid, this.nowMs());
        this.#log("sub_ack", {
          cid: message.cid,
          requestedCount: message.requestedCount,
          changedCount: message.changedCount,
          subscribedCount: message.subscribedCount,
        });
        return;
      case "tileSnap":
        this.#applyTileSnapshot(message.tile, message.bits, message.ver);
        this.metrics.markTileSnapshotResolved(message.tile, this.nowMs());
        this.#logResolvedPendingForTile(message.tile, "tileSnap");
        return;
      case "cellUp":
        this.#applyCellUpdate(message.tile, message.i, message.v, message.ver);
        this.metrics.markAuthoritativeUpdate();
        this.metrics.markSetCellResolved(message.tile, message.i, this.nowMs());
        this.#logResolvedPendingCell(message.tile, message.i, "cellUp", message.v, message.ver);
        return;
      case "cellUpBatch":
        this.#applyCellBatch(message.tile, message.ops, message.toVer);
        this.metrics.markAuthoritativeUpdate();
        for (const [index] of message.ops) {
          this.metrics.markSetCellResolved(message.tile, index, this.nowMs());
          this.#logResolvedPendingCell(
            message.tile,
            index,
            "cellUpBatch",
            this.#getLocalCellValue(message.tile, index),
            message.toVer
          );
        }
        return;
      case "curUp":
        if (this.identity && message.uid === this.identity.uid) {
          return;
        }
        this.metrics.markRemoteCursor(message.uid, this.nowMs(), this.firstLocalCursorSentAtMs);
        return;
      case "err":
        this.metrics.markError(message.code);
        this.#log("server_error", {
          code: message.code,
          msg: message.msg,
          ...(typeof message.trace === "string" ? { trace: message.trace } : {}),
        });
        return;
      default:
        return;
    }
  }

  #startActionLoops() {
    this.#clearActionTimers();
    this.#sendCursor();
    if (!this.stopping && this.socket && this.scenario.cursorIntervalMs > 0) {
      this.#scheduleNextCursor();
    }
    if (!this.stopping && this.socket && !this.scenario.readonly && this.scenario.setCellIntervalMs > 0) {
      this.#scheduleNextSetCell();
    }
    if (!this.stopping && this.socket && this.scenario.viewportOffsets?.length > 1) {
      this.#scheduleNextViewportMove();
    }
    if (!this.stopping && this.socket) {
      this.#scheduleReconnectBurst();
    }
  }

  #scheduleNextCursor() {
    this.cursorTimer = this.setTimeoutFn(() => {
      this.cursorTimer = null;
      this.#sendCursor();
      if (!this.stopping && this.socket) {
        this.#scheduleNextCursor();
      }
    }, this.scenario.cursorIntervalMs);
  }

  #scheduleNextSetCell() {
    this.setCellTimer = this.setTimeoutFn(() => {
      this.setCellTimer = null;
      this.#sendSetCell();
      if (!this.stopping && this.socket) {
        this.#scheduleNextSetCell();
      }
    }, this.scenario.setCellIntervalMs);
  }

  #scheduleNextViewportMove() {
    if (typeof this.scenario.viewportIntervalMs !== "number") {
      return;
    }
    this.viewportTimer = this.setTimeoutFn(() => {
      this.viewportTimer = null;
      this.#performViewportMove();
      if (!this.stopping && this.socket) {
        this.#scheduleNextViewportMove();
      }
    }, this.scenario.viewportIntervalMs);
  }

  #scheduleReconnectBurst() {
    if (this.reconnectBurstTriggered || this.reconnectBurstTimer !== null || this.reconnectBurstDeadlineMs === null) {
      return;
    }
    const delayMs = Math.max(0, this.reconnectBurstDeadlineMs - this.nowMs());
    this.reconnectBurstTimer = this.setTimeoutFn(() => {
      this.reconnectBurstTimer = null;
      this.#triggerReconnectBurst();
    }, delayMs);
  }

  #triggerReconnectBurst() {
    if (this.reconnectBurstTriggered || this.stopping || !this.socket) {
      return;
    }
    this.reconnectBurstTriggered = true;
    this.metrics.markForcedReconnect();
    this.#log("reconnect_burst_triggered");
    try {
      this.socket.close();
    } catch {
      // Ignore close failures during reconnect injection.
    }
  }

  #performViewportMove() {
    const previousTiles = this.currentSubscriptionTiles;
    const previousAnchor = this.currentAnchor;
    this.currentViewportIndex = (this.currentViewportIndex + 1) % this.scenario.viewportOffsets.length;
    this.currentAnchor = this.#anchorForViewportIndex(this.currentViewportIndex);
    this.metrics.markViewportMove();
    this.#syncSubscriptions(false);
    this.#log("viewport_move", {
      fromX: previousAnchor.x,
      fromY: previousAnchor.y,
      toX: this.currentAnchor.x,
      toY: this.currentAnchor.y,
      fromTiles: previousTiles,
      toTiles: this.currentSubscriptionTiles,
    });
  }

  #anchorForViewportIndex(index) {
    const offset = this.scenario.viewportOffsets?.[index] ?? { dx: 0, dy: 0 };
    return applyTileOffset(this.config.originX, this.config.originY, offset);
  }

  #subscriptionTilesForAnchor(anchor) {
    const baseTile = worldToTileKey(anchor.x, anchor.y);
    return this.scenario.subscribeOffsets.map((offset) => tileKeyWithOffset(baseTile, offset.dx, offset.dy));
  }

  #syncSubscriptions(force) {
    const nextTiles = this.#subscriptionTilesForAnchor(this.currentAnchor);
    if (force) {
      this.#sendSubscribe(nextTiles);
      this.currentSubscriptionTiles = nextTiles;
      return;
    }

    const previous = new Set(this.currentSubscriptionTiles);
    const next = new Set(nextTiles);
    const removed = this.currentSubscriptionTiles.filter((tile) => !next.has(tile));
    const added = nextTiles.filter((tile) => !previous.has(tile));

    if (removed.length > 0) {
      this.#sendUnsubscribe(removed);
    }
    if (added.length > 0) {
      this.#sendSubscribe(added);
    }

    this.currentSubscriptionTiles = nextTiles;
  }

  #sendSubscribe(tiles) {
    if (tiles.length === 0) {
      return;
    }
    const cid = this.#nextCid("sub");
    this.metrics.markSubscribeSent(cid, this.nowMs());
    this.#send({
      t: "sub",
      cid,
      tiles,
    });
    this.#log("sub_sent", {
      cid,
      tiles,
    });
  }

  #sendUnsubscribe(tiles) {
    if (tiles.length === 0) {
      return;
    }
    const cid = this.#nextCid("unsub");
    this.metrics.markUnsubscribeSent();
    this.#send({
      t: "unsub",
      cid,
      tiles,
    });
    this.#log("unsub_sent", {
      cid,
      tiles,
    });
  }

  #sendCursor() {
    const sequence = this.sequence.cursor;
    this.sequence.cursor += 1;
    const point = cursorPointForScenario(this.scenario.cursorPattern, this.currentAnchor, sequence);
    if (this.firstLocalCursorSentAtMs === null) {
      this.firstLocalCursorSentAtMs = this.nowMs();
    }
    this.metrics.markCursorSent();
    this.#send({
      t: "cur",
      x: point.x,
      y: point.y,
    });
    this.#log("cursor_sent", {
      x: point.x,
      y: point.y,
      sequence,
    });
  }

  #sendSetCell() {
    const sequence = this.sequence.setCell;
    this.sequence.setCell += 1;
    const worldPoint = setCellPointForScenario(this.scenario.setCellPattern, this.currentAnchor, sequence);
    const tile = worldToTileKey(worldPoint.x, worldPoint.y);
    const index = worldToCellIndex(worldPoint.x, worldPoint.y);
    const op = `${this.config.botId}-op-${String(this.sequence.op).padStart(6, "0")}`;
    this.sequence.op += 1;
    const localBeforeV = this.#getLocalCellValue(tile, index);
    const value = localBeforeV === null ? ((sequence % 2 === 0) ? 1 : 0) : (localBeforeV === 1 ? 0 : 1);
    const expectChange = localBeforeV === null ? null : localBeforeV !== value;
    this.pendingSetCells.set(`${tile}:${index}`, {
      tile,
      index,
      requestedValue: value,
      localBeforeV,
      op,
    });
    this.metrics.markSetCellSent(tile, index, this.nowMs());
    this.#send({
      t: "setCell",
      tile,
      i: index,
      v: value,
      op,
    });
    this.#log("setcell_sent", {
      tile,
      i: index,
      v: value,
      op,
      localBeforeV,
      expectChange,
    });
  }

  #send(message) {
    if (!this.socket) {
      return;
    }
    this.socket.send(encodeClientMessageBinary(message));
  }

  #nextCid(prefix) {
    const value = this.sequence.cid;
    this.sequence.cid += 1;
    return `${this.config.botId}-${prefix}-${String(value).padStart(6, "0")}`;
  }

  #clearActionTimers() {
    if (this.cursorTimer !== null) {
      this.clearTimeoutFn(this.cursorTimer);
      this.cursorTimer = null;
    }
    if (this.setCellTimer !== null) {
      this.clearTimeoutFn(this.setCellTimer);
      this.setCellTimer = null;
    }
    if (this.viewportTimer !== null) {
      this.clearTimeoutFn(this.viewportTimer);
      this.viewportTimer = null;
    }
    if (this.reconnectBurstTimer !== null) {
      this.clearTimeoutFn(this.reconnectBurstTimer);
      this.reconnectBurstTimer = null;
    }
  }

  #clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  #finish(reason) {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.metrics.markStopped(this.nowMs());
    const summary = this.metrics.summary({
      runId: this.config.runId,
      botId: this.config.botId,
      scenarioId: this.scenario.id,
      reason,
      originX: this.config.originX,
      originY: this.config.originY,
      readonly: this.scenario.readonly,
      identity: this.identity,
      clientSessionId: this.config.clientSessionId,
      shard: this.identity?.shard ?? null,
      durationMs: this.startedAtMs === null ? null : this.nowMs() - this.startedAtMs,
    });
    fs.mkdirSync(path.dirname(this.config.summaryOutput), { recursive: true });
    fs.writeFileSync(this.config.summaryOutput, `${JSON.stringify(summary, null, 2)}\n`);
    this.#log("bot_summary", summary);
    this.onSummary(summary);
    if (this.resolveStopped) {
      this.resolveStopped(summary);
      this.resolveStopped = null;
    }
  }

  #applyTileSnapshot(tile, encodedBits, ver) {
    const bits = decodeRle64(encodedBits);
    this.tileState.set(tile, {
      bits,
      ver,
    });
  }

  #applyCellUpdate(tile, index, value, ver) {
    const existing = this.tileState.get(tile);
    if (!existing) {
      const bits = new Uint8Array(4096);
      bits[index] = value;
      this.tileState.set(tile, { bits, ver });
      return;
    }
    existing.bits[index] = value;
    existing.ver = ver;
  }

  #applyCellBatch(tile, ops, ver) {
    const existing = this.tileState.get(tile);
    const bits = existing?.bits ?? new Uint8Array(4096);
    for (const [index, value] of ops) {
      bits[index] = value;
    }
    this.tileState.set(tile, {
      bits,
      ver,
    });
  }

  #getLocalCellValue(tile, index) {
    const existing = this.tileState.get(tile);
    if (!existing) {
      return null;
    }
    const value = existing.bits[index];
    return value === undefined ? null : value;
  }

  #logResolvedPendingForTile(tile, source) {
    const prefix = `${tile}:`;
    for (const [key, pending] of this.pendingSetCells.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const confirmedValue = this.#getLocalCellValue(tile, pending.index);
      this.#log("setcell_confirmed", {
        tile,
        i: pending.index,
        op: pending.op,
        requestedValue: pending.requestedValue,
        localBeforeV: pending.localBeforeV,
        confirmedValue,
        source,
        confirmedChanged: confirmedValue !== pending.localBeforeV,
        confirmedMatchesRequest: confirmedValue === pending.requestedValue,
      });
      this.pendingSetCells.delete(key);
    }
  }

  #logResolvedPendingCell(tile, index, source, confirmedValue, ver) {
    const key = `${tile}:${index}`;
    const pending = this.pendingSetCells.get(key);
    if (!pending) {
      return;
    }
    this.#log("setcell_confirmed", {
      tile,
      i: index,
      op: pending.op,
      requestedValue: pending.requestedValue,
      localBeforeV: pending.localBeforeV,
      confirmedValue,
      ver,
      source,
      confirmedChanged: confirmedValue !== pending.localBeforeV,
      confirmedMatchesRequest: confirmedValue === pending.requestedValue,
    });
    this.pendingSetCells.delete(key);
  }

  #log(event, fields = {}) {
    this.logger.log(event, {
      runId: this.config.runId,
      botId: this.config.botId,
      scenarioId: this.scenario.id,
      ...fields,
    });
  }
}

function tileKeyWithOffset(tileKey, dx, dy) {
  const parsed = parseTileKey(tileKey);
  if (!parsed) {
    throw new Error(`Invalid tile key: ${tileKey}`);
  }
  return `${parsed.tx + dx}:${parsed.ty + dy}`;
}

function cursorPointForScenario(pattern, anchor, step) {
  switch (pattern) {
    case "tight-orbit":
      return pointFromPattern(anchor, step, [
        { x: 0, y: 0 },
        { x: 0.75, y: 0.5 },
        { x: 1.25, y: 0.75 },
        { x: 0.5, y: 1.25 },
        { x: -0.5, y: 0.75 },
        { x: -0.75, y: 0.25 },
      ]);
    case "lurker-orbit":
      return pointFromPattern(anchor, step, [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.25 },
        { x: 0.75, y: 0.5 },
        { x: 0.25, y: 0.75 },
        { x: -0.25, y: 0.5 },
        { x: -0.5, y: 0.1 },
      ]);
    case "figure-eight":
      return pointFromPattern(anchor, step, [
        { x: 0, y: 0 },
        { x: 2, y: 1 },
        { x: 4, y: 0 },
        { x: 2, y: -1 },
        { x: 0, y: 0 },
        { x: -2, y: 1 },
        { x: -4, y: 0 },
        { x: -2, y: -1 },
      ]);
    case "orbit":
    default:
      return pointFromPattern(anchor, step, [
        { x: 0, y: 0 },
        { x: 1.25, y: 0.75 },
        { x: 2, y: 1.5 },
        { x: 0.5, y: 2.25 },
        { x: -0.75, y: 1.5 },
        { x: -1.5, y: 0.25 },
      ]);
  }
}

function setCellPointForScenario(pattern, anchor, step) {
  switch (pattern) {
    case "hotspot":
      return pointFromPattern(anchorFloor(anchor), step, [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ]);
    case "spread":
    default:
      return pointFromPattern(tileOrigin(anchor), step, [
        { x: 8, y: 8 },
        { x: 16, y: 8 },
        { x: 24, y: 8 },
        { x: 8, y: 16 },
        { x: 16, y: 16 },
        { x: 24, y: 16 },
        { x: 32, y: 24 },
        { x: 40, y: 32 },
      ]);
  }
}

function pointFromPattern(anchor, step, pattern) {
  const point = pattern[step % pattern.length];
  return {
    x: anchor.x + point.x,
    y: anchor.y + point.y,
  };
}

function anchorFloor(anchor) {
  return {
    x: Math.floor(anchor.x),
    y: Math.floor(anchor.y),
  };
}

function tileOrigin(anchor) {
  return {
    x: Math.floor(anchor.x / 64) * 64,
    y: Math.floor(anchor.y / 64) * 64,
  };
}
