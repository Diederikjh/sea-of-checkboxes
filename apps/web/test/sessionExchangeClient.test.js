import { describe, expect, it, vi } from "vitest";

import { createAuthSessionExchangeClient } from "../src/auth/sessionExchangeClient";

describe("auth session exchange client", () => {
  it("uses global fetch with correct invocation context", async () => {
    const originalFetch = globalThis.fetch;
    let observedThis = null;
    const guardedFetch = vi.fn(function guardedFetch(input) {
      observedThis = this;
      if (this !== globalThis) {
        throw new Error("fetch called with incorrect this");
      }

      expect(String(input)).toBe("https://api.example/auth/session");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uid: "u_saved123",
            name: "BriskOtter001",
            token: "tok_next",
            migration: "none",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      );
    });

    globalThis.fetch = guardedFetch;

    try {
      const client = createAuthSessionExchangeClient({
        apiBaseUrl: "https://api.example",
      });

      await expect(
        client.exchange(
          {
            provider: "firebase",
            idToken: "firebase-token",
          },
          "legacy-token"
        )
      ).resolves.toEqual({
        uid: "u_saved123",
        name: "BriskOtter001",
        token: "tok_next",
        migration: "none",
      });
      expect(guardedFetch).toHaveBeenCalledTimes(1);
      expect(observedThis).toBe(globalThis);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("includes worker detail in exchange error messages", async () => {
    const client = createAuthSessionExchangeClient({
      apiBaseUrl: "https://api.example",
      fetchFn: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            msg: "Unable to create auth session",
            detail: "Firebase verifier is not configured",
          }),
          {
            status: 503,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      ),
    });

    await expect(
      client.exchange({
        provider: "firebase",
        idToken: "firebase-token",
      })
    ).rejects.toThrow("Unable to create auth session (Firebase verifier is not configured)");
  });
});
