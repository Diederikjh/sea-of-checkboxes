import { TILE_CELL_COUNT } from "@sea/domain";
import {
  decodeRle64,
  type ServerMessage,
} from "@sea/protocol";

import {
  isValidTileKey,
  jsonResponse,
  readJson,
  type DurableObjectStateLike,
  type Env,
  type TileSetCellRequest,
  type TileSetCellResponse,
  type TileWatchRequest,
} from "./doCommon";
import { TileOwner } from "./local/tileOwner";

const TILE_READONLY_WATCHER_THRESHOLD = 8;
const TILE_DENY_WATCHER_THRESHOLD = 12;

export class TileOwnerDO {
  #state: DurableObjectStateLike;
  #env: Env;
  #tileOwner: TileOwner;
  #tileKey: string | null;
  #subscriberShards: Set<string>;
  #loaded: boolean;

  constructor(state: DurableObjectStateLike, env: Env) {
    this.#state = state;
    this.#env = env;
    this.#tileOwner = new TileOwner("0:0");
    this.#tileKey = null;
    this.#subscriberShards = new Set();
    this.#loaded = false;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/watch" && request.method === "POST") {
      const payload = await readJson<TileWatchRequest>(request);
      if (!payload || !isValidTileKey(payload.tile)) {
        return new Response("Invalid watch payload", { status: 400 });
      }

      await this.#ensureLoaded(payload.tile);
      if (payload.action === "sub") {
        const alreadySubscribed = this.#subscriberShards.has(payload.shard);
        if (!alreadySubscribed && this.#subscriberShards.size >= TILE_DENY_WATCHER_THRESHOLD) {
          return jsonResponse(
            {
              code: "tile_sub_denied",
              msg: "Tile is oversubscribed; new subscriptions are temporarily denied",
            },
            { status: 429 }
          );
        }
        this.#subscriberShards.add(payload.shard);
      } else {
        this.#subscriberShards.delete(payload.shard);
      }
      await this.#persistSubscribers();

      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/snapshot") {
      const tileKey = url.searchParams.get("tile");
      if (!tileKey || !isValidTileKey(tileKey)) {
        return new Response("Invalid tile", { status: 400 });
      }

      await this.#ensureLoaded(tileKey);
      return jsonResponse(this.#tileOwner.getSnapshotMessage());
    }

    if (url.pathname === "/setCell" && request.method === "POST") {
      const payload = await readJson<TileSetCellRequest>(request);
      if (!payload || !isValidTileKey(payload.tile)) {
        return new Response("Invalid setCell payload", { status: 400 });
      }

      await this.#ensureLoaded(payload.tile);

      if (this.#subscriberShards.size >= TILE_READONLY_WATCHER_THRESHOLD) {
        return jsonResponse({
          accepted: false,
          changed: false,
          ver: this.#tileOwner.getVersion(),
          reason: "tile_readonly_hot",
        } satisfies TileSetCellResponse);
      }

      const result = this.#tileOwner.applySetCell({
        i: payload.i,
        v: payload.v,
        op: payload.op,
      });

      if (result.changed) {
        await this.#persistSnapshot();

        const batch: Extract<ServerMessage, { t: "cellUpBatch" }> = {
          t: "cellUpBatch",
          tile: payload.tile,
          fromVer: result.ver,
          toVer: result.ver,
          ops: [[payload.i, payload.v]],
        };

        // Do not await fanout here to avoid circular waits:
        // shard -> tile owner -> shard (same shard may be in subscribers).
        void Promise.all(
          Array.from(this.#subscriberShards).map(async (shardId) => {
            const stub = this.#env.CONNECTION_SHARD.getByName(shardId);
            await stub.fetch("https://connection-shard.internal/tile-batch", {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify(batch),
            });
          })
        ).catch(() => {
          // Best-effort fanout; requester still gets a successful setCell response.
        });
      }

      const body: TileSetCellResponse = result.reason
        ? {
            accepted: result.accepted,
            changed: result.changed,
            ver: result.ver,
            reason: result.reason,
          }
        : {
            accepted: result.accepted,
            changed: result.changed,
            ver: result.ver,
          };

      return jsonResponse(body);
    }

    return new Response("Not found", { status: 404 });
  }

  #setTileKey(tileKey: string): void {
    if (this.#tileKey === tileKey) {
      return;
    }

    this.#tileKey = tileKey;
    this.#tileOwner = new TileOwner(tileKey);
    this.#subscriberShards.clear();
    this.#loaded = false;
  }

  async #ensureLoaded(tileKey: string): Promise<void> {
    this.#setTileKey(tileKey);
    if (this.#loaded) {
      return;
    }

    const persisted = await this.#state.storage.get<{ bits: string; ver: number }>("snapshot");
    if (persisted) {
      const bits = decodeRle64(persisted.bits, TILE_CELL_COUNT);
      this.#tileOwner.loadSnapshot(bits, persisted.ver);
    }

    const subscribers = await this.#state.storage.get<string[]>("subscribers");
    if (Array.isArray(subscribers)) {
      for (const shard of subscribers) {
        if (typeof shard === "string" && shard.length > 0) {
          this.#subscriberShards.add(shard);
        }
      }
    }

    this.#loaded = true;
  }

  async #persistSnapshot(): Promise<void> {
    const snapshot = this.#tileOwner.getSnapshotMessage();
    await this.#state.storage.put("snapshot", {
      bits: snapshot.bits,
      ver: snapshot.ver,
    });
  }

  async #persistSubscribers(): Promise<void> {
    await this.#state.storage.put("subscribers", Array.from(this.#subscriberShards));
  }
}
