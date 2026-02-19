import { isCellIndexValid } from "@sea/domain";

import {
  isWebSocketUpgrade,
  isValidTileKey,
  jsonResponse,
  type Env,
} from "./doCommon";
import { shardNameForUid } from "./sharding";
const NAME_ADJECTIVES = ["Brisk", "Quiet", "Amber", "Mint", "Rust", "Blue"];
const NAME_NOUNS = ["Otter", "Falcon", "Badger", "Stoat", "Fox", "Heron"];

function generateUid(): string {
  return `u_${crypto.randomUUID().slice(0, 8)}`;
}

function randomFrom<T>(values: T[]): T {
  const index = Math.floor(Math.random() * values.length);
  const value = values[index];
  if (value === undefined) {
    throw new Error("Unable to select random value");
  }
  return value;
}

function generateName(): string {
  const adjective = randomFrom(NAME_ADJECTIVES);
  const noun = randomFrom(NAME_NOUNS);
  const suffix = Math.floor(Math.random() * 1_000)
    .toString()
    .padStart(3, "0");
  return `${adjective}${noun}${suffix}`;
}

export async function handleWorkerFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return jsonResponse({
      ok: true,
      ws: "/ws",
    });
  }

  if (url.pathname === "/cell-last-edit" && request.method === "GET") {
    const tileKey = url.searchParams.get("tile");
    const rawIndex = url.searchParams.get("i");
    if (!tileKey || !isValidTileKey(tileKey) || !rawIndex || !/^\d+$/.test(rawIndex)) {
      return new Response("Invalid tile or cell index", { status: 400 });
    }

    const index = Number.parseInt(rawIndex, 10);
    if (!isCellIndexValid(index)) {
      return new Response("Invalid tile or cell index", { status: 400 });
    }

    return env.TILE_OWNER.getByName(tileKey).fetch(
      `https://tile-owner.internal/cell-last-edit?tile=${encodeURIComponent(tileKey)}&i=${index}`
    );
  }

  if (url.pathname !== "/ws") {
    return new Response("Not found", { status: 404 });
  }

  if (!isWebSocketUpgrade(request)) {
    return new Response("Expected websocket upgrade", { status: 426 });
  }

  const uid = generateUid();
  const name = generateName();
  const shardName = shardNameForUid(uid);

  const shardUrl = new URL("https://connection-shard.internal/ws");
  shardUrl.searchParams.set("uid", uid);
  shardUrl.searchParams.set("name", name);
  shardUrl.searchParams.set("shard", shardName);

  const headers = new Headers(request.headers);
  const shardRequest = new Request(shardUrl.toString(), {
    method: "GET",
    headers,
  });

  const shardStub = env.CONNECTION_SHARD.getByName(shardName);
  return shardStub.fetch(shardRequest);
}
