import fs from "node:fs";
import path from "node:path";
import { buildScenarioAssignments } from "../scenarios/assignment.mjs";
import { defaultScenarioPool, parseScenarioPool } from "../scenarios/pool.mjs";

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

export function defaultRunSwarmConfig({
  env = process.env,
  resolvePath = path.resolve,
  makeTimestamp = timestamp,
} = {}) {
  const runId = `swarm-${makeTimestamp()}`;
  const runDir = resolvePath("logs", "swarm", runId);
  return {
    wsUrl: env.SOC_SWARM_WS_URL ?? env.SOC_TEST_WS_URL ?? "ws://127.0.0.1:8787/ws",
    appUrl: env.SOC_SWARM_APP_URL ?? env.SOC_TEST_APP_URL ?? "",
    runId,
    runDir,
    coordinatorLog: resolvePath(runDir, "coordinator.log"),
    summaryOutput: resolvePath(runDir, "summary.json"),
    botCount: 2,
    durationMs: 10_000,
    originX: 900_000_000,
    originY: -900_000_000,
    cursorIntervalMs: 1_000,
    setCellIntervalMs: 3_000,
    reconnectDelayMs: 1_000,
    killAfterMs: 2_000,
    scenarioPool: defaultScenarioPool(),
    help: false,
  };
}

