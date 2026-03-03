import { describe, expect, it } from "vitest";

import { AccountLinkDORepository } from "../src/auth/accountLinkDORepository";
import {
  RecordingDurableObjectStub,
  StubNamespace,
} from "./helpers/doStubs";

function createRepository() {
  const namespace = new StubNamespace((name) => new RecordingDurableObjectStub(name));
  const repository = new AccountLinkDORepository({
    namespace,
  });
  const stub = namespace.getByName("global");

  return {
    repository,
    stub,
  };
}

describe("AccountLinkDORepository", () => {
  it("resolves provider mapping into normalized account link records", async () => {
    const { repository, stub } = createRepository();
    stub.setJsonPathResponse("/resolve", {
      found: true,
      record: {
        identity: {
          uid: "u_saved123",
          name: "BriskOtter001",
          token: "legacy-token",
        },
        linkedAtMs: 100,
        createdAtMs: 50,
      },
    });

    await expect(repository.getByProviderUser("firebase", "firebase-uid")).resolves.toEqual({
      identity: {
        uid: "u_saved123",
        name: "BriskOtter001",
        token: "",
      },
      linkedAtMs: 100,
      createdAtMs: 50,
    });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.request.method).toBe("POST");
    expect(new URL(stub.requests[0]!.request.url).pathname).toBe("/resolve");
  });

  it("returns app uid mapping for firebase-linked users", async () => {
    const { repository, stub } = createRepository();
    stub.setJsonPathResponse("/resolve-app", {
      found: true,
      record: {
        provider: "firebase",
        providerUserId: "firebase-uid",
      },
    });

    await expect(repository.getByAppUid("u_saved123")).resolves.toEqual({
      provider: "firebase",
      providerUserId: "firebase-uid",
    });
  });

  it("throws descriptive errors when DO JSON responses are invalid", async () => {
    const { repository, stub } = createRepository();
    stub.setPathStatus("/resolve", 200);

    await expect(repository.getByProviderUser("firebase", "firebase-uid")).rejects.toThrow(
      "Account-link resolve response was not valid JSON"
    );
  });
});
