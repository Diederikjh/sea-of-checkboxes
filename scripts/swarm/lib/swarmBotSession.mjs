import fs from "node:fs";
import path from "node:path";

import {
  buildSocketUrl,
  decodeRle64,
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  shardNameForUid,
  toUint8Array,
  worldToCellIndex,
  worldToTileKey,
} from "./protocol.mjs";
import { createSwarmBotMetrics } from "./metrics.mjs";

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
    this.cursorTimer = null;
    this.setCellTimer = null;
    this.connectOpenedAtMs = null;
    this.firstLocalCursorSentAtMs = null;
    this.sequence = {
      cid: 0,
      op: 0,
      cursor: 0,
      setCell: 0,
    };
    this.tileState = new Map();
    this.pendingSetCells = new Map();
  }

  async start() {
    if (this.stoppedPromise) {
      return this.stoppedPromise;
    }
    this.startedAtMs = this.nowMs();
    this.stoppedPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
    this.logger.log("bot_start", {
      runId: this.config.runId,
      botId: this.config.botId,
      wsUrl: this.config.wsUrl,
      originX: this.config.originX,
      originY: this.config.originY,
      readonly: this.config.readonly,
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
    this.logger.log("bot_stopping", {
      runId: this.config.runId,
      botId: this.config.botId,
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
    const wsUrl = buildSocketUrl(this.config.wsUrl, this.currentToken);
    this.metrics.markConnectAttempt(this.nowMs());
    this.logger.log("ws_connect_attempt", {
      runId: this.config.runId,
      botId: this.config.botId,
      wsUrl,
    });
    const socket = this.wsFactory(wsUrl);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.stopping) {
        return;
      }
      this.connectOpenedAtMs = this.nowMs();
      this.logger.log("ws_open", {
        runId: this.config.runId,
        botId: this.config.botId,
      });
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.stopping) {
        return;
      }
      const payload = toUint8Array(event.data);
      if (!payload) {
        this.logger.log("bad_server_payload", {
          runId: this.config.runId,
          botId: this.config.botId,
          type: typeof event.data,
        });
        return;
      }
      try {
        const message = decodeServerMessageBinary(payload);
        this.#handleServerMessage(message);
      } catch (error) {
        this.metrics.markError("bad_server_message");
        this.logger.log("bad_server_message", {
          runId: this.config.runId,
          botId: this.config.botId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.metrics.markClose();
      this.logger.log("ws_close", {
        runId: this.config.runId,
        botId: this.config.botId,
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
      this.logger.log("ws_error", {
        runId: this.config.runId,
        botId: this.config.botId,
      });
    });

    this.socket = socket;
  }

  #handleServerMessage(message) {
    this.logger.log("server_message", {
      runId: this.config.runId,
      botId: this.config.botId,
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
        };
        this.logger.log("hello_received", {
          runId: this.config.runId,
          botId: this.config.botId,
          uid: message.uid,
          name: message.name,
          shard: this.identity.shard,
          hasSpawn: Boolean(message.spawn),
        });
        this.#sendSubscribe();
        this.#startActionLoops();
        return;
      case "subAck":
        this.metrics.markSubscribeAck(message.cid, this.nowMs());
        this.logger.log("sub_ack", {
          runId: this.config.runId,
          botId: this.config.botId,
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
          this.#logResolvedPendingCell(message.tile, index, "cellUpBatch", this.#getLocalCellValue(message.tile, index), message.toVer);
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
        this.logger.log("server_error", {
          runId: this.config.runId,
          botId: this.config.botId,
          code: message.code,
          msg: message.msg,
          ...(typeof message.trace === "string" ? { trace: message.trace } : {}),
        });
        return;
      default:
        return;
    }
  }

  #sendSubscribe() {
    const cid = this.#nextCid("sub");
    const tile = worldToTileKey(this.config.originX, this.config.originY);
    this.metrics.markSubscribeSent(cid, this.nowMs());
    this.#send({
      t: "sub",
      cid,
      tiles: [tile],
    });
    this.logger.log("sub_sent", {
      runId: this.config.runId,
      botId: this.config.botId,
      cid,
      tile,
    });
  }

  #startActionLoops() {
    this.#clearActionTimers();
    this.#scheduleNextCursor();
    if (!this.config.readonly && this.config.setCellIntervalMs > 0) {
      this.#scheduleNextSetCell();
    }
  }

  #scheduleNextCursor() {
    this.cursorTimer = this.setTimeoutFn(() => {
      this.cursorTimer = null;
      this.#sendCursor();
      if (!this.stopping && this.socket) {
        this.#scheduleNextCursor();
      }
    }, this.config.cursorIntervalMs);
  }

  #scheduleNextSetCell() {
    this.setCellTimer = this.setTimeoutFn(() => {
      this.setCellTimer = null;
      this.#sendSetCell();
      if (!this.stopping && this.socket) {
        this.#scheduleNextSetCell();
      }
    }, this.config.setCellIntervalMs);
  }

  #sendCursor() {
    const sequence = this.sequence.cursor;
    this.sequence.cursor += 1;
    const point = cursorPointForStep(this.config.originX, this.config.originY, sequence);
    if (this.firstLocalCursorSentAtMs === null) {
      this.firstLocalCursorSentAtMs = this.nowMs();
    }
    this.metrics.markCursorSent();
    this.#send({
      t: "cur",
      x: point.x,
      y: point.y,
    });
    this.logger.log("cursor_sent", {
      runId: this.config.runId,
      botId: this.config.botId,
      x: point.x,
      y: point.y,
      sequence,
    });
  }

  #sendSetCell() {
    const sequence = this.sequence.setCell;
    this.sequence.setCell += 1;
    const worldPoint = setCellPointForStep(this.config.originX, this.config.originY, sequence);
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
    this.logger.log("setcell_sent", {
      runId: this.config.runId,
      botId: this.config.botId,
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
      reason,
      originX: this.config.originX,
      originY: this.config.originY,
      readonly: this.config.readonly,
      identity: this.identity,
      shard: this.identity?.shard ?? null,
      durationMs: this.startedAtMs === null ? null : this.nowMs() - this.startedAtMs,
    });
    fs.mkdirSync(path.dirname(this.config.summaryOutput), { recursive: true });
    fs.writeFileSync(this.config.summaryOutput, `${JSON.stringify(summary, null, 2)}\n`);
    this.logger.log("bot_summary", summary);
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
      this.logger.log("setcell_confirmed", {
        runId: this.config.runId,
        botId: this.config.botId,
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
    this.logger.log("setcell_confirmed", {
      runId: this.config.runId,
      botId: this.config.botId,
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
}

function cursorPointForStep(originX, originY, step) {
  const pattern = [
    { x: 0, y: 0 },
    { x: 1.25, y: 0.75 },
    { x: 2.0, y: 1.5 },
    { x: 0.5, y: 2.25 },
    { x: -0.75, y: 1.5 },
    { x: -1.5, y: 0.25 },
  ];
  const point = pattern[step % pattern.length];
  return {
    x: originX + point.x,
    y: originY + point.y,
  };
}

function setCellPointForStep(originX, originY, step) {
  const pattern = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ];
  const point = pattern[step % pattern.length];
  return {
    x: Math.floor(originX) + point.x,
    y: Math.floor(originY) + point.y,
  };
}
