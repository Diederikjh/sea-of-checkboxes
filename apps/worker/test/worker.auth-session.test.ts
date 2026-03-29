import { describe, expect, it } from "vitest";

import { handleWorkerFetch } from "../src/workerFetch";
import { createIdentityToken } from "../src/identityToken";
import type { ExternalAssertion, ExternalIdentityVerifier } from "../src/auth/contracts";
import {
  RecordingDurableObjectStub,
  StubNamespace,
} from "./helpers/doStubs";

function workerRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://worker.local${path}`, init);
}

class StaticFirebaseVerifier implements ExternalIdentityVerifier {
  async verify(assertion: ExternalAssertion) {
    if (assertion.idToken === "token-existing") {
      return {
        provider: "firebase" as const,
        providerUserId: "firebase-existing",
        isAnonymous: true,
      };
    }

    if (assertion.idToken === "token-new") {
      return {
        provider: "firebase" as const,
        providerUserId: "firebase-new",
        isAnonymous: true,
      };
    }

    return null;
  }
}

class AccountLinkDurableObjectStub {
  readonly name: string;
  readonly requests: Array<{ request: Request; body: string }>;
  #providerToRecord: Map<string, { uid: string; name: string; linkedAtMs: number; createdAtMs: number }>;
  #uidToProvider: Map<string, string>;

  constructor(name: string) {
    this.name = name;
    this.requests = [];
    this.#providerToRecord = new Map();
    this.#uidToProvider = new Map();
  }

  seedProviderRecord(
    providerUserId: string,
    record: { uid: string; name: string; linkedAtMs: number; createdAtMs: number }
  ): void {
    this.#providerToRecord.set(`firebase:${providerUserId}`, record);
    this.#uidToProvider.set(record.uid, providerUserId);
  }

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = typeof input === "string" ? new Request(input, init) : input;
    const body = await request.text();
    this.requests.push({
      request: new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      }),
      body,
    });

    const url = new URL(request.url);
    const payload = body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : {};

    if (url.pathname === "/resolve" && request.method === "POST") {
      const provider = payload.provider;
      const providerUserId = payload.providerUserId;
      if (provider !== "firebase" || typeof providerUserId !== "string") {
        return this.#json({ error: "invalid_payload" }, 400);
      }
      const record = this.#providerToRecord.get(`${provider}:${providerUserId}`);
      if (!record) {
        return this.#json({ found: false });
      }
      return this.#json({
        found: true,
        record: {
          identity: {
            uid: record.uid,
            name: record.name,
            token: "",
          },
          linkedAtMs: record.linkedAtMs,
          createdAtMs: record.createdAtMs,
        },
      });
    }

    if (url.pathname === "/resolve-app" && request.method === "POST") {
      const uid = payload.uid;
      if (typeof uid !== "string") {
        return this.#json({ error: "invalid_payload" }, 400);
      }
      const mapped = this.#uidToProvider.get(uid);
      if (!mapped) {
        return this.#json({ found: false });
      }
      return this.#json({
        found: true,
        record: {
          provider: "firebase",
          providerUserId: mapped,
        },
      });
    }

    if (url.pathname === "/link" && request.method === "POST") {
      const provider = payload.provider;
      const providerUserId = payload.providerUserId;
      const identity = payload.identity as { uid?: unknown; name?: unknown } | undefined;
      const nowMs = Number.isInteger(payload.nowMs) && typeof payload.nowMs === "number" ? payload.nowMs : Date.now();
      if (provider !== "firebase" || typeof providerUserId !== "string" || !identity) {
        return this.#json({ error: "invalid_payload" }, 400);
      }
      if (typeof identity.uid !== "string" || typeof identity.name !== "string") {
        return this.#json({ error: "invalid_payload" }, 400);
      }

      const providerKey = `${provider}:${providerUserId}`;
      const existingProvider = this.#providerToRecord.get(providerKey);
      if (existingProvider) {
        if (existingProvider.uid === identity.uid) {
          return this.#json({
            ok: true,
            linked: {
              identity: {
                uid: existingProvider.uid,
                name: existingProvider.name,
                token: "",
              },
              linkedAtMs: existingProvider.linkedAtMs,
              createdAtMs: existingProvider.createdAtMs,
            },
          });
        }

        return this.#json(
          {
            ok: false,
            code: "provider_conflict",
            existing: {
              identity: {
                uid: existingProvider.uid,
                name: existingProvider.name,
                token: "",
              },
              linkedAtMs: existingProvider.linkedAtMs,
              createdAtMs: existingProvider.createdAtMs,
            },
          },
          409
        );
      }

      const existingUid = this.#uidToProvider.get(identity.uid);
      if (existingUid && existingUid !== providerUserId) {
        return this.#json({ ok: false, code: "app_uid_conflict" }, 409);
      }

      this.#providerToRecord.set(providerKey, {
        uid: identity.uid,
        name: identity.name,
        linkedAtMs: nowMs,
        createdAtMs: nowMs,
      });
      this.#uidToProvider.set(identity.uid, providerUserId);

      return this.#json({
        ok: true,
        linked: {
          identity: {
            uid: identity.uid,
            name: identity.name,
            token: "",
          },
          linkedAtMs: nowMs,
          createdAtMs: nowMs,
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  #json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: {
        "content-type": "application/json",
      },
    });
  }
}

