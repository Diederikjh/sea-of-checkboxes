import {
  isTileCoordInBounds,
  parseTileKeyStrict,
} from "@sea/domain";

export interface DurableObjectStubLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  getByName(name: string): DurableObjectStubLike;
}

export interface DurableObjectStateLike {
  id: { toString(): string };
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
}

export interface R2ObjectBodyLike {
  text(): Promise<string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: string): Promise<void>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  CONNECTION_SHARD: DurableObjectNamespaceLike;
  TILE_OWNER: DurableObjectNamespaceLike;
  TILE_SNAPSHOTS?: R2BucketLike;
}

export interface TileWatchRequest {
  tile: string;
  shard: string;
  action: "sub" | "unsub";
}

export interface TileSetCellRequest {
  tile: string;
  i: number;
  v: 0 | 1;
  op: string;
  uid?: string;
  name?: string;
  atMs?: number;
}

export interface TileSetCellResponse {
  accepted: boolean;
  changed: boolean;
  ver: number;
  reason?: string;
}

export interface CellLastEditInfo {
  uid: string;
  name: string;
  atMs: number;
}

export interface CellLastEditRecord extends CellLastEditInfo {
  i: number;
}

export interface TileCellLastEditResponse {
  tile: string;
  i: number;
  edit: CellLastEditInfo | null;
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export function isValidTileKey(tileKey: string): boolean {
  const parsed = parseTileKeyStrict(tileKey);
  return parsed !== null && isTileCoordInBounds(parsed.tx, parsed.ty);
}

export async function readJson<T>(value: { json: () => Promise<unknown> }): Promise<T | null> {
  try {
    return (await value.json()) as T;
  } catch {
    return null;
  }
}
