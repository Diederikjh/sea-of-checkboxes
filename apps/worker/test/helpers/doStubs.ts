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

  constructor(name: string, options: { defaultStatus?: number } = {}) {
    this.name = name;
    this.requests = [];
    this.#defaultStatus = options.defaultStatus ?? 204;
    this.#neverResolvePaths = new Set();
  }

  setNeverResolvePath(pathname: string, enabled: boolean): void {
    if (enabled) {
      this.#neverResolvePaths.add(pathname);
      return;
    }
    this.#neverResolvePaths.delete(pathname);
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

    return new Response(null, { status: this.#defaultStatus });
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
  readonly watchRequests: TileWatchRequest[];
  readonly setCellRequests: TileSetCellRequest[];
  #versions: Map<string, number>;
  #watchersByTile: Map<string, Set<string>>;
  #encodedEmptyBits: string;

  constructor(name: string) {
    this.name = name;
    this.watchRequests = [];
    this.setCellRequests = [];
    this.#versions = new Map();
    this.#watchersByTile = new Map();
    this.#encodedEmptyBits = encodeRle64(createEmptyTileState().bits);
  }

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = toRequest(input, init);
    const url = new URL(request.url);
    const body = await request.text();

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

    if (url.pathname === "/setCell" && request.method === "POST") {
      const payload = JSON.parse(body) as TileSetCellRequest;
      this.setCellRequests.push(payload);
      const current = this.#versions.get(payload.tile) ?? 0;
      const next = current + 1;
      this.#versions.set(payload.tile, next);
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
}
