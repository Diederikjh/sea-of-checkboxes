import {
  readJson,
  type DurableObjectNamespaceLike,
} from "./doCommon";
import {
  isValidCursorRelayBatch,
  type CursorRelayBatch,
} from "./cursorRelay";

export interface CursorHubWatchRequest {
  shard: string;
  action: "sub" | "unsub";
}

export interface CursorHubRecordActivityRequest {
  from: string;
  x: number;
  y: number;
  atMs: number;
}

export interface CursorHubSpawnSampleResponse {
  x: number;
  y: number;
  source: "edit" | "cursor";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidSpawnSampleResponse(value: unknown): value is CursorHubSpawnSampleResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<CursorHubSpawnSampleResponse>;
  if (!isFiniteNumber(candidate.x) || !isFiniteNumber(candidate.y)) {
    return false;
  }
  return candidate.source === "edit" || candidate.source === "cursor";
}

export class ConnectionShardCursorHubGateway {
  #namespace: DurableObjectNamespaceLike;
  #hubName: string;

  constructor(options: { namespace: DurableObjectNamespaceLike; hubName: string }) {
    this.#namespace = options.namespace;
    this.#hubName = options.hubName;
  }

  async watchShard(shard: string, action: "sub" | "unsub"): Promise<CursorRelayBatch | null> {
    const response = await this.#namespace.getByName(this.#hubName).fetch("https://cursor-hub.internal/watch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        shard,
        action,
      } satisfies CursorHubWatchRequest),
    });

    if (!response.ok) {
      return null;
    }

    if (response.status === 204) {
      return null;
    }

    const batch = await readJson<CursorRelayBatch>(response);
    if (!batch || !isValidCursorRelayBatch(batch)) {
      return null;
    }

    return batch;
  }

  async publishRecentEdit(params: CursorHubRecordActivityRequest): Promise<void> {
    await this.#namespace.getByName(this.#hubName).fetch("https://cursor-hub.internal/activity", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(params),
    });
  }

  async sampleSpawnPoint(): Promise<CursorHubSpawnSampleResponse | null> {
    const response = await this.#namespace.getByName(this.#hubName).fetch("https://cursor-hub.internal/spawn-sample", {
      method: "GET",
    });

    if (!response.ok || response.status === 204) {
      return null;
    }

    const payload = await readJson<CursorHubSpawnSampleResponse>(response);
    if (!payload || !isValidSpawnSampleResponse(payload)) {
      return null;
    }

    return payload;
  }
}
