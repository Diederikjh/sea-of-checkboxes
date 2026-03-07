import { describe, expect, it } from "vitest";

import {
  applyWorkerLogPostFilters,
  buildLogExplorerSqlQuery,
  buildLogExplorerSqlRequest,
  buildWorkerLogQueryRequest,
  buildCloudflareAuthHeaders,
  extractWorkerLogEvents,
  formatWorkerLogQueryResult,
  parseWorkerLogQueryArgs,
  resolveCloudflareAuth,
} from "./query-worker-logs.lib.mjs";

describe("query-worker-logs lib", () => {
  it("parses targeted query args with defaults and typed filters", () => {
    const options = parseWorkerLogQueryArgs(
      [
        "--worker",
        "worker-a",
        "--last",
        "5m",
        "--limit",
        "25",
        "--trace-id",
        "ctrace_123",
        "--filter",
        "source.duration_ms:gte:number:10",
      ],
      {
        env: {
          CLOUDFLARE_LOG_QUERY_ACCOUNT_ID: "acc_123",
          CLOUDFLARE_LOG_QUERY_API_TOKEN: "tok_123",
        },
        resolvePath: (...parts) => parts.join("/"),
      }
    );

    expect(options).toMatchObject({
      accountId: "acc_123",
      apiToken: "tok_123",
      backend: "telemetry",
      worker: "worker-a",
      lastMinutes: 5,
      limit: 25,
      format: "summary",
    });
    expect(options.filters).toEqual([]);
    expect(options.postFilters).toEqual([
      {
        key: "source.trace_id",
        operation: "eq",
        type: "string",
        value: "ctrace_123",
      },
      {
        key: "source.duration_ms",
        operation: "gte",
        type: "number",
        value: 10,
      },
    ]);
  });

  it("builds a telemetry query request with timeframe and worker filter", () => {
    const options = parseWorkerLogQueryArgs([], {
      env: {
        CLOUDFLARE_LOG_QUERY_ACCOUNT_ID: "acc_123",
        CLOUDFLARE_LOG_QUERY_API_TOKEN: "tok_123",
      },
    });

    const request = buildWorkerLogQueryRequest(options, {
      now: new Date("2026-03-07T10:00:00.000Z"),
    });

    expect(request.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc_123/workers/observability/telemetry/query"
    );
    expect(request.headers.Authorization).toBe("Bearer tok_123");
    expect(request.body.view).toBe("events");
    expect(request.body.limit).toBe(100);
    expect(request.body.timeframe).toEqual({
      from: 1772876700000,
      to: 1772877600000,
    });
    expect(request.body.parameters.filters[0]).toEqual({
      key: "$workers.scriptName",
      operation: "eq",
      type: "string",
      value: "sea-of-checkboxes-worker",
    });
  });

  it("builds simple log explorer sql from filters and timeframe", () => {
    const options = parseWorkerLogQueryArgs(
      [
        "--backend",
        "log-explorer-sql",
        "--sql-table",
        "access_requests",
        "--sql-time-column",
        "CreatedAt",
        "--filter",
        "Action:eq:login",
        "--filter",
        "Allowed:eq:bool:true",
        "--limit",
        "10",
      ],
      {
        env: {
          CLOUDFLARE_LOG_QUERY_ACCOUNT_ID: "acc_123",
          CLOUDFLARE_LOG_QUERY_API_TOKEN: "tok_123",
        },
      }
    );

    expect(
      buildLogExplorerSqlQuery(options, {
        now: new Date("2026-03-07T10:00:00.000Z"),
      })
    ).toBe(
      "SELECT * FROM access_requests WHERE Action = 'login' AND Allowed = TRUE AND CreatedAt >= '2026-03-07T09:45:00.000Z' AND CreatedAt <= '2026-03-07T10:00:00.000Z' LIMIT 10"
    );

    const request = buildLogExplorerSqlRequest(options, {
      now: new Date("2026-03-07T10:00:00.000Z"),
    });
    expect(request.method).toBe("GET");
    expect(request.url).toContain("/accounts/acc_123/logs/explorer/query/sql?query=");
    expect(decodeURIComponent(request.url.split("?query=")[1])).toContain("FROM access_requests");
  });

  it("resolves auth from wrangler commands when env vars are absent", () => {
    const calls = [];
    const resolved = resolveCloudflareAuth(
      {
        accountId: "",
      },
      {
        env: {},
        execFileSync(command, args) {
          calls.push([command, args]);
          if (args.join(" ") === "dlx wrangler auth token --json") {
            return JSON.stringify({ type: "oauth", token: "oauth_123" });
          }
          if (args.join(" ") === "dlx wrangler whoami --json") {
            return JSON.stringify({
              accounts: [{ id: "acc_wr_123", name: "main" }],
            });
          }
          throw new Error(`Unexpected command: ${args.join(" ")}`);
        },
      }
    );

    expect(resolved).toEqual({
      accountId: "acc_wr_123",
      auth: {
        type: "oauth",
        token: "oauth_123",
      },
      source: "wrangler",
    });
    expect(calls).toEqual([
      ["pnpm", ["dlx", "wrangler", "auth", "token", "--json"]],
      ["pnpm", ["dlx", "wrangler", "whoami", "--json"]],
    ]);
  });

  it("builds API key auth headers when needed", () => {
    expect(
      buildCloudflareAuthHeaders({
        type: "api_key",
        key: "key_123",
        email: "user@example.com",
      })
    ).toEqual({
      "X-Auth-Key": "key_123",
      "X-Auth-Email": "user@example.com",
      "Content-Type": "application/json",
    });
  });

  it("prefers dedicated log-query env vars over generic Cloudflare vars", () => {
    const resolved = resolveCloudflareAuth(
      {
        accountId: "",
      },
      {
        env: {
          CLOUDFLARE_LOG_QUERY_ACCOUNT_ID: "acc_log_123",
          CLOUDFLARE_LOG_QUERY_API_TOKEN: "tok_log_123",
          CLOUDFLARE_ACCOUNT_ID: "acc_generic_123",
          CLOUDFLARE_API_TOKEN: "tok_generic_123",
        },
      }
    );

    expect(resolved).toEqual({
      accountId: "acc_log_123",
      auth: {
        type: "api_token",
        token: "tok_log_123",
      },
      source: "env",
    });
  });

  it("extracts events and formats a readable summary", () => {
    const payload = {
      result: {
        events: {
          events: [
            {
              timestamp: "2026-03-07T09:52:31.713Z",
              source: { scope: "connection_shard_do", event: "cursor_pull_cycle", shard: "shard-6" },
              $metadata: { requestId: "REQ1" },
            },
            {
              timestamp: "2026-03-07T09:52:32.000Z",
              source: { scope: "connection_shard_do", event: "cursor_pull_peer", shard: "shard-6" },
              $metadata: { requestId: "REQ2" },
            },
          ],
        },
      },
    };

    expect(extractWorkerLogEvents(payload)).toHaveLength(2);
    expect(formatWorkerLogQueryResult(payload, { format: "summary" })).toContain("events=2");
    expect(formatWorkerLogQueryResult(payload, { format: "summary" })).toContain(
      "connection_shard_do:2"
    );
  });

  it("formats tabular sql results in summary mode", () => {
    const payload = {
      result: [
        {
          createdat: "2025-01-14T18:17:55Z",
          action: "login",
          allowed: true,
        },
      ],
    };

    const text = formatWorkerLogQueryResult(payload, { format: "summary" });
    expect(text).toContain("events=1");
    expect(text).toContain("columns=createdat, action, allowed");
    expect(text).toContain('"action":"login"');
  });

  it("applies post-filters against nested telemetry event fields", () => {
    const events = [
      {
        source: {
          event: "internal_error",
          trace_id: "ctrace_1",
          shard: "shard-4",
        },
        $workers: {
          event: {
            request: {
              path: "/cursor-state",
              method: "GET",
            },
          },
        },
      },
      {
        source: {
          event: "cursor_pull_peer",
          trace_id: "ctrace_2",
          shard: "shard-5",
        },
        $workers: {
          event: {
            request: {
              path: "/cursor-state",
              method: "GET",
            },
          },
        },
      },
    ];

    const filtered = applyWorkerLogPostFilters(events, {
      postFilters: [
        { key: "source.event", operation: "eq", value: "internal_error" },
        { key: "$workers.event.request.path", operation: "eq", value: "/cursor-state" },
      ],
    });

    expect(filtered).toEqual([events[0]]);
  });

  it("rejects invalid duration strings", () => {
    expect(() => parseWorkerLogQueryArgs(["--last", "12x"])).toThrow(/Invalid --last value/);
  });
});
