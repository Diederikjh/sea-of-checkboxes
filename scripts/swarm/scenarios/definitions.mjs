export const TILE_SIZE = 64;

export const DEFAULT_SCENARIO_POOL = Object.freeze([
  "spread-editing",
  "read-only-lurker",
]);

export const LEGACY_SCENARIO_ALIASES = Object.freeze({
  "phase1-active": "spread-editing",
});

const SCENARIO_DEFINITIONS = Object.freeze({
  "hot-tile-contention": {
    id: "hot-tile-contention",
    readonly: false,
    originOffset(slot) {
      return {
        x: (slot % 4) * 2,
        y: Math.floor(slot / 4) * 2,
      };
    },
    runtime(config) {
      return {
        id: "hot-tile-contention",
        readonly: Boolean(config.readonly),
        cursorIntervalMs: clampMs(Math.floor(config.cursorIntervalMs * 0.5), 250),
        setCellIntervalMs: config.readonly ? 0 : deriveSetCellInterval(config.setCellIntervalMs, 0.4, 900),
        cursorPattern: "tight-orbit",
        setCellPattern: "hotspot",
        subscribeOffsets: [{ dx: 0, dy: 0 }],
        viewportOffsets: null,
        viewportIntervalMs: null,
        viewportMoveDrainMs: 0,
        viewportMoveRetryMs: 100,
        reconnectBurstDelayMs: null,
      };
    },
  },
  "spread-editing": {
    id: "spread-editing",
    readonly: false,
    originOffset(slot) {
      return {
        x: (slot % 4) * 96,
        y: Math.floor(slot / 4) * 96,
      };
    },
    runtime(config) {
      return {
        id: "spread-editing",
        readonly: Boolean(config.readonly),
        cursorIntervalMs: clampMs(config.cursorIntervalMs, 250),
        setCellIntervalMs: config.readonly ? 0 : deriveSetCellInterval(config.setCellIntervalMs, 1, 900),
        cursorPattern: "orbit",
        setCellPattern: "spread",
        subscribeOffsets: [{ dx: 0, dy: 0 }],
        viewportOffsets: null,
        viewportIntervalMs: null,
        viewportMoveDrainMs: 0,
        viewportMoveRetryMs: 100,
        reconnectBurstDelayMs: null,
      };
    },
  },
  "read-only-lurker": {
    id: "read-only-lurker",
    readonly: true,
    originOffset(slot) {
      return {
        x: (slot % 4) * 2,
        y: (Math.floor(slot / 4) % 2) * 2,
      };
    },
    runtime(config) {
      return {
        id: "read-only-lurker",
        readonly: true,
        cursorIntervalMs: clampMs(config.cursorIntervalMs * 2, 600),
        setCellIntervalMs: 0,
        cursorPattern: "lurker-orbit",
        setCellPattern: "none",
        subscribeOffsets: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }],
        viewportOffsets: null,
        viewportIntervalMs: null,
        viewportMoveDrainMs: 0,
        viewportMoveRetryMs: 100,
        reconnectBurstDelayMs: null,
      };
    },
  },
  "cursor-heavy": {
    id: "cursor-heavy",
    readonly: false,
    originOffset(slot) {
      return {
        x: (slot % 4) * 12,
        y: Math.floor(slot / 4) * 6,
      };
    },
    runtime(config) {
      return {
        id: "cursor-heavy",
        readonly: Boolean(config.readonly),
        cursorIntervalMs: clampMs(Math.floor(config.cursorIntervalMs * 0.25), 150),
        setCellIntervalMs: config.readonly ? 0 : deriveSetCellInterval(config.setCellIntervalMs, 3, 6_000),
        cursorPattern: "figure-eight",
        setCellPattern: "hotspot",
        subscribeOffsets: [{ dx: 0, dy: 0 }],
        viewportOffsets: [
          { dx: 0, dy: 0 },
          { dx: 1, dy: 0 },
          { dx: 0, dy: 0 },
          { dx: -1, dy: 0 },
        ],
        viewportIntervalMs: 10_000,
        viewportMoveDrainMs: 0,
        viewportMoveRetryMs: 100,
        reconnectBurstDelayMs: null,
      };
    },
  },
  "viewport-churn": {
    id: "viewport-churn",
    readonly: false,
    originOffset(slot) {
      return {
        x: (slot % 4) * 128,
        y: Math.floor(slot / 4) * 64,
      };
    },
    runtime(config) {
      return {
        id: "viewport-churn",
        readonly: Boolean(config.readonly),
        cursorIntervalMs: clampMs(config.cursorIntervalMs, 250),
        setCellIntervalMs: config.readonly ? 0 : deriveSetCellInterval(config.setCellIntervalMs, 1.5, 1_200),
        cursorPattern: "orbit",
        setCellPattern: "spread",
        subscribeOffsets: [{ dx: 0, dy: 0 }],
        viewportOffsets: [
          { dx: 0, dy: 0 },
          { dx: 1, dy: 0 },
          { dx: 1, dy: 1 },
          { dx: 0, dy: 1 },
          { dx: -1, dy: 1 },
          { dx: -1, dy: 0 },
          { dx: -1, dy: -1 },
          { dx: 0, dy: -1 },
        ],
        viewportIntervalMs: 5_000,
        viewportMoveDrainMs: 1_500,
        viewportMoveRetryMs: 100,
        reconnectBurstDelayMs: null,
      };
    },
  },
  "reconnect-burst": {
    id: "reconnect-burst",
    readonly: false,
    originOffset(slot) {
      return {
        x: (slot % 4) * 4,
        y: Math.floor(slot / 4) * 4,
      };
    },
    runtime(config) {
      const reconnectBurstDelayMs = config.durationMs < 12_000
        ? null
        : clampMs(Math.floor(config.durationMs * 0.45), 5_000);
      return {
        id: "reconnect-burst",
        readonly: Boolean(config.readonly),
        cursorIntervalMs: clampMs(config.cursorIntervalMs, 250),
        setCellIntervalMs: config.readonly ? 0 : deriveSetCellInterval(config.setCellIntervalMs, 1, 900),
        cursorPattern: "orbit",
        setCellPattern: "hotspot",
        subscribeOffsets: [{ dx: 0, dy: 0 }],
        viewportOffsets: null,
        viewportIntervalMs: null,
        viewportMoveDrainMs: 0,
        viewportMoveRetryMs: 100,
        reconnectBurstDelayMs,
      };
    },
  },
  soak: {
    id: "soak",
    readonly: false,
    originOffset(slot) {
      return {
        x: (slot % 4) * 80,
        y: Math.floor(slot / 4) * 80,
      };
    },
    runtime(config) {
      const reconnectBurstDelayMs = config.durationMs < 30_000
        ? null
        : clampMs(Math.floor(config.durationMs * 0.6), 15_000);
      return {
        id: "soak",
        readonly: Boolean(config.readonly),
        cursorIntervalMs: clampMs(Math.floor(config.cursorIntervalMs * 1.5), 500),
        setCellIntervalMs: config.readonly ? 0 : deriveSetCellInterval(config.setCellIntervalMs, 2, 2_000),
        cursorPattern: "orbit",
        setCellPattern: "spread",
        subscribeOffsets: [{ dx: 0, dy: 0 }],
        viewportOffsets: [
          { dx: 0, dy: 0 },
          { dx: 1, dy: 0 },
          { dx: 1, dy: 1 },
          { dx: 0, dy: 1 },
        ],
        viewportIntervalMs: 15_000,
        viewportMoveDrainMs: 0,
        viewportMoveRetryMs: 100,
        reconnectBurstDelayMs,
      };
    },
  },
});

export function getScenarioDefinition(scenarioId) {
  const definition = SCENARIO_DEFINITIONS[scenarioId];
  if (!definition) {
    throw new Error(`Unknown scenario id: ${scenarioId}`);
  }
  return definition;
}

export function listScenarioDefinitions() {
  return Object.values(SCENARIO_DEFINITIONS);
}

function clampMs(value, minimum) {
  return Math.max(minimum, Math.round(value));
}

function deriveSetCellInterval(baseMs, factor, minimum) {
  if (typeof baseMs !== "number" || baseMs <= 0) {
    return 0;
  }
  return clampMs(Math.floor(baseMs * factor), minimum);
}
