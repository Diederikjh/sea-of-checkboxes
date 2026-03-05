import {
  isTileCoordInBounds,
  parseTileKeyStrict,
} from "@sea/domain";

import type { ExternalIdentityVerifier } from "./auth/contracts";

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
  waitUntil?(promise: Promise<unknown>): void;
}

export interface R2ObjectBodyLike {
  text(): Promise<string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: string): Promise<void>;
}

export interface KvPutOptions {
  expirationTtl?: number;
}

export interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KvPutOptions): Promise<void>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  CONNECTION_SHARD: DurableObjectNamespaceLike;
  TILE_OWNER: DurableObjectNamespaceLike;
  CURSOR_HUB?: DurableObjectNamespaceLike;
  ACCOUNT_LINK?: DurableObjectNamespaceLike;
  TILE_SNAPSHOTS?: R2BucketLike;
  SHARE_LINKS?: KvNamespaceLike;
  IDENTITY_SIGNING_SECRET?: string;
  FIREBASE_PROJECT_ID?: string;
  AUTH_MODE?: string;
  WS_DISABLED?: string;
  EXTERNAL_IDENTITY_VERIFIER?: ExternalIdentityVerifier;
}

export interface ConnectionIdentity {
  uid: string;
  name: string;
  token: string;
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
  shard?: string;
  uid?: string;
  name?: string;
  atMs?: number;
}

export interface TileSetCellResponse {
  accepted: boolean;
  changed: boolean;
  ver: number;
  reason?: string;
  watcherCount?: number;
}

export interface TileOpsSinceResponse {
  tile: string;
  fromVer: number;
  toVer: number;
  currentVer: number;
  gap: boolean;
  ops: Array<[number, 0 | 1]>;
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