export function parseRunSwarmArgs(argv, options = {}) {
  const resolvePath = options.resolvePath ?? path.resolve;
  const config = defaultRunSwarmConfig({
    ...options,
    resolvePath,
  });
  let runDirProvided = false;
  let coordinatorLogProvided = false;
  let summaryProvided = false;
  const scenarioPoolValues = [];
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
    if (arg === "--app-url") {
      config.appUrl = argValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--app-url=")) {
      config.appUrl = arg.slice("--app-url=".length);
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
    if (arg === "--run-dir") {
      config.runDir = resolvePath(argValue(args, index, arg));
      runDirProvided = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--run-dir=")) {
      config.runDir = resolvePath(arg.slice("--run-dir=".length));
      runDirProvided = true;
      continue;
    }
    if (arg === "--coordinator-log") {
      config.coordinatorLog = resolvePath(argValue(args, index, arg));
      coordinatorLogProvided = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--coordinator-log=")) {
      config.coordinatorLog = resolvePath(arg.slice("--coordinator-log=".length));
      coordinatorLogProvided = true;
      continue;
    }
    if (arg === "--summary-output") {
      config.summaryOutput = resolvePath(argValue(args, index, arg));
      summaryProvided = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--summary-output=")) {
      config.summaryOutput = resolvePath(arg.slice("--summary-output=".length));
      summaryProvided = true;
      continue;
    }
    if (arg === "--bot-count") {
      config.botCount = parseNumber(argValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--bot-count=")) {
      config.botCount = parseNumber(arg.slice("--bot-count=".length), "--bot-count");
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
    if (arg === "--kill-after-ms") {
      config.killAfterMs = parseNumber(argValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--kill-after-ms=")) {
      config.killAfterMs = parseNumber(arg.slice("--kill-after-ms=".length), "--kill-after-ms");
      continue;
    }
    if (arg === "--scenario-pool" || arg === "--scenarios") {
      scenarioPoolValues.push(argValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--scenario-pool=")) {
      scenarioPoolValues.push(arg.slice("--scenario-pool=".length));
      continue;
    }
    if (arg.startsWith("--scenarios=")) {
      scenarioPoolValues.push(arg.slice("--scenarios=".length));
      continue;
    }
    if (arg === "--scenario") {
      scenarioPoolValues.push(argValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--scenario=")) {
      scenarioPoolValues.push(arg.slice("--scenario=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!config.help) {
    if (!Number.isInteger(config.botCount) || config.botCount <= 0) {
      throw new Error(`Invalid --bot-count value: ${config.botCount}`);
    }
    if (config.durationMs <= 0) {
      throw new Error(`Invalid --duration-ms value: ${config.durationMs}`);
    }
    if (config.killAfterMs < 0) {
      throw new Error(`Invalid --kill-after-ms value: ${config.killAfterMs}`);
    }
  }

  if (!runDirProvided) {
    config.runDir = resolvePath("logs", "swarm", config.runId);
  }
  if (!coordinatorLogProvided) {
    config.coordinatorLog = resolvePath(config.runDir, "coordinator.log");
  }
  if (!summaryProvided) {
    config.summaryOutput = resolvePath(config.runDir, "summary.json");
  }
  config.scenarioPool = parseScenarioPool(
    scenarioPoolValues.length > 0 ? scenarioPoolValues : config.scenarioPool
  );

  return config;
}

export function buildBotLaunchConfigs(config) {
  const scenarioAssignments = buildScenarioAssignments({
    scenarioPool: config.scenarioPool,
    botCount: config.botCount,
    originX: config.originX,
    originY: config.originY,
  });
  const bots = [];
  for (let index = 0; index < config.botCount; index += 1) {
    const botNumber = index + 1;
    const botId = `bot-${String(botNumber).padStart(3, "0")}`;
    const assignment = scenarioAssignments[index];
    const readonly = assignment.readonly;
    const scenarioId = assignment.scenarioId;
    const botOriginX = assignment.originX;
    const botOriginY = assignment.originY;
    bots.push({
      botId,
      scenarioId,
      readonly,
      originX: botOriginX,
      originY: botOriginY,
      output: path.resolve(config.runDir, "bots", `${botId}.ndjson`),
      summaryOutput: path.resolve(config.runDir, "bots", `${botId}-summary.json`),
      args: [
        "scripts/swarm/swarm-bot.mjs",
        "--ws-url",
        config.wsUrl,
        "--run-id",
        config.runId,
        "--bot-id",
        botId,
        "--scenario-id",
        scenarioId,
        "--output",
        path.resolve(config.runDir, "bots", `${botId}.ndjson`),
        "--summary-output",
        path.resolve(config.runDir, "bots", `${botId}-summary.json`),
        "--duration-ms",
        String(config.durationMs),
        "--origin-x",
        String(botOriginX),
        "--origin-y",
        String(botOriginY),
        "--cursor-interval-ms",
        String(config.cursorIntervalMs),
        "--setcell-interval-ms",
        String(readonly ? 0 : config.setCellIntervalMs),
        "--reconnect-delay-ms",
        String(config.reconnectDelayMs),
        ...(readonly ? ["--readonly"] : []),
      ],
    });
  }
  return bots;
}

export function writeRunConfig(config, botConfigs) {
  fs.mkdirSync(config.runDir, { recursive: true });
  fs.mkdirSync(path.resolve(config.runDir, "bots"), { recursive: true });
  const payload = {
    runId: config.runId,
    wsUrl: config.wsUrl,
    appUrl: config.appUrl,
    durationMs: config.durationMs,
    botCount: config.botCount,
    originX: config.originX,
    originY: config.originY,
    cursorIntervalMs: config.cursorIntervalMs,
    setCellIntervalMs: config.setCellIntervalMs,
    reconnectDelayMs: config.reconnectDelayMs,
    killAfterMs: config.killAfterMs,
    scenarioPool: config.scenarioPool,
    bots: botConfigs.map((bot) => ({
      botId: bot.botId,
      scenarioId: bot.scenarioId,
      readonly: bot.readonly,
      originX: bot.originX,
      originY: bot.originY,
      output: bot.output,
      summaryOutput: bot.summaryOutput,
    })),
  };
  fs.writeFileSync(path.resolve(config.runDir, "run-config.json"), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function runSwarmHelpText() {
  return `Run a short multi-bot swarm test.

Usage:
  pnpm swarm:run [options]

Options:
  --ws-url <url>                WebSocket URL (default: SOC_SWARM_WS_URL or ws://127.0.0.1:8787/ws)
  --app-url <url>               Human-facing web app URL used to build the share link
  --run-id <id>                 Run identifier
  --run-dir <dir>               Run output directory
  --coordinator-log <file>      Coordinator log file
  --summary-output <file>       Coordinator summary JSON
  --bot-count <n>               Number of bots to launch (default: 2)
  --duration-ms <n>             Bot runtime in ms (default: 10000)
  --origin-x <n>                Base world x coordinate
  --origin-y <n>                Base world y coordinate
  --cursor-interval-ms <n>      Cursor send interval in ms (default: 1000)
  --setcell-interval-ms <n>     setCell send interval in ms (default: 3000)
  --reconnect-delay-ms <n>      Reconnect delay in ms (default: 1000)
  --kill-after-ms <n>           Force-kill grace timeout after interrupt (default: 2000)
  --scenario-pool <ids>         Comma-separated scenario pool
  --scenario <id>               Append one scenario to the pool
  -h, --help                    Show this help
`;
}
