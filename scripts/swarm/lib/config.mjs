import path from "node:path";
import { normalizeScenarioId } from "../scenarios/pool.mjs";

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function argValue(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseNumber(raw, flag) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric value for ${flag}: ${raw}`);
  }
  return value;
}

export function defaultSwarmBotConfig({
  env = process.env,
  resolvePath = path.resolve,
  makeTimestamp = timestamp,
} = {}) {
  const runId = `manual-${makeTimestamp()}`;
  const botId = `bot-${makeTimestamp()}`;
  const output = resolvePath("logs", "swarm", runId, "bots", `${botId}.ndjson`);

  return {
    wsUrl: env.SOC_SWARM_WS_URL ?? env.SOC_TEST_WS_URL ?? "ws://127.0.0.1:8787/ws",
    runId,
    botId,
    clientSessionId: `swarm_${runId}_${botId}`,
    output,
    summaryOutput: resolvePath(path.dirname(output), `${botId}-summary.json`),
    scenarioId: "spread-editing",
    durationMs: 30_000,
    originX: 900_000_000,
    originY: -900_000_000,
    cursorIntervalMs: 1_000,
    setCellIntervalMs: 3_000,
    reconnectDelayMs: 1_000,
    readonly: false,
    help: false,
  };
}

export function parseSwarmBotArgs(argv, options = {}) {
  const config = defaultSwarmBotConfig(options);
  let outputProvided = false;
  let summaryProvided = false;
  let clientSessionIdProvided = false;
  const args = [...argv];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      config.help = true;
      continue;
    }
    if (arg === "--ws-url") {
      config.wsUrl = argValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--ws-url=")) {
      config.wsUrl = arg.slice("--ws-url=".length);
      continue;
    }
    if (arg === "--run-id") {
      config.runId = argValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--run-id=")) {
      config.runId = arg.slice("--run-id=".length);
      continue;
    }
    if (arg === "--bot-id") {
      config.botId = argValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--bot-id=")) {
      config.botId = arg.slice("--bot-id=".length);
      continue;
    }
    if (arg === "--scenario-id") {
      config.scenarioId = normalizeScenarioId(argValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--scenario-id=")) {
      config.scenarioId = normalizeScenarioId(arg.slice("--scenario-id=".length));
      continue;
    }
    if (arg === "--client-session-id") {
      config.clientSessionId = argValue(args, index, arg);
      clientSessionIdProvided = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--client-session-id=")) {
      config.clientSessionId = arg.slice("--client-session-id=".length);
      clientSessionIdProvided = true;
      continue;
    }
    if (arg === "--output") {
      config.output = options.resolvePath ? options.resolvePath(argValue(args, index, arg)) : path.resolve(argValue(args, index, arg));
      outputProvided = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      const raw = arg.slice("--output=".length);
      config.output = options.resolvePath ? options.resolvePath(raw) : path.resolve(raw);
      outputProvided = true;
      continue;
    }
    if (arg === "--summary-output") {
      config.summaryOutput = options.resolvePath ? options.resolvePath(argValue(args, index, arg)) : path.resolve(argValue(args, index, arg));
      summaryProvided = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--summary-output=")) {
      const raw = arg.slice("--summary-output=".length);
      config.summaryOutput = options.resolvePath ? options.resolvePath(raw) : path.resolve(raw);
      summaryProvided = true;
      continue;
    }
    if (arg === "--duration-ms") {
      config.durationMs = parseNumber(argValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--duration-ms=")) {
      config.durationMs = parseNumber(arg.slice("--duration-ms=".length), "--duration-ms");
      continue;
    }
    if (arg === "--origin-x") {
      config.originX = parseNumber(argValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--origin-x=")) {
      config.originX = parseNumber(arg.slice("--origin-x=".length), "--origin-x");
      continue;
    }
    if (arg === "--origin-y") {
      config.originY = parseNumber(argValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--origin-y=")) {
      config.originY = parseNumber(arg.slice("--origin-y=".length), "--origin-y");
      continue;
    }
    if (arg === "--cursor-interval-ms") {
      config.cursorIntervalMs = parseNumber(argValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--cursor-interval-ms=")) {
      config.cursorIntervalMs = parseNumber(arg.slice("--cursor-interval-ms=".length), "--cursor-interval-ms");
      continue;
    }
    if (arg === "--setcell-interval-ms") {
      config.setCellIntervalMs = parseNumber(argValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--setcell-interval-ms=")) {
      config.setCellIntervalMs = parseNumber(arg.slice("--setcell-interval-ms=".length), "--setcell-interval-ms");
      continue;
    }
    if (arg === "--reconnect-delay-ms") {
      config.reconnectDelayMs = parseNumber(argValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--reconnect-delay-ms=")) {
      config.reconnectDelayMs = parseNumber(arg.slice("--reconnect-delay-ms=".length), "--reconnect-delay-ms");
      continue;
    }
    if (arg === "--readonly") {
      config.readonly = true;
      continue;
    }
    if (arg === "--no-readonly") {
      config.readonly = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!config.help) {
    if (config.durationMs <= 0) {
      throw new Error(`Invalid --duration-ms value: ${config.durationMs}`);
    }
    if (config.cursorIntervalMs <= 0) {
      throw new Error(`Invalid --cursor-interval-ms value: ${config.cursorIntervalMs}`);
    }
    if (config.setCellIntervalMs < 0) {
      throw new Error(`Invalid --setcell-interval-ms value: ${config.setCellIntervalMs}`);
    }
    if (config.reconnectDelayMs < 0) {
      throw new Error(`Invalid --reconnect-delay-ms value: ${config.reconnectDelayMs}`);
    }
  }

  const resolvePath = options.resolvePath ?? path.resolve;
  if (!outputProvided) {
    config.output = resolvePath("logs", "swarm", config.runId, "bots", `${config.botId}.ndjson`);
  }
  if (!clientSessionIdProvided || typeof config.clientSessionId !== "string" || config.clientSessionId.trim().length === 0) {
    config.clientSessionId = `swarm_${config.runId}_${config.botId}`;
  }
  if (!summaryProvided) {
    config.summaryOutput = resolvePath(path.dirname(config.output), `${config.botId}-summary.json`);
  }

  return config;
}

export function swarmBotHelpText() {
  return `Run one live backend swarm bot.

Usage:
  pnpm swarm:bot [options]

Options:
  --ws-url <url>                WebSocket URL (default: SOC_SWARM_WS_URL or ws://127.0.0.1:8787/ws)
  --run-id <id>                 Run identifier for logs
  --bot-id <id>                 Bot identifier for logs
  --scenario-id <id>            Scenario id
  --client-session-id <id>      Stable session correlation id for worker logs
  --output <file>               NDJSON event log output path
  --summary-output <file>       Summary JSON output path
  --duration-ms <n>             Total runtime in ms (default: 30000)
  --origin-x <n>                World x coordinate for the remote test origin
  --origin-y <n>                World y coordinate for the remote test origin
  --cursor-interval-ms <n>      Cursor send interval in ms (default: 1000)
  --setcell-interval-ms <n>     setCell send interval in ms (default: 3000, 0 disables)
  --reconnect-delay-ms <n>      Reconnect delay after close (default: 1000)
  --readonly                    Disable setCell traffic
  -h, --help                    Show this help
`;
}
