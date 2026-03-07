import path from "node:path";
import { execFileSync as nodeExecFileSync } from "node:child_process";

const DEFAULT_WORKER = "sea-of-checkboxes-worker";
const DEFAULT_DATASET = "cloudflare-workers";
const DEFAULT_VIEW = "events";
const DEFAULT_FORMAT = "summary";
const DEFAULT_LIMIT = 100;
const DEFAULT_LAST_MINUTES = 15;
const DEFAULT_WRANGLER_COMMAND = ["pnpm", "dlx", "wrangler"];

function buildTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function parseIntegerArg(rawValue, flagName, { min = 1 } = {}) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Invalid ${flagName} value: ${rawValue}`);
  }
  return value;
}

function resolveArgValue(args, index, flagName) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function parseDurationMinutes(rawValue, flagName) {
  const match = /^(\d+)([mhd])$/.exec(rawValue.trim());
  if (!match) {
    throw new Error(`Invalid ${flagName} value: ${rawValue}. Use forms like 15m, 2h, or 1d.`);
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multiplier = unit === "m" ? 1 : unit === "h" ? 60 : 24 * 60;
  return amount * multiplier;
}

function coerceFilterType(rawValue) {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "string" || normalized === "number" || normalized === "bool") {
    return normalized;
  }
  throw new Error(`Invalid filter type: ${rawValue}`);
}

function coerceFilterValue(rawValue, type) {
  if (type === "number") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid numeric filter value: ${rawValue}`);
    }
    return value;
  }
  if (type === "bool") {
    if (rawValue === "true") {
      return true;
    }
    if (rawValue === "false") {
      return false;
    }
    throw new Error(`Invalid boolean filter value: ${rawValue}`);
  }
  return rawValue;
}

function parseFilterSpec(rawValue) {
  const parts = rawValue.split(":");
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(
      `Invalid --filter value: ${rawValue}. Use key:operation:value or key:operation:type:value.`
    );
  }
  const [key, operation] = parts;
  if (!key || !operation) {
    throw new Error(`Invalid --filter value: ${rawValue}`);
  }
  if (parts.length === 3) {
    return {
      key,
      operation,
      type: "string",
      value: parts[2],
    };
  }
  const type = coerceFilterType(parts[2]);
  return {
    key,
    operation,
    type,
    value: coerceFilterValue(parts[3], type),
  };
}

function addStringFilter(filters, key, value, operation = "eq") {
  if (typeof value !== "string" || value.trim().length === 0) {
    return;
  }
  filters.push({
    key,
    operation,
    type: "string",
    value: value.trim(),
  });
}

