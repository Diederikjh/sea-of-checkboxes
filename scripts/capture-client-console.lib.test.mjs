import { describe, expect, it } from "vitest";

import {
  buildBrowserExitBeforeDevToolsError,
  buildDebugEndpointTimeoutError,
  formatRemoteObject,
  makeUrl,
  parseClientCaptureArgs,
  pickPageTarget,
} from "./capture-client-console.lib.mjs";

describe("capture-client-console lib", () => {
  it("parses args and respects env + path resolvers", () => {
    const options = parseClientCaptureArgs(
      ["--url", "https://example.test", "--private", "--timeout-ms", "2000", "--output", "logs/x.log"],
      {
        env: { SOC_TEST_URL: "https://env.test" },
        resolvePath: (...parts) => parts.join("/"),
        makeTimestamp: () => "stamp",
      }
    );

    expect(options).toMatchObject({
      url: "https://example.test",
      private: true,
      timeoutMs: 2000,
      output: "logs/x.log",
      userDataDir: ".client-profile/chrome",
      appLogs: true,
    });
  });

  it("throws for invalid timeout values", () => {
    expect(() => parseClientCaptureArgs(["--timeout-ms", "0"])).toThrow(/Invalid --timeout-ms value/);
  });

  it("adds logs query param only when missing", () => {
    expect(makeUrl("https://app.test", true)).toBe("https://app.test/?logs=protocol%2Cui%2Cother");
    expect(makeUrl("https://app.test/?logs=ui", true)).toBe("https://app.test/?logs=ui");
    expect(makeUrl("https://app.test", false)).toBe("https://app.test");
  });

  it("selects preferred page target then fallback", () => {
    const targets = [
      { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" },
      { type: "page", url: "chrome://settings", webSocketDebuggerUrl: "ws://chrome" },
      { type: "page", url: "https://example.test/path", webSocketDebuggerUrl: "ws://match" },
    ];
    expect(pickPageTarget(targets, "https://example.test/path?x=1")).toEqual(targets[2]);

    const fallbackTargets = [
      { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" },
      { type: "page", url: "https://other.test", webSocketDebuggerUrl: "ws://other" },
    ];
    expect(pickPageTarget(fallbackTargets, "https://example.test")).toEqual(fallbackTargets[1]);
  });

  it("formats debug endpoint errors and remote objects", () => {
    expect(buildBrowserExitBeforeDevToolsError({ code: 1, signal: null }, ["line1"]))
      .toContain("Recent browser stderr");
    expect(buildDebugEndpointTimeoutError("/tmp/DevToolsActivePort", null, new Error("boom")))
      .toContain("Last error: boom");

    expect(formatRemoteObject({ value: "x" })).toBe("x");
    expect(formatRemoteObject({ value: { a: 1 } })).toBe('{"a":1}');
    expect(formatRemoteObject({ unserializableValue: "-0" })).toBe("-0");
    expect(formatRemoteObject({ description: "Symbol(x)" })).toBe("Symbol(x)");
  });
});
