import { describe, expect, it } from "vitest";

import { AccountLinkDO } from "../src/accountLinkDO";
import {
  RecordingDurableObjectStub,
  StubNamespace,
} from "./helpers/doStubs";
import { MemoryStorage } from "./helpers/storageMocks";

function createHarness() {
  const namespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  const state = {
    id: { toString: () => "account-link:global" },
    storage: new MemoryStorage(),
  };
  const env = {
    CONNECTION_SHARD: namespace,
    TILE_OWNER: namespace,
  };

  return {
    accountLink: new AccountLinkDO(state, env),
  };
}

async function post(accountLink: AccountLinkDO, path: string, body: unknown): Promise<Response> {
  return accountLink.fetch(
    new Request(`https://account-link.internal${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  );
}

describe("AccountLinkDO", () => {
  it("migrates provider user mapping for the same app uid when provider key changes", async () => {
    const { accountLink } = createHarness();

    const first = await post(accountLink, "/link", {
      provider: "firebase",
      providerUserId: "firebase-sub-old",
      identity: {
        uid: "u_stable123",
        name: "BriskOtter123",
      },
      isAnonymous: false,
      email: "stable@example.com",
      nowMs: 10,
    });
    expect(first.status).toBe(200);

    const migrated = await post(accountLink, "/link", {
      provider: "firebase",
      providerUserId: "google:google-sub-123",
      identity: {
        uid: "u_stable123",
        name: "BriskOtter123",
      },
      isAnonymous: false,
      email: "stable@example.com",
      nowMs: 20,
    });
    expect(migrated.status).toBe(200);
    await expect(migrated.json()).resolves.toMatchObject({
      ok: true,
      linked: {
        identity: {
          uid: "u_stable123",
          name: "BriskOtter123",
        },
      },
    });

    const resolveApp = await post(accountLink, "/resolve-app", {
      uid: "u_stable123",
    });
    expect(resolveApp.status).toBe(200);
    await expect(resolveApp.json()).resolves.toEqual({
      found: true,
      record: {
        provider: "firebase",
        providerUserId: "google:google-sub-123",
      },
    });
  });
});
