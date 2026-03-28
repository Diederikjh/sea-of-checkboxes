import { parseTileKeyStrict, worldFromTileCell } from "@sea/domain";

import type { ConnectionShardCursorHubGateway } from "./cursorHubGateway";

export interface ConnectionShardCursorHubActivityOptions {
  gateway: ConnectionShardCursorHubGateway | null;
  currentShardName: () => string;
  nowMs: () => number;
  deferDetachedTask: (task: () => Promise<void>) => void;
}

export class ConnectionShardCursorHubActivity {
  #gateway: ConnectionShardCursorHubGateway | null;
  #currentShardName: () => string;
  #nowMs: () => number;
  #deferDetachedTask: (task: () => Promise<void>) => void;

  constructor(options: ConnectionShardCursorHubActivityOptions) {
    this.#gateway = options.gateway;
    this.#currentShardName = options.currentShardName;
    this.#nowMs = options.nowMs;
    this.#deferDetachedTask = options.deferDetachedTask;
  }

  async resolveHelloSpawn(): Promise<{ x: number; y: number } | null> {
    if (!this.#gateway) {
      return null;
    }

    try {
      const sample = await this.#gateway.sampleSpawnPoint();
      if (!sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) {
        return null;
      }

      return {
        x: sample.x,
        y: sample.y,
      };
    } catch {
      return null;
    }
  }

  recordRecentEditActivity(tileKey: string, index: number): void {
    if (!this.#gateway) {
      return;
    }

    const parsed = parseTileKeyStrict(tileKey);
    if (!parsed) {
      return;
    }

    let world;
    try {
      world = worldFromTileCell(parsed.tx, parsed.ty, index);
    } catch {
      return;
    }

    const x = world.x + 0.5;
    const y = world.y + 0.5;
    this.#deferDetachedTask(async () => {
      try {
        await this.#gateway?.publishRecentEdit({
          from: this.#currentShardName(),
          x,
          y,
          atMs: this.#nowMs(),
        });
      } catch {
        // Activity publication is best-effort.
      }
    });
  }
}
