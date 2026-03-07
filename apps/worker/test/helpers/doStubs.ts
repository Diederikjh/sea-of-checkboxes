import { TILE_ENCODING } from "@sea/domain";
import {
  createEmptyTileState,
  encodeRle64,
} from "@sea/protocol";

import type {
  TileSetCellRequest,
  TileWatchRequest,
} from "../../src/doCommon";

interface DurableObjectStubLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

interface RecordedRequest {
  request: Request;
  body: string;
}

function toRequest(input: Request | string, init?: RequestInit): Request {
  return typeof input === "string" ? new Request(input, init) : input;
}

export class StubNamespace<TStub extends DurableObjectStubLike> {
  readonly stubs: Map<string, TStub>;
  readonly requestedNames: string[];
  #factory: (name: string) => TStub;

  constructor(factory: (name: string) => TStub) {
    this.stubs = new Map();
    this.requestedNames = [];
    this.#factory = factory;
  }

  getByName(name: string): TStub {
    this.requestedNames.push(name);
    let stub = this.stubs.get(name);
    if (!stub) {
      stub = this.#factory(name);
      this.stubs.set(name, stub);
    }
    return stub;
  }
}

export class RecordingDurableObjectStub implements DurableObjectStubLike {
  readonly name: string;
  readonly requests: RecordedRequest[];
  #defaultStatus: number;
  #neverResolvePaths: Set<string>;
  #errorByPath: Map<string, Error>;
  #statusByPath: Map<string, number>;
  #jsonResponseByPath: Map<string, { status: number; body: string }>;

  constructor(name: string, options: { defaultStatus?: number } = {}) {
    this.name = name;
    this.requests = [];
    this.#defaultStatus = options.defaultStatus ?? 204;
    this.#neverResolvePaths = new Set();
    this.#errorByPath = new Map();
    this.#statusByPath = new Map();
    this.#jsonResponseByPath = new Map();
  }

  setNeverResolvePath(pathname: string, enabled: boolean): void {
    if (enabled) {
      this.#neverResolvePaths.add(pathname);
      return;
    }
    this.#neverResolvePaths.delete(pathname);
  }

  setPathStatus(pathname: string, status: number): void {
    this.#statusByPath.set(pathname, status);
  }

  setPathError(pathname: string, error: Error | null): void {
    if (!error) {
      this.#errorByPath.delete(pathname);
      return;
    }
    this.#errorByPath.set(pathname, error);
  }

