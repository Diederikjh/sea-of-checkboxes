import type { ServerMessage } from "@sea/protocol";

import {
  readJson,
  type DurableObjectNamespaceLike,
  type TileSetCellRequest,
  type TileSetCellResponse,
  type TileWatchRequest,
} from "./doCommon";

export interface ConnectionShardTileGateway {
  watchTile(
    tileKey: string,
    action: "sub" | "unsub",
    shard: string
  ): Promise<{ ok: boolean; code?: string; msg?: string } | void>;
  fetchSnapshot(tileKey: string): Promise<Extract<ServerMessage, { t: "tileSnap" }> | null>;
  setTileCell(payload: TileSetCellRequest): Promise<TileSetCellResponse | null>;
}

export function createConnectionShardTileGateway(
  tileOwnerNamespace: DurableObjectNamespaceLike
): ConnectionShardTileGateway {
  return {
    watchTile: async (tileKey, action, shard) => {
      const payload: TileWatchRequest = {
        tile: tileKey,
        shard,
        action,
      };

      const response = await tileOwnerNamespace.getByName(tileKey).fetch("https://tile-owner.internal/watch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return { ok: true };
      }

      const errorBody = await readJson<{ code?: string; msg?: string }>(response);
      return {
        ok: false,
        code: errorBody?.code ?? "watch_rejected",
        msg: errorBody?.msg ?? `Watch request failed (${response.status})`,
      };
    },

    fetchSnapshot: async (tileKey) => {
      const response = await tileOwnerNamespace
        .getByName(tileKey)
        .fetch(`https://tile-owner.internal/snapshot?tile=${encodeURIComponent(tileKey)}`);

      if (!response.ok) {
        return null;
      }

      return readJson<Extract<ServerMessage, { t: "tileSnap" }>>(response);
    },

    setTileCell: async (payload) => {
      const response = await tileOwnerNamespace.getByName(payload.tile).fetch("https://tile-owner.internal/setCell", {
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
    },
  };
}
