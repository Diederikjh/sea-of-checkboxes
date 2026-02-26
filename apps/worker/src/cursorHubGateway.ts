import {
  readJson,
  type DurableObjectNamespaceLike,
} from "./doCommon";
import {
  isValidCursorRelayBatch,
  type CursorPresence,
  type CursorRelayBatch,
} from "./cursorRelay";

export interface CursorHubWatchRequest {
  shard: string;
  action: "sub" | "unsub";
}

export interface CursorHubPublishRequest {
  from: string;
  updates: CursorPresence[];
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

  async publishLocalCursors(from: string, updates: CursorPresence[]): Promise<void> {
    if (updates.length === 0) {
      return;
    }

    await this.#namespace.getByName(this.#hubName).fetch("https://cursor-hub.internal/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        updates,
      } satisfies CursorHubPublishRequest),
    });
  }
}
