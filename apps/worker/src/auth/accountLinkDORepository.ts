import {
  normalizeIdentity,
} from "@sea/domain";

import type { DurableObjectNamespaceLike } from "../doCommon";
import type {
  AccountLinkRecord,
  AccountLinkRepository,
  ExternalProvider,
} from "./contracts";

interface LinkResponse {
  ok: boolean;
  code?: "provider_conflict" | "app_uid_conflict";
  existing?: {
    identity: {
      uid: string;
      name: string;
      token?: string;
    };
    linkedAtMs: number;
    createdAtMs: number;
  };
  linked?: {
    identity: {
      uid: string;
      name: string;
      token?: string;
    };
    linkedAtMs: number;
    createdAtMs: number;
  };
}

interface ResolveResponse {
  found: boolean;
  record?: {
    identity: {
      uid: string;
      name: string;
      token?: string;
    };
    linkedAtMs: number;
    createdAtMs: number;
  };
}

function normalizeRecord(value: ResolveResponse["record"]): AccountLinkRecord | null {
  if (!value) {
    return null;
  }

  const identity = normalizeIdentity(value.identity);
  if (!identity) {
    return null;
  }

  if (!Number.isInteger(value.linkedAtMs) || !Number.isInteger(value.createdAtMs)) {
    return null;
  }

  return {
    identity: {
      uid: identity.uid,
      name: identity.name,
      token: "",
    },
    linkedAtMs: value.linkedAtMs,
    createdAtMs: value.createdAtMs,
  };
}

export class AccountLinkDORepository implements AccountLinkRepository {
  #namespace: DurableObjectNamespaceLike;
  #name: string;

  constructor(options: { namespace: DurableObjectNamespaceLike; name?: string }) {
    this.#namespace = options.namespace;
    this.#name = options.name ?? "global";
  }

  async getByProviderUser(provider: ExternalProvider, providerUserId: string): Promise<AccountLinkRecord | null> {
    const response = await this.#stub().fetch("https://account-link.internal/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider,
        providerUserId,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as ResolveResponse;
    if (!payload.found) {
      return null;
    }

    return normalizeRecord(payload.record);
  }

  async getByAppUid(uid: string): Promise<{ provider: ExternalProvider; providerUserId: string } | null> {
    const response = await this.#stub().fetch("https://account-link.internal/resolve-app", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ uid }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      found: boolean;
      record?: { provider?: unknown; providerUserId?: unknown };
    };

    if (!payload.found) {
      return null;
    }

    if (payload.record?.provider !== "firebase" || typeof payload.record.providerUserId !== "string") {
      return null;
    }

    return {
      provider: payload.record.provider,
      providerUserId: payload.record.providerUserId,
    };
  }

  async linkProviderUserToAppIdentity(params: {
    provider: ExternalProvider;
    providerUserId: string;
    identity: { uid: string; name: string; token: string };
    isAnonymous: boolean;
    email?: string;
    nowMs?: number;
  }): Promise<
    | { ok: true; linked: AccountLinkRecord }
    | { ok: false; code: "provider_conflict" | "app_uid_conflict"; existing?: AccountLinkRecord }
  > {
    const response = await this.#stub().fetch("https://account-link.internal/link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(params),
    });

    const payload = (await response.json()) as LinkResponse;
    if (payload.ok && payload.linked) {
      const record = normalizeRecord(payload.linked);
      if (!record) {
        return { ok: false, code: "provider_conflict" };
      }

      return {
        ok: true,
        linked: record,
      };
    }

    const normalizedExisting = normalizeRecord(payload.existing);
    return {
      ok: false,
      code: payload.code === "app_uid_conflict" ? "app_uid_conflict" : "provider_conflict",
      ...(normalizedExisting ? { existing: normalizedExisting } : {}),
    };
  }

  #stub() {
    return this.#namespace.getByName(this.#name);
  }
}
