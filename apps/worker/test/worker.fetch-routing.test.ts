import { describe, expect, it } from "vitest";

import { handleWorkerFetch } from "../src/workerFetch";

class RecordingStub {
  readonly requests: Request[];
  readonly status: number;

  constructor(status = 204) {
    this.requests = [];
    this.status = status;
  }

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = typeof input === "string" ? new Request(input, init) : input;
    this.requests.push(request);
    return new Response(null, { status: this.status });
  }
}

class RecordingNamespace {
  readonly stubs: Map<string, RecordingStub>;
  readonly requestedNames: string[];

  constructor() {
    this.stubs = new Map();
    this.requestedNames = [];
  }

  getByName(name: string): RecordingStub {
    this.requestedNames.push(name);
    let stub = this.stubs.get(name);
    if (!stub) {
      stub = new RecordingStub(204);
      this.stubs.set(name, stub);
    }
    return stub;
  }
}

function createEnv() {
  const connectionShard = new RecordingNamespace();
  const tileOwner = new RecordingNamespace();
  return {
    env: {
      CONNECTION_SHARD: connectionShard,
      TILE_OWNER: tileOwner,
    },
    connectionShard,
  };
}

describe("top-level worker fetch routing", () => {
  it("returns health payload on /health", async () => {
    const { env } = createEnv();
    const response = await handleWorkerFetch(new Request("https://worker.local/health"), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ws: "/ws",
    });
  });

  it("returns 404 for unknown paths", async () => {
    const { env } = createEnv();
    const response = await handleWorkerFetch(new Request("https://worker.local/unknown"), env);
    expect(response.status).toBe(404);
  });

  it("rejects /ws when upgrade header is missing", async () => {
    const { env } = createEnv();
    const response = await handleWorkerFetch(new Request("https://worker.local/ws"), env);
    expect(response.status).toBe(426);
  });

  it("forwards websocket requests to selected shard with uid/name/shard params", async () => {
    const { env, connectionShard } = createEnv();
    const response = await handleWorkerFetch(
      new Request("https://worker.local/ws", {
        headers: {
          upgrade: "websocket",
          "x-trace-id": "trace_123",
        },
      }),
      env
    );

    expect(response.status).toBe(204);
    expect(connectionShard.requestedNames.length).toBe(1);

    const shardName = connectionShard.requestedNames[0];
    if (!shardName) {
      throw new Error("Expected shard name");
    }
    expect(shardName).toMatch(/^shard-\d+$/);

    const stub = connectionShard.stubs.get(shardName);
    expect(stub).toBeDefined();
    expect(stub?.requests.length).toBe(1);

    const forwarded = stub?.requests[0];
    if (!forwarded) {
      throw new Error("Missing forwarded request");
    }

    const forwardedUrl = new URL(forwarded.url);
    expect(forwardedUrl.pathname).toBe("/ws");

    const uid = forwardedUrl.searchParams.get("uid");
    const name = forwardedUrl.searchParams.get("name");
    const forwardedShard = forwardedUrl.searchParams.get("shard");

    expect(uid).toMatch(/^u_[0-9a-f]{8}$/);
    expect(name).toMatch(/^[A-Za-z]+\d{3}$/);
    expect(forwardedShard).toBe(shardName);

    expect(forwarded.method).toBe("GET");
    expect(forwarded.headers.get("upgrade")).toBe("websocket");
    expect(forwarded.headers.get("x-trace-id")).toBe("trace_123");
  });
});
