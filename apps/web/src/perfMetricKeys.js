export const PERF_COUNTER = Object.freeze({
  FRAME_TOTAL: "frame.total",
  FRAME_PATCH: "frame.patch",
  FRAME_SKIP: "frame.skip",
  FRAME_FULL: "frame.full",
  WS_RX_COUNT: "ws.rx_count",
  WS_RX_BYTES: "ws.rx_bytes",
  WS_TX_COUNT: "ws.tx_count",
  WS_TX_BYTES: "ws.tx_bytes",
  WEBGL_CONTEXT_LOST: "webgl.context_lost",
  WEBGL_CONTEXT_RESTORED: "webgl.context_restored",
});

export const PERF_TIMING = Object.freeze({
  HEAT_DECAY_MS: "heat.decay_ms",
  CURSOR_SMOOTH_MS: "cursor.smooth_ms",
  CURSOR_DIRTY_INDEX_MS: "cursor.dirty_index_ms",
  SUBSCRIPTIONS_SYNC_MS: "subscriptions.sync_ms",
  RENDER_PATCH_MS: "render.patch_ms",
  RENDER_FULL_MS: "render.full_ms",
  CURSOR_LABELS_MS: "cursor.labels_ms",
  PROTOCOL_DECODE_MS: "protocol.decode_ms",
  PROTOCOL_ENCODE_MS: "protocol.encode_ms",
});

export const PERF_GAUGE = Object.freeze({
  CURSOR_COUNT: "cursor.count",
  DIRTY_TILE_COUNT: "dirty.tile_count",
});