function createEnv() {
  const identitySigningSecret = "test-worker-fetch-secret";
  const connectionShard = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  const tileOwner = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  const accountLink = new StubNamespace((name) => new AccountLinkDurableObjectStub(name));
  return {
    env: {
      CONNECTION_SHARD: connectionShard,
      TILE_OWNER: tileOwner,
      ACCOUNT_LINK: accountLink,
      IDENTITY_SIGNING_SECRET: identitySigningSecret,
      APP_DISABLED: "0",
      READONLY_MODE: "0",
      ANON_AUTH_ENABLED: "1",
      SHARE_LINKS_ENABLED: "1",
      AUTH_MODE: "hybrid",
      EXTERNAL_IDENTITY_VERIFIER: new StaticFirebaseVerifier(),
    },
    connectionShard,
    accountLink,
    identitySigningSecret,
  };
}

describe("worker auth session endpoint", () => {
  it("links legacy app identity when legacy token is present", async () => {
    const { env, identitySigningSecret } = createEnv();
    const nowMs = Date.now();
    const legacyToken = await createIdentityToken("u_saved123", "BriskOtter481", identitySigningSecret, nowMs);

    const response = await handleWorkerFetch(
      workerRequest("/auth/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          assertion: {
            provider: "firebase",
            idToken: "token-existing",
          },
          legacyToken,
        }),
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      uid: "u_saved123",
      name: "BriskOtter481",
      migration: "linked_legacy",
    });
  });

  it("keeps existing anonymous identities working when anonymous bootstrap is disabled", async () => {
    const { env, accountLink } = createEnv();
    env.ANON_AUTH_ENABLED = "0";
    const stub = accountLink.getByName("global") as AccountLinkDurableObjectStub;
    stub.seedProviderRecord("firebase-existing", {
      uid: "u_existing123",
      name: "BriskOtter123",
      linkedAtMs: 10,
      createdAtMs: 10,
    });

    const response = await handleWorkerFetch(
      workerRequest("/auth/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          assertion: {
            provider: "firebase",
            idToken: "token-existing",
          },
        }),
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      uid: "u_existing123",
      name: "BriskOtter123",
      migration: "none",
    });
  });

  it("rejects brand new anonymous bootstrap when anonymous access is disabled", async () => {
    const { env } = createEnv();
    env.ANON_AUTH_ENABLED = "0";

    const response = await handleWorkerFetch(
      workerRequest("/auth/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          assertion: {
            provider: "firebase",
            idToken: "token-new",
          },
        }),
      }),
      env
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "anonymous_disabled",
    });
  });

  it("falls back to a fresh app identity when legacy uid is linked to a different firebase user", async () => {
    const { env, identitySigningSecret } = createEnv();
    const nowMs = Date.now();
    const legacyToken = await createIdentityToken("u_saved123", "BriskOtter481", identitySigningSecret, nowMs);

    const first = await handleWorkerFetch(
      workerRequest("/auth/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          assertion: {
            provider: "firebase",
            idToken: "token-existing",
          },
          legacyToken,
        }),
      }),
      env
    );
    expect(first.status).toBe(200);

    const second = await handleWorkerFetch(
      workerRequest("/auth/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          assertion: {
            provider: "firebase",
            idToken: "token-new",
          },
          legacyToken,
        }),
      }),
      env
    );

    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { uid: string; migration: string };
    expect(secondBody.migration).toBe("provisioned");
    expect(secondBody.uid).not.toBe("u_saved123");
  });

  it("provisions and reuses new app identity when legacy token is missing", async () => {
    const { env } = createEnv();

    const first = await handleWorkerFetch(
      workerRequest("/auth/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          assertion: {
            provider: "firebase",
            idToken: "token-new",
          },
        }),
      }),
      env
    );

    const firstBody = (await first.json()) as { uid: string; name: string; migration: string; token: string };
    expect(firstBody.uid).toMatch(/^u_[0-9a-f]{8}$/);
    expect(firstBody.name).toMatch(/^[A-Za-z]+\d{3}$/);
    expect(firstBody.migration).toBe("provisioned");
    expect(firstBody.token).toMatch(/^v2\./);

    const second = await handleWorkerFetch(
      workerRequest("/auth/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          assertion: {
            provider: "firebase",
            idToken: "token-new",
          },
        }),
      }),
      env
    );

    await expect(second.json()).resolves.toMatchObject({
      uid: firstBody.uid,
      name: firstBody.name,
      migration: "none",
    });
  });

  it("keeps legacy websocket token flow working in hybrid mode", async () => {
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
  });

  it("returns actionable auth_unavailable detail when firebase verifier config is missing", async () => {
    const identitySigningSecret = "test-worker-fetch-secret";
    const connectionShard = new StubNamespace((name) => new RecordingDurableObjectStub(name));
    const tileOwner = new StubNamespace((name) => new RecordingDurableObjectStub(name));
    const accountLink = new StubNamespace((name) => new AccountLinkDurableObjectStub(name));
    const env = {
      CONNECTION_SHARD: connectionShard,
      TILE_OWNER: tileOwner,
      ACCOUNT_LINK: accountLink,
      IDENTITY_SIGNING_SECRET: identitySigningSecret,
      AUTH_MODE: "hybrid",
    };

    const response = await handleWorkerFetch(
      workerRequest("/auth/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          assertion: {
            provider: "firebase",
            idToken: "token-existing",
          },
        }),
      }),
      env
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "auth_unavailable",
      msg: "Firebase verifier is not configured",
      detail: "Set FIREBASE_PROJECT_ID on the worker environment",
    });
  });
});