  setJsonPathResponse(pathname: string, body: unknown, status: number = 200): void {
    this.#jsonResponseByPath.set(pathname, {
      status,
      body: JSON.stringify(body),
    });
  }

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = toRequest(input, init);
    const body = await request.text();
    const method = request.method.toUpperCase();
    const requestInit: RequestInit = {
      method,
      headers: new Headers(request.headers),
    };
    if (method !== "GET" && method !== "HEAD" && body.length > 0) {
      requestInit.body = body;
    }
    const recorded = new Request(request.url, requestInit);
    this.requests.push({
      request: recorded,
      body,
    });

    const url = new URL(request.url);
    if (this.#neverResolvePaths.has(url.pathname)) {
      return new Promise<Response>(() => {});
    }

    const configuredError = this.#errorByPath.get(url.pathname);
    if (configuredError) {
      throw configuredError;
    }

    const jsonResponse = this.#jsonResponseByPath.get(url.pathname);
    if (jsonResponse) {
      return new Response(jsonResponse.body, {
        status: jsonResponse.status,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    return new Response(null, {
      status: this.#statusByPath.get(url.pathname) ?? this.#defaultStatus,
    });
  }
}

interface TileSnapshotMessage {
  t: "tileSnap";
  tile: string;
  ver: number;
  enc: typeof TILE_ENCODING;
  bits: string;
}

export class TileOwnerDurableObjectStub implements DurableObjectStubLike {
  readonly name: string;
  readonly requests: RecordedRequest[];
  readonly watchRequests: TileWatchRequest[];
  readonly setCellRequests: TileSetCellRequest[];
  #errorByPath: Map<string, Error>;
  #versions: Map<string, number>;
  #watchersByTile: Map<string, Set<string>>;
  #encodedEmptyBits: string;
  #opsByTile: Map<string, Array<{ ver: number; i: number; v: 0 | 1 }>>;
  #opsHistoryLimit: number;

  constructor(name: string) {
    this.name = name;
    this.requests = [];
    this.watchRequests = [];
    this.setCellRequests = [];
    this.#errorByPath = new Map();
    this.#versions = new Map();
    this.#watchersByTile = new Map();
    this.#encodedEmptyBits = encodeRle64(createEmptyTileState().bits);
    this.#opsByTile = new Map();
    this.#opsHistoryLimit = 2_048;
  }

  setOpsHistoryLimit(limit: number): void {
    this.#opsHistoryLimit = Math.max(1, Math.floor(limit));
  }

  injectOp(tile: string, i: number, v: 0 | 1): number {
    const next = (this.#versions.get(tile) ?? 0) + 1;
    this.#versions.set(tile, next);
    this.#recordOp(tile, next, i, v);
    return next;
  }

  setPathError(pathname: string, error: Error | null): void {
    if (!error) {
      this.#errorByPath.delete(pathname);
      return;
    }
    this.#errorByPath.set(pathname, error);
  }

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = toRequest(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    const method = request.method.toUpperCase();
    const requestInit: RequestInit = {
      method,
      headers: new Headers(request.headers),
    };
    if (method !== "GET" && method !== "HEAD" && body.length > 0) {
      requestInit.body = body;
    }
    this.requests.push({
      request: new Request(request.url, requestInit),
      body,
    });

    const configuredError = this.#errorByPath.get(url.pathname);
    if (configuredError) {
      throw configuredError;
    }

    if (url.pathname === "/watch" && request.method === "POST") {
      const payload = JSON.parse(body) as TileWatchRequest;
      this.watchRequests.push(payload);
      let watchers = this.#watchersByTile.get(payload.tile);
      if (!watchers) {
        watchers = new Set();
        this.#watchersByTile.set(payload.tile, watchers);
      }
      if (payload.action === "sub") {
        watchers.add(payload.shard);
      } else {
        watchers.delete(payload.shard);
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/snapshot") {
      const tile = url.searchParams.get("tile");
      if (!tile) {
        return new Response("Missing tile", { status: 400 });
      }

      const snapshot: TileSnapshotMessage = {
        t: "tileSnap",
        tile,
        ver: this.#versions.get(tile) ?? 0,
        enc: TILE_ENCODING,
        bits: this.#encodedEmptyBits,
      };

      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (url.pathname === "/ops-since" && request.method === "GET") {
      const tile = url.searchParams.get("tile");
      const rawFromVer = url.searchParams.get("fromVer");
      const rawLimit = url.searchParams.get("limit");
      if (!tile || !rawFromVer || !/^\d+$/.test(rawFromVer)) {
        return new Response("Invalid tile or fromVer", { status: 400 });
      }

      const fromVer = Number.parseInt(rawFromVer, 10);
      const parsedLimit =
        typeof rawLimit === "string" && /^\d+$/.test(rawLimit)
          ? Number.parseInt(rawLimit, 10)
          : 256;
      const limit = Math.max(1, Math.min(1_024, parsedLimit));
      const currentVer = this.#versions.get(tile) ?? 0;
      const history = this.#opsByTile.get(tile) ?? [];
      const firstKnown = history[0];
      const gap = currentVer > fromVer && (!firstKnown || fromVer + 1 < firstKnown.ver);

      const selected = gap
        ? []
        : history
            .filter((entry) => entry.ver > fromVer)
            .slice(0, limit);
      const toVer = selected.length > 0 ? selected[selected.length - 1]!.ver : (gap ? currentVer : fromVer);

      return new Response(
        JSON.stringify({
          tile,
          fromVer,
          toVer,
          currentVer,
          gap,
          ops: selected.map((entry) => [entry.i, entry.v]),
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      );
    }

    if (url.pathname === "/setCell" && request.method === "POST") {
      const payload = JSON.parse(body) as TileSetCellRequest;
      this.setCellRequests.push(payload);
      const current = this.#versions.get(payload.tile) ?? 0;
      const next = current + 1;
      this.#versions.set(payload.tile, next);
      this.#recordOp(payload.tile, next, payload.i, payload.v);
      const watcherCount = this.#watchersByTile.get(payload.tile)?.size ?? 0;

      return new Response(
        JSON.stringify({
          accepted: true,
          changed: true,
          ver: next,
          watcherCount,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      );
    }

    return new Response("Not found", { status: 404 });
  }

  #recordOp(tile: string, ver: number, i: number, v: 0 | 1): void {
    let ops = this.#opsByTile.get(tile);
    if (!ops) {
      ops = [];
      this.#opsByTile.set(tile, ops);
    }

    ops.push({ ver, i, v });
    if (ops.length <= this.#opsHistoryLimit) {
      return;
    }

    const overflow = ops.length - this.#opsHistoryLimit;
    if (overflow > 0) {
      ops.splice(0, overflow);
    }
  }
}
