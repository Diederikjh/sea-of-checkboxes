import { describe, expect, it } from "vitest";

import { handleWorkerFetch } from "../src/workerFetch";
import { createIdentityToken } from "../src/identityToken";
import {
  RecordingDurableObjectStub,
  StubNamespace,
} from "./helpers/doStubs";

function workerRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://worker.local${path}`, init);
}

function forwardedWebSocketUrlForShard(
  connectionShard: StubNamespace<RecordingDurableObjectStub>,
  shardName: string
): URL {
  const stub = connectionShard.stubs.get(shardName);
  const forwarded = stub?.requests[0]?.request;
  if (!forwarded) {
    throw new Error("Missing forwarded request");
  }
  return new URL(forwarded.url);
}

function createEnv() {
  const identitySigningSecret = "test-worker-fetch-secret";
  const connectionShard = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  const tileOwner = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  return {
    env: {
      CONNECTION_SHARD: connectionShard,
      TILE_OWNER: tileOwner,
      IDENTITY_SIGNING_SECRET: identitySigningSecret,
    },
    connectionShard,
    tileOwner,
    identitySigningSecret,
  };
}

describe("top-level worker fetch routing", () => {
  it("returns health payload on /health", async () => {
    const { env } = createEnv();
    const response = await handleWorkerFetch(workerRequest("/health"), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ws: "/ws",
    });
  });

  it("returns 404 for unknown paths", async () => {
    const { env } = createEnv();
    const response = await handleWorkerFetch(workerRequest("/unknown"), env);
    expect(response.status).toBe(404);
  });

  it("forwards cell-last-edit requests to tile owner by tile key", async () => {
    const { env, tileOwner } = createEnv();
    const response = await handleWorkerFetch(workerRequest("/cell-last-edit?tile=2:3&i=17"), env);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
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
    const badPaths = [
      "/cell-last-edit",
      "/cell-last-edit?tile=2:3",
      "/cell-last-edit?tile=bad&i=1",
      "/cell-last-edit?tile=2:3&i=-1",
      "/cell-last-edit?tile=2:3&i=abc",
    ];

    for (const path of badPaths) {
      const response = await handleWorkerFetch(workerRequest(path), env);
      expect(response.status).toBe(400);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }

    expect(tileOwner.requestedNames.length).toBe(0);
  });

  it("responds to cell-last-edit preflight requests", async () => {
    const { env, tileOwner } = createEnv();
    const response = await handleWorkerFetch(
      workerRequest("/cell-last-edit", {
        method: "OPTIONS",
      }),
      env
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    expect(response.headers.get("access-control-allow-methods")).toContain("OPTIONS");
    expect(tileOwner.requestedNames.length).toBe(0);
  });

  it("rejects /ws when upgrade header is missing", async () => {
    const { env } = createEnv();
    const response = await handleWorkerFetch(workerRequest("/ws"), env);
    expect(response.status).toBe(426);
  });

  it("forwards websocket requests to selected shard with uid/name/shard params", async () => {
    const { env, connectionShard } = createEnv();
    const response = await handleWorkerFetch(
      workerRequest("/ws", {
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

    const forwardedUrl = forwardedWebSocketUrlForShard(connectionShard, shardName);
    expect(forwardedUrl.pathname).toBe("/ws");

    const uid = forwardedUrl.searchParams.get("uid");
    const name = forwardedUrl.searchParams.get("name");
    const token = forwardedUrl.searchParams.get("token");
    const forwardedShard = forwardedUrl.searchParams.get("shard");

    expect(uid).toMatch(/^u_[0-9a-f]{8}$/);
    expect(name).toMatch(/^[A-Za-z]+\d{3}$/);
    expect(typeof token).toBe("string");
    expect(token?.length).toBeGreaterThan(0);
    expect(forwardedShard).toBe(shardName);

    const stub = connectionShard.stubs.get(shardName);
    const forwarded = stub?.requests[0]?.request;
    expect(forwarded?.method).toBe("GET");
    expect(forwarded?.headers.get("upgrade")).toBe("websocket");
    expect(forwarded?.headers.get("x-trace-id")).toBe("trace_123");
  });

  it("reuses identity from a valid signed token", async () => {
    const { env, connectionShard, identitySigningSecret } = createEnv();
    const token = await createIdentityToken("u_saved123", "BriskOtter481", identitySigningSecret);
    const response = await handleWorkerFetch(
      workerRequest(`/ws?token=${encodeURIComponent(token)}`, {
        headers: {
          upgrade: "websocket",
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

    const forwardedUrl = forwardedWebSocketUrlForShard(connectionShard, shardName);
    expect(forwardedUrl.searchParams.get("uid")).toBe("u_saved123");
    expect(forwardedUrl.searchParams.get("name")).toBe("BriskOtter481");
    expect(forwardedUrl.searchParams.get("token")).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("ignores spoofed uid/name when token is valid", async () => {
    const { env, connectionShard, identitySigningSecret } = createEnv();
    const token = await createIdentityToken("u_saved123", "BriskOtter481", identitySigningSecret);
    const response = await handleWorkerFetch(
      workerRequest(`/ws?uid=u_spoofed&name=Spoofed999&token=${encodeURIComponent(token)}`, {
        headers: {
          upgrade: "websocket",
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

    const forwardedUrl = forwardedWebSocketUrlForShard(connectionShard, shardName);
    expect(forwardedUrl.searchParams.get("uid")).toBe("u_saved123");
    expect(forwardedUrl.searchParams.get("name")).toBe("BriskOtter481");
  });

  it("issues a new identity when token query is blank", async () => {
    const { env, connectionShard } = createEnv();
    const response = await handleWorkerFetch(
      workerRequest("/ws?token=", {
        headers: {
          upgrade: "websocket",
        },
      }),
      env
    );

    expect(response.status).toBe(204);
    const shardName = connectionShard.requestedNames[0];
    if (!shardName) {
      throw new Error("Expected shard name");
    }

    const forwardedUrl = forwardedWebSocketUrlForShard(connectionShard, shardName);
    expect(forwardedUrl.searchParams.get("uid")).toMatch(/^u_[0-9a-f]{8}$/);
    expect(forwardedUrl.searchParams.get("name")).toMatch(/^[A-Za-z]+\d{3}$/);
    expect(forwardedUrl.searchParams.get("token")).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("falls back to generated uid/name when token is malformed", async () => {
    const { env, connectionShard } = createEnv();
    const response = await handleWorkerFetch(
      workerRequest("/ws?token=tok", {
        headers: {
          upgrade: "websocket",
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

    const forwardedUrl = forwardedWebSocketUrlForShard(connectionShard, shardName);
    expect(forwardedUrl.searchParams.get("uid")).toMatch(/^u_[0-9a-f]{8}$/);
    expect(forwardedUrl.searchParams.get("name")).toMatch(/^[A-Za-z]+\d{3}$/);
    expect(forwardedUrl.searchParams.get("token")).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("falls back to generated uid/name when token signature is invalid", async () => {
    const { env, connectionShard } = createEnv();
    const response = await handleWorkerFetch(
      workerRequest("/ws?token=v2.eyJ1aWQiOiJ1X3NhdmVkMTIzIiwibmFtZSI6IkJyaXNrT3R0ZXI0ODEiLCJleHAiOjk5OTk5OTk5OTl9.bad", {
        headers: {
          upgrade: "websocket",
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

    const forwardedUrl = forwardedWebSocketUrlForShard(connectionShard, shardName);
    expect(forwardedUrl.searchParams.get("uid")).not.toBe("u_saved123");
    expect(forwardedUrl.searchParams.get("name")).not.toBe("BriskOtter481");
  });
});
