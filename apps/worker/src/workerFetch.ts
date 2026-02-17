import {
  isWebSocketUpgrade,
  jsonResponse,
  type Env,
} from "./doCommon";

const SHARD_COUNT = 8;
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

function shardNameForUid(uid: string): string {
  let hash = 2166136261;
  for (let index = 0; index < uid.length; index += 1) {
    hash ^= uid.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const shard = Math.abs(hash) % SHARD_COUNT;
  return `shard-${shard}`;
}

export async function handleWorkerFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return jsonResponse({
      ok: true,
      ws: "/ws",
    });
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
