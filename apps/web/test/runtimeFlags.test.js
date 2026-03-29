import { describe, expect, it } from "vitest";

import { resolveFrontendRuntimeFlags } from "../src/runtimeFlags";

describe("frontend runtime flags", () => {
  it("uses expected defaults", () => {
    expect(resolveFrontendRuntimeFlags({})).toEqual({
      appDisabled: false,
      shareLinksEnabled: true,
      anonAuthEnabled: true,
    });
  });

  it("parses explicit build-time overrides", () => {
    expect(
      resolveFrontendRuntimeFlags({
        VITE_APP_DISABLED: "1",
        VITE_SHARE_LINKS_ENABLED: "0",
        VITE_ANON_AUTH_ENABLED: "false",
      })
    ).toEqual({
      appDisabled: true,
      shareLinksEnabled: false,
      anonAuthEnabled: false,
    });
  });
});

