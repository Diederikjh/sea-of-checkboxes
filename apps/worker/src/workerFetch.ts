import {
  isCellIndexValid,
  normalizeIdentity,
} from "@sea/domain";

import {
  isWebSocketUpgrade,
  isValidTileKey,
  jsonResponse,
  type Env,
} from "./doCommon";
import { shardNameForUid } from "./sharding";
const NAME_ADJECTIVES = ["Brisk", "Quiet", "Amber", "Mint", "Rust", "Blue"];
const NAME_NOUNS = ["Otter", "Falcon", "Badger", "Stoat", "Fox", "Heron"];
const CELL_LAST_EDIT_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

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

function resolveIdentity(url: URL): { uid: string; name: string } {
  const requestedIdentity = normalizeIdentity({
    uid: url.searchParams.get("uid"),
    name: url.searchParams.get("name"),
  });
  if (requestedIdentity) {
    return requestedIdentity;
  }

  return {
    uid: generateUid(),
    name: generateName(),
  };
}

function withCellLastEditCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CELL_LAST_EDIT_CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cellLastEditCorsPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: CELL_LAST_EDIT_CORS_HEADERS,
  });
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
      return withCellLastEditCors(new Response("Invalid tile or cell index", { status: 400 }));
    }

    const index = Number.parseInt(rawIndex, 10);
    if (!isCellIndexValid(index)) {
      return withCellLastEditCors(new Response("Invalid tile or cell index", { status: 400 }));
    }

    const response = await env.TILE_OWNER.getByName(tileKey).fetch(
      `https://tile-owner.internal/cell-last-edit?tile=${encodeURIComponent(tileKey)}&i=${index}`
    );
    return withCellLastEditCors(response);
  }

  if (url.pathname === "/cell-last-edit" && request.method === "OPTIONS") {
    return cellLastEditCorsPreflightResponse();
  }

  if (url.pathname !== "/ws") {
    return new Response("Not found", { status: 404 });
  }

  if (!isWebSocketUpgrade(request)) {
    return new Response("Expected websocket upgrade", { status: 426 });
  }

  const { uid, name } = resolveIdentity(url);
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
