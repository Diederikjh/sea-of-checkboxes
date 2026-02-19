import type { ServerMessage } from "@sea/protocol";

import {
  readJson,
  type DurableObjectNamespaceLike,
  type TileSetCellRequest,
  type TileSetCellResponse,
  type TileWatchRequest,
} from "./doCommon";

interface ConnectionShardTileGatewayOptions {
  tileOwnerNamespace: DurableObjectNamespaceLike;
  getCurrentShardName: () => string;
}

export class ConnectionShardTileGateway {
  #tileOwnerNamespace: DurableObjectNamespaceLike;
  #getCurrentShardName: () => string;

  constructor(options: ConnectionShardTileGatewayOptions) {
    this.#tileOwnerNamespace = options.tileOwnerNamespace;
    this.#getCurrentShardName = options.getCurrentShardName;
  }

  async watchTile(tileKey: string, action: "sub" | "unsub"): Promise<void> {
    const payload: TileWatchRequest = {
      tile: tileKey,
      shard: this.#getCurrentShardName(),
      action,
    };

    await this.#tileOwnerStub(tileKey).fetch("https://tile-owner.internal/watch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  async fetchSnapshot(tileKey: string): Promise<Extract<ServerMessage, { t: "tileSnap" }> | null> {
    const response = await this.#tileOwnerStub(tileKey).fetch(
      `https://tile-owner.internal/snapshot?tile=${encodeURIComponent(tileKey)}`
    );

    if (!response.ok) {
      return null;
    }

    return readJson<Extract<ServerMessage, { t: "tileSnap" }>>(response);
  }

  async setTileCell(payload: TileSetCellRequest): Promise<TileSetCellResponse | null> {
    const response = await this.#tileOwnerStub(payload.tile).fetch("https://tile-owner.internal/setCell", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return null;
    }

    return readJson<TileSetCellResponse>(response);
  }

  #tileOwnerStub(tileKey: string) {
    return this.#tileOwnerNamespace.getByName(tileKey);
  }
}
