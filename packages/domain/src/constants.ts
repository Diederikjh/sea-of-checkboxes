export const TILE_SIZE = 64;
export const TILE_CELL_COUNT = TILE_SIZE * TILE_SIZE;

export const MIN_CELL_PX = 4;
export const EDIT_MIN_CELL_PX = 8;

export const WORLD_MAX = 1_000_000_000;
export const MAX_TILE_ABS = Math.floor(WORLD_MAX / TILE_SIZE);

export const HEAT_BUMP = 0.15;
export const HEAT_TAU_SECONDS = 10;
export const HOT_DISABLE_THRESHOLD = 0.8;
export const HOT_DISABLE_MS = 1_000;

export const MAX_TILES_SUBSCRIBED = 300;
export const MAX_TILE_CHURN_PER_MIN = 600;
export const MAX_REMOTE_CURSORS = 10;
export const SETCELL_BURST_PER_SEC = 20;
export const SETCELL_SUSTAINED_PER_SEC = 5;
export const SETCELL_SUSTAINED_WINDOW_MS = 10_000;

export const TILE_ENCODING = "rle64" as const;
