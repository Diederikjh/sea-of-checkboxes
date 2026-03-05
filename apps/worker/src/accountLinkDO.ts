import { normalizeIdentity } from "@sea/domain";

import {
  readJson,
  type DurableObjectStateLike,
  type Env,
} from "./doCommon";

interface ProviderMappingRecord {
  identity: {
    uid: string;
    name: string;
    token: string;
  };
  linkedAtMs: number;
  createdAtMs: number;
  provider: "firebase";
  providerUserId: string;
  isAnonymous: boolean;
  email?: string;
}

interface AppMappingRecord {
  provider: "firebase";
  providerUserId: string;
}

function providerKey(provider: string, providerUserId: string): string {
  return `provider:${provider}:${providerUserId}`;
}

function appKey(uid: string): string {
  return `app:${uid}`;
}

function normalizedRecord(value: unknown): ProviderMappingRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    identity?: unknown;
    linkedAtMs?: unknown;
    createdAtMs?: unknown;
    provider?: unknown;
    providerUserId?: unknown;
    isAnonymous?: unknown;
    email?: unknown;
  };

  const identity = normalizeIdentity(candidate.identity);
  if (!identity) {
    return null;
  }
  if (candidate.provider !== "firebase" || typeof candidate.providerUserId !== "string") {
    return null;
  }
  if (!Number.isInteger(candidate.linkedAtMs) || !Number.isInteger(candidate.createdAtMs)) {
    return null;
  }
  if (typeof candidate.isAnonymous !== "boolean") {
    return null;
  }

  const email = typeof candidate.email === "string" && candidate.email.length > 0 ? candidate.email : undefined;
  const linkedAtMs = candidate.linkedAtMs as number;
  const createdAtMs = candidate.createdAtMs as number;

  return {
    identity: {
      uid: identity.uid,
      name: identity.name,
      token: "",
    },
    linkedAtMs,
    createdAtMs,
    provider: candidate.provider,
    providerUserId: candidate.providerUserId,
    isAnonymous: candidate.isAnonymous,
    ...(email ? { email } : {}),
  };
}

function normalizedAppMapping(value: unknown): AppMappingRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    provider?: unknown;
    providerUserId?: unknown;
  };

  if (candidate.provider !== "firebase" || typeof candidate.providerUserId !== "string") {
    return null;
  }

  return {
    provider: candidate.provider,
    providerUserId: candidate.providerUserId,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

export class AccountLinkDO {
  #state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike, _env: Env) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/resolve" && request.method === "POST") {
      const payload = await readJson<{ provider?: unknown; providerUserId?: unknown }>(request);
      if (!payload || payload.provider !== "firebase" || typeof payload.providerUserId !== "string") {
        return jsonResponse({ error: "invalid_payload" }, 400);
      }

      const record = normalizedRecord(await this.#state.storage.get(providerKey(payload.provider, payload.providerUserId)));
      if (!record) {
        return jsonResponse({ found: false });
      }

      return jsonResponse({
        found: true,
        record: {
          identity: record.identity,
          linkedAtMs: record.linkedAtMs,
          createdAtMs: record.createdAtMs,
        },
      });
    }

    if (url.pathname === "/resolve-app" && request.method === "POST") {
      const payload = await readJson<{ uid?: unknown }>(request);
      if (!payload || typeof payload.uid !== "string") {
        return jsonResponse({ error: "invalid_payload" }, 400);
      }

      const record = normalizedAppMapping(await this.#state.storage.get(appKey(payload.uid)));
      if (!record) {
        return jsonResponse({ found: false });
      }

      return jsonResponse({
        found: true,
        record,
      });
    }

    if (url.pathname === "/link" && request.method === "POST") {
      const payload = await readJson<{
        provider?: unknown;
        providerUserId?: unknown;
        identity?: unknown;
        isAnonymous?: unknown;
        email?: unknown;
        nowMs?: unknown;
      }>(request);
      if (!payload || payload.provider !== "firebase" || typeof payload.providerUserId !== "string") {
        return jsonResponse({ error: "invalid_payload" }, 400);
      }

      const identity = normalizeIdentity(payload.identity);
      if (!identity || typeof payload.isAnonymous !== "boolean") {
        return jsonResponse({ error: "invalid_payload" }, 400);
      }

      const nowMs = Number.isInteger(payload.nowMs) && typeof payload.nowMs === "number" ? payload.nowMs : Date.now();
      const pKey = providerKey(payload.provider, payload.providerUserId);
      const aKey = appKey(identity.uid);

      const existingProviderRecord = normalizedRecord(await this.#state.storage.get(pKey));
      if (existingProviderRecord) {
        if (existingProviderRecord.identity.uid === identity.uid) {
          return jsonResponse({
            ok: true,
            linked: {
              identity: existingProviderRecord.identity,
              linkedAtMs: existingProviderRecord.linkedAtMs,
              createdAtMs: existingProviderRecord.createdAtMs,
            },
          });
        }

        return jsonResponse({
          ok: false,
          code: "provider_conflict",
          existing: {
            identity: existingProviderRecord.identity,
            linkedAtMs: existingProviderRecord.linkedAtMs,
            createdAtMs: existingProviderRecord.createdAtMs,
          },
        }, 409);
      }

      const existingAppRecord = normalizedAppMapping(await this.#state.storage.get(aKey));
      if (existingAppRecord && existingAppRecord.providerUserId !== payload.providerUserId) {
        if (existingAppRecord.provider === payload.provider) {
          const existingMappedProviderRecord = normalizedRecord(
            await this.#state.storage.get(providerKey(payload.provider, existingAppRecord.providerUserId))
          );
          if (existingMappedProviderRecord && existingMappedProviderRecord.identity.uid === identity.uid) {
            const migrated: ProviderMappingRecord = {
              identity: {
                uid: existingMappedProviderRecord.identity.uid,
                name: existingMappedProviderRecord.identity.name,
                token: "",
              },
              linkedAtMs: nowMs,
              createdAtMs: existingMappedProviderRecord.createdAtMs,
              provider: "firebase",
              providerUserId: payload.providerUserId,
              isAnonymous: payload.isAnonymous,
              ...(typeof payload.email === "string" && payload.email.length > 0 ? { email: payload.email } : {}),
            };

            await this.#state.storage.put(pKey, migrated);
            await this.#state.storage.put(aKey, {
              provider: "firebase",
              providerUserId: payload.providerUserId,
            } satisfies AppMappingRecord);

            return jsonResponse({
              ok: true,
              linked: {
                identity: migrated.identity,
                linkedAtMs: migrated.linkedAtMs,
                createdAtMs: migrated.createdAtMs,
              },
            });
          }
        }

        return jsonResponse({
          ok: false,
          code: "app_uid_conflict",
        }, 409);
      }

      const record: ProviderMappingRecord = {
        identity: {
          uid: identity.uid,
          name: identity.name,
          token: "",
        },
        linkedAtMs: nowMs,
        createdAtMs: nowMs,
        provider: "firebase",
        providerUserId: payload.providerUserId,
        isAnonymous: payload.isAnonymous,
        ...(typeof payload.email === "string" && payload.email.length > 0 ? { email: payload.email } : {}),
      };

      await this.#state.storage.put(pKey, record);
      await this.#state.storage.put(aKey, {
        provider: "firebase",
        providerUserId: payload.providerUserId,
      } satisfies AppMappingRecord);

      return jsonResponse({
        ok: true,
        linked: {
          identity: record.identity,
          linkedAtMs: record.linkedAtMs,
          createdAtMs: record.createdAtMs,
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }
}
