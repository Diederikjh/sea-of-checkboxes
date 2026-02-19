import { describe, expect, it } from "vitest";

import { handleWorkerFetch } from "../src/workerFetch";
import {
  RecordingDurableObjectStub,
  StubNamespace,
} from "./helpers/doStubs";

function createEnv() {
  const connectionShard = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  const tileOwner = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  return {
    env: {
      CONNECTION_SHARD: connectionShard,
      TILE_OWNER: tileOwner,
    },
    connectionShard,
    tileOwner,
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

  it("forwards cell-last-edit requests to tile owner by tile key", async () => {
    const { env, tileOwner } = createEnv();
    const response = await handleWorkerFetch(
      new Request("https://worker.local/cell-last-edit?tile=2:3&i=17"),
      env
    );

    expect(response.status).toBe(204);
    expect(tileOwner.requestedNames).toEqual(["2:3"]);

    const stub = tileOwner.stubs.get("2:3");
    expect(stub?.requests.length).toBe(1);
    const request = stub?.requests[0]?.request;
    expect(request?.method).toBe("GET");
    const forwardedUrl = new URL(request?.url ?? "https://tile-owner.internal/");
    expect(forwardedUrl.pathname).toBe("/cell-last-edit");
    expect(forwardedUrl.searchParams.get("tile")).toBe("2:3");
    expect(forwardedUrl.searchParams.get("i")).toBe("17");
  });

  it("rejects invalid cell-last-edit requests", async () => {
    const { env, tileOwner } = createEnv();
    const badRequests = [
      "https://worker.local/cell-last-edit",
      "https://worker.local/cell-last-edit?tile=2:3",
      "https://worker.local/cell-last-edit?tile=bad&i=1",
      "https://worker.local/cell-last-edit?tile=2:3&i=-1",
      "https://worker.local/cell-last-edit?tile=2:3&i=abc",
    ];

    for (const url of badRequests) {
      const response = await handleWorkerFetch(new Request(url), env);
      expect(response.status).toBe(400);
    }

    expect(tileOwner.requestedNames.length).toBe(0);
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

    const forwarded = stub?.requests[0]?.request;
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