export function parseWorkerLogQueryArgs(
  argv,
  {
    env = process.env,
    resolvePath = path.resolve,
    makeTimestamp = buildTimestamp,
  } = {}
) {
  const options = {
    accountId: env.CLOUDFLARE_LOG_QUERY_ACCOUNT_ID?.trim() ?? env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "",
    apiToken:
      env.CLOUDFLARE_LOG_QUERY_API_TOKEN?.trim() ?? env.CLOUDFLARE_API_TOKEN?.trim() ?? "",
    worker: DEFAULT_WORKER,
    dataset: DEFAULT_DATASET,
    view: DEFAULT_VIEW,
    format: DEFAULT_FORMAT,
    limit: DEFAULT_LIMIT,
    from: null,
    to: null,
    lastMinutes: DEFAULT_LAST_MINUTES,
    output: null,
    filters: [],
    postFilters: [],
    dryRun: false,
    help: false,
  };

  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "-a" || arg === "--account-id") {
      options.accountId = resolveArgValue(args, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--account-id=")) {
      options.accountId = arg.slice("--account-id=".length).trim();
      continue;
    }
    if (arg === "--api-token") {
      options.apiToken = resolveArgValue(args, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--api-token=")) {
      options.apiToken = arg.slice("--api-token=".length).trim();
      continue;
    }
    if (arg === "-w" || arg === "--worker") {
      options.worker = resolveArgValue(args, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--worker=")) {
      options.worker = arg.slice("--worker=".length).trim();
      continue;
    }
    if (arg === "--dataset") {
      options.dataset = resolveArgValue(args, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--dataset=")) {
      options.dataset = arg.slice("--dataset=".length).trim();
      continue;
    }
    if (arg === "--view") {
      options.view = resolveArgValue(args, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--view=")) {
      options.view = arg.slice("--view=".length).trim();
      continue;
    }
    if (arg === "--format") {
      options.format = resolveArgValue(args, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--format=")) {
      options.format = arg.slice("--format=".length).trim();
      continue;
    }
    if (arg === "--limit") {
      options.limit = parseIntegerArg(resolveArgValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      options.limit = parseIntegerArg(arg.slice("--limit=".length), "--limit");
      continue;
    }
    if (arg === "--last") {
      options.lastMinutes = parseDurationMinutes(resolveArgValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--last=")) {
      options.lastMinutes = parseDurationMinutes(arg.slice("--last=".length), "--last");
      continue;
    }
    if (arg === "--from") {
      options.from = resolveArgValue(args, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--from=")) {
      options.from = arg.slice("--from=".length).trim();
      continue;
    }
    if (arg === "--to") {
      options.to = resolveArgValue(args, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--to=")) {
      options.to = arg.slice("--to=".length).trim();
      continue;
    }
    if (arg === "-o" || arg === "--output") {
      options.output = resolvePath(resolveArgValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = resolvePath(arg.slice("--output=".length));
      continue;
    }
    if (arg === "--request-id") {
      options.filters.push({
        key: "$metadata.requestId",
        operation: "eq",
        type: "string",
        value: resolveArgValue(args, index, arg).trim(),
      });
      index += 1;
      continue;
    }
    if (arg === "--trace-id") {
      options.postFilters.push({
        key: "source.trace_id",
        operation: "eq",
        type: "string",
        value: resolveArgValue(args, index, arg).trim(),
      });
      index += 1;
      continue;
    }
    if (arg === "--uid") {
      options.postFilters.push({
        key: "source.uid",
        operation: "eq",
        type: "string",
        value: resolveArgValue(args, index, arg).trim(),
      });
      index += 1;
      continue;
    }
    if (arg === "--cid") {
      options.postFilters.push({
        key: "source.cid",
        operation: "eq",
        type: "string",
        value: resolveArgValue(args, index, arg).trim(),
      });
      index += 1;
      continue;
    }
    if (arg === "--event") {
      options.postFilters.push({
        key: "source.event",
        operation: "eq",
        type: "string",
        value: resolveArgValue(args, index, arg).trim(),
      });
      index += 1;
      continue;
    }
    if (arg === "--scope") {
      options.postFilters.push({
        key: "source.scope",
        operation: "eq",
        type: "string",
        value: resolveArgValue(args, index, arg).trim(),
      });
      index += 1;
      continue;
    }
    if (arg === "--shard") {
      options.postFilters.push({
        key: "source.shard",
        operation: "eq",
        type: "string",
        value: resolveArgValue(args, index, arg).trim(),
      });
      index += 1;
      continue;
    }
    if (arg === "--path") {
      options.postFilters.push({
        key: "$workers.event.request.path",
        operation: "eq",
        type: "string",
        value: resolveArgValue(args, index, arg).trim(),
      });
      index += 1;
      continue;
    }
    if (arg === "--method") {
      options.postFilters.push({
        key: "$workers.event.request.method",
        operation: "eq",
        type: "string",
        value: resolveArgValue(args, index, arg).trim().toUpperCase(),
      });
      index += 1;
      continue;
    }
    if (arg === "--outcome") {
      options.postFilters.push({
        key: "$workers.outcome",
        operation: "eq",
        type: "string",
        value: resolveArgValue(args, index, arg).trim(),
      });
      index += 1;
      continue;
    }
    if (arg === "--filter") {
      options.postFilters.push(parseFilterSpec(resolveArgValue(args, index, arg)));
      index += 1;
      continue;
    }
    if (arg.startsWith("--filter=")) {
      options.postFilters.push(parseFilterSpec(arg.slice("--filter=".length)));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!["events", "adaptive_groups", "timeseries", "initial"].includes(options.view)) {
    throw new Error(`Invalid --view value: ${options.view}`);
  }
  if (!["summary", "json", "ndjson"].includes(options.format)) {
    throw new Error(`Invalid --format value: ${options.format}`);
  }
  if (options.from && Number.isNaN(Date.parse(options.from))) {
    throw new Error(`Invalid --from value: ${options.from}`);
  }
  if (options.to && Number.isNaN(Date.parse(options.to))) {
    throw new Error(`Invalid --to value: ${options.to}`);
  }
  if (options.from && options.to && Date.parse(options.from) >= Date.parse(options.to)) {
    throw new Error(`Invalid timeframe: --from must be earlier than --to`);
  }
  if (!options.output && options.format === "json") {
    options.output = resolvePath("logs", `server-query-${makeTimestamp()}.json`);
  }

  return options;
}

export function buildWorkerLogQueryRequest(options, { now = new Date() } = {}) {
  const end = options.to ? new Date(options.to) : now;
  const start = options.from ? new Date(options.from) : new Date(end.getTime() - options.lastMinutes * 60_000);

  const filters = [];
  addStringFilter(filters, "$workers.scriptName", options.worker);
  for (const filter of options.filters) {
    filters.push({
      key: filter.key,
      operation: filter.operation,
      type: filter.type,
      value: filter.value,
    });
  }

  const auth = options.auth ?? buildCloudflareAuthFromOptions(options);

  const requestLimit =
    Array.isArray(options.postFilters) && options.postFilters.length > 0
      ? Math.max(options.limit, 1000)
      : options.limit;

  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/workers/observability/telemetry/query`,
    headers: buildCloudflareAuthHeaders(auth),
    body: {
      queryId: `soc-${Date.now()}`,
      view: options.view,
      limit: requestLimit,
      timeframe: {
        from: start.getTime(),
        to: end.getTime(),
      },
      parameters: {
        datasets: [options.dataset],
        filters,
      },
    },
  };
}

function getValueAtPath(record, pathSpec) {
  const path = String(pathSpec).split(".");
  let current = record;
  for (const segment of path) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function matchesFilter(record, filter) {
  const actual = getValueAtPath(record, filter.key);
  const operation = String(filter.operation ?? "eq").toLowerCase();
  if (operation === "eq") {
    return actual === filter.value;
  }
  if (operation === "neq") {
    return actual !== filter.value;
  }
  if (operation === "contains") {
    return typeof actual === "string" && actual.includes(String(filter.value));
  }
  if (operation === "prefix") {
    return typeof actual === "string" && actual.startsWith(String(filter.value));
  }
  if (operation === "suffix") {
    return typeof actual === "string" && actual.endsWith(String(filter.value));
  }
  if (operation === "like") {
    if (typeof actual !== "string") {
      return false;
    }
    const pattern = String(filter.value)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("%", ".*")
      .replaceAll("_", ".");
    return new RegExp(`^${pattern}$`).test(actual);
  }
  if (operation === "gt") {
    return Number(actual) > Number(filter.value);
  }
  if (operation === "gte") {
    return Number(actual) >= Number(filter.value);
  }
  if (operation === "lt") {
    return Number(actual) < Number(filter.value);
  }
  if (operation === "lte") {
    return Number(actual) <= Number(filter.value);
  }
  return false;
}

export function applyWorkerLogPostFilters(events, options) {
  if (!Array.isArray(options?.postFilters) || options.postFilters.length === 0) {
    return events;
  }
  return events.filter((event) => options.postFilters.every((filter) => matchesFilter(event, filter)));
}

export function replaceWorkerLogEvents(payload, events) {
  if (Array.isArray(payload?.result?.events?.events)) {
    return {
      ...payload,
      result: {
        ...payload.result,
        events: {
          ...payload.result.events,
          events,
        },
      },
    };
  }
  if (Array.isArray(payload?.result?.events)) {
    return {
      ...payload,
      result: {
        ...payload.result,
        events,
      },
    };
  }
  if (Array.isArray(payload?.result)) {
    return {
      ...payload,
      result: events,
    };
  }
  return payload;
}

export function buildCloudflareAuthFromOptions(options) {
  if (typeof options.apiToken === "string" && options.apiToken.length > 0) {
    return {
      type: "api_token",
      token: options.apiToken,
    };
  }
  return null;
}

export function buildCloudflareAuthHeaders(auth) {
  if (!auth || typeof auth !== "object") {
    throw new Error("Missing Cloudflare auth.");
  }
  if ((auth.type === "api_token" || auth.type === "oauth") && typeof auth.token === "string") {
    return {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    };
  }
  throw new Error(`Unsupported Cloudflare auth type: ${String(auth.type ?? "(missing)")}`);
}

export function parseWranglerJson(rawValue, commandName) {
  try {
    return JSON.parse(rawValue);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${commandName} JSON output: ${detail}`);
  }
}

function pickAccountIdFromWhoami(payload) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  const normalized = accounts
    .map((account) => account?.id ?? account?.account_id ?? null)
    .filter((value) => typeof value === "string" && value.length > 0);
  if (normalized.length === 1) {
    return normalized[0];
  }
  if (normalized.length > 1) {
    throw new Error("Multiple Cloudflare accounts found. Pass --account-id to choose one.");
  }
  return "";
}

export function resolveCloudflareAuth(
  options,
  {
    env = process.env,
    execFileSync = nodeExecFileSync,
  } = {}
) {
  let accountId = options.accountId?.trim() ?? "";
  if (!accountId) {
    accountId =
      env.CLOUDFLARE_LOG_QUERY_ACCOUNT_ID?.trim() ?? env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  }

  const envApiToken =
    env.CLOUDFLARE_LOG_QUERY_API_TOKEN?.trim() ?? env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  if (envApiToken) {
    return {
      accountId,
      auth: {
        type: "api_token",
        token: envApiToken,
      },
      source: "env",
    };
  }

  const directAuth = buildCloudflareAuthFromOptions(options);
  if (directAuth) {
    return {
      accountId,
      auth: directAuth,
      source: "args",
    };
  }

  const wranglerCommand = Array.isArray(options.wranglerCommand)
    ? options.wranglerCommand
    : DEFAULT_WRANGLER_COMMAND;
  const [command, ...baseArgs] = wranglerCommand;

  const tokenOutput = execFileSync(command, [...baseArgs, "auth", "token", "--json"], {
    encoding: "utf8",
    env,
  });
  const tokenPayload = parseWranglerJson(tokenOutput, "wrangler auth token --json");

  if (!accountId) {
    const whoamiOutput = execFileSync(command, [...baseArgs, "whoami", "--json"], {
      encoding: "utf8",
      env,
    });
    const whoamiPayload = parseWranglerJson(whoamiOutput, "wrangler whoami --json");
    accountId = pickAccountIdFromWhoami(whoamiPayload);
  }

  if ((tokenPayload?.type === "api_token" || tokenPayload?.type === "oauth") && tokenPayload.token) {
    return {
      accountId,
      auth: {
        type: tokenPayload.type,
        token: tokenPayload.token,
      },
      source: "wrangler",
    };
  }

  throw new Error("wrangler auth token --json returned an unsupported auth payload.");
}

export function extractWorkerLogEvents(payload) {
  const result = payload?.result ?? payload ?? {};
  if (Array.isArray(result?.events?.events)) {
    return result.events.events;
  }
  if (Array.isArray(result)) {
    return result;
  }
  if (Array.isArray(result.events)) {
    return result.events;
  }
  if (Array.isArray(result.rows)) {
    return result.rows;
  }
  if (Array.isArray(result.data)) {
    return result.data;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

function summarizeCounts(events, keyFn) {
  const counts = new Map();
  for (const event of events) {
    const key = keyFn(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

export function formatWorkerLogQueryResult(payload, options) {
  const events = extractWorkerLogEvents(payload);
  if (options.format === "json") {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }
  if (options.format === "ndjson") {
    return `${events.map((event) => JSON.stringify(event)).join("\n")}${events.length > 0 ? "\n" : ""}`;
  }

  const lines = [];
  lines.push(`events=${events.length}`);
  if (Array.isArray(payload?.result) && payload.result.length > 0 && !payload.result[0]?.source) {
    const sampleColumns = Object.keys(payload.result[0]).slice(0, 8);
    lines.push(`columns=${sampleColumns.join(", ")}`);
    for (const row of payload.result.slice(0, 10)) {
      lines.push(JSON.stringify(row));
    }
    return `${lines.join("\n")}\n`;
  }
  const byScope = summarizeCounts(events, (event) => event?.source?.scope ?? "(none)");
  if (byScope.length > 0) {
    lines.push(
      `scope_counts=${byScope
        .slice(0, 8)
        .map(([scope, count]) => `${scope}:${count}`)
        .join(", ")}`
    );
  }
  const byEvent = summarizeCounts(events, (event) => event?.source?.event ?? "(none)");
  if (byEvent.length > 0) {
    lines.push(
      `event_counts=${byEvent
        .slice(0, 10)
        .map(([name, count]) => `${name}:${count}`)
        .join(", ")}`
    );
  }
  for (const event of events.slice(0, 10)) {
    const timestamp = event?.timestamp ?? event?.source?.ts ?? "(no-ts)";
    const scope = event?.source?.scope ?? "(no-scope)";
    const name = event?.source?.event ?? "(no-event)";
    const shard = event?.source?.shard ? ` shard=${event.source.shard}` : "";
    const requestId = event?.$metadata?.requestId ? ` requestId=${event.$metadata.requestId}` : "";
    lines.push(`${timestamp} ${scope}.${name}${shard}${requestId}`);
  }
  return `${lines.join("\n")}\n`;
}

export function printWorkerLogQueryHelp() {
  return `Query stored Cloudflare Worker logs via Workers Observability.

Usage:
  pnpm logs:server:query [options]

Options:
  -a, --account-id <id>   Cloudflare account ID (default: CLOUDFLARE_LOG_QUERY_ACCOUNT_ID, then CLOUDFLARE_ACCOUNT_ID, else wrangler whoami)
  --api-token <token>     Cloudflare API token (default: CLOUDFLARE_LOG_QUERY_API_TOKEN, then CLOUDFLARE_API_TOKEN, else wrangler auth token)
  -w, --worker <name>     Worker script name (default: ${DEFAULT_WORKER})
  --dataset <name>        Telemetry dataset (default: ${DEFAULT_DATASET})
  --view <name>           events | adaptive_groups | timeseries | initial (default: ${DEFAULT_VIEW})
  --format <name>         summary | json | ndjson (default: ${DEFAULT_FORMAT})
  --limit <n>             Max rows to request (default: ${DEFAULT_LIMIT})
  --last <dur>            Lookback window, e.g. 15m, 2h, 1d (default: ${DEFAULT_LAST_MINUTES}m)
  --from <iso>            Inclusive timeframe start
  --to <iso>              Exclusive timeframe end
  -o, --output <file>     Write output to file
  --request-id <id>       Filter on $metadata.requestId
  --trace-id <id>         Filter on source.trace_id
  --uid <id>              Filter on source.uid
  --cid <id>              Filter on source.cid
  --scope <name>          Filter on source.scope
  --event <name>          Filter on source.event
  --shard <id>            Filter on source.shard
  --method <verb>         Filter on request method
  --path <path>           Filter on request path
  --outcome <name>        Filter on $workers.outcome
  --filter <spec>         Extra filter: key:operation:value or key:operation:type:value
  --dry-run               Print the request body without calling Cloudflare
  -h, --help              Show this help

Examples:
  pnpm logs:server:query --last 10m --event internal_error
  pnpm logs:server:query --last 5m --trace-id ctrace_123 --format ndjson
  pnpm logs:server:query --from 2026-03-07T09:52:00Z --to 2026-03-07T09:53:00Z --path /cursor-state --event cursor_pull_peer
`;
}
