#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function printHelp() {
  console.log(`Capture Cloudflare Worker logs via wrangler tail.

Usage:
  pnpm logs:server:capture [options] [-- <extra wrangler args>]

Options:
  -o, --output <file>     Output file path (default: logs/server-<timestamp>.log)
  -c, --config <file>     Wrangler config path (default: apps/worker/wrangler.jsonc)
  -w, --worker <name>     Worker name to tail (default: sea-of-checkboxes-worker)
  -f, --format <format>   Wrangler tail format: json | pretty (default: json)
  --settle-ms <n>         Wait this long after Ctrl+C before stopping tail (default: 5000)
  --stop-timeout-ms <n>   Force-stop tail if it does not exit after shutdown (default: 5000)
  -h, --help              Show this help

Examples:
  pnpm logs:server:capture
  pnpm logs:server:capture --worker sea-of-checkboxes-worker --format pretty
  pnpm logs:server:capture --settle-ms 10000
  pnpm logs:server:capture -- --status error
`);
}

function buildTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function resolveArgValue(args, index, flagName) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function parseIntegerArg(rawValue, flagName) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid value for ${flagName}: ${rawValue}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    output: path.resolve("logs", `server-${buildTimestamp()}.log`),
    config: path.resolve("apps", "worker", "wrangler.jsonc"),
    worker: "sea-of-checkboxes-worker",
    format: "json",
    settleMs: 5_000,
    stopTimeoutMs: 5_000,
    passthroughArgs: [],
    help: false,
  };

  const args = [...argv];
  let passthroughMode = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (passthroughMode) {
      options.passthroughArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      passthroughMode = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "-o" || arg === "--output") {
      const value = resolveArgValue(args, index, arg);
      options.output = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = path.resolve(arg.slice("--output=".length));
      continue;
    }
    if (arg === "-c" || arg === "--config") {
      const value = resolveArgValue(args, index, arg);
      options.config = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      options.config = path.resolve(arg.slice("--config=".length));
      continue;
    }
    if (arg === "-w" || arg === "--worker") {
      options.worker = resolveArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--worker=")) {
      options.worker = arg.slice("--worker=".length).trim();
      continue;
    }
    if (arg === "-f" || arg === "--format") {
      options.format = resolveArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--format=")) {
      options.format = arg.slice("--format=".length);
      continue;
    }
    if (arg === "--settle-ms") {
      options.settleMs = parseIntegerArg(resolveArgValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--settle-ms=")) {
      options.settleMs = parseIntegerArg(arg.slice("--settle-ms=".length), "--settle-ms");
      continue;
    }
    if (arg === "--stop-timeout-ms") {
      options.stopTimeoutMs = parseIntegerArg(resolveArgValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--stop-timeout-ms=")) {
      options.stopTimeoutMs = parseIntegerArg(
        arg.slice("--stop-timeout-ms=".length),
        "--stop-timeout-ms"
      );
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.format !== "json" && options.format !== "pretty") {
    throw new Error(`Invalid format: ${options.format}. Use "json" or "pretty".`);
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

fs.mkdirSync(path.dirname(options.output), { recursive: true });
const fileStream = fs.createWriteStream(options.output, { flags: "a" });

const wranglerArgs = ["dlx", "wrangler", "tail"];
if (options.worker) {
  wranglerArgs.push(options.worker);
}
wranglerArgs.push("--config", options.config, "--format", options.format);
if (options.passthroughArgs.length > 0) {
  wranglerArgs.push(...options.passthroughArgs);
}

const startedAt = new Date().toISOString();
const commandPreview = `pnpm ${wranglerArgs.join(" ")}`;
fileStream.write(`# started_at=${startedAt}\n`);
fileStream.write(`# command=${commandPreview}\n`);
fileStream.write(`# settle_ms=${options.settleMs}\n`);
fileStream.write(`# stop_timeout_ms=${options.stopTimeoutMs}\n`);
console.log(`Capturing worker logs to ${options.output}`);
console.log(`Running: ${commandPreview}`);
console.log(`Press Ctrl+C to stop. The script will wait ${options.settleMs}ms for late logs first.\n`);

const child = spawn("pnpm", wranglerArgs, {
  stdio: ["inherit", "pipe", "pipe"],
  env: process.env,
});

function writeChunk(prefix, chunk) {
  const text = chunk.toString();
  fileStream.write(text);
  if (prefix === "stdout") {
    process.stdout.write(text);
  } else {
    process.stderr.write(text);
  }
}

child.stdout.on("data", (chunk) => writeChunk("stdout", chunk));
child.stderr.on("data", (chunk) => writeChunk("stderr", chunk));

let shuttingDown = false;
let stopRequested = false;
let settleTimer = null;
let stopTimer = null;

function beginShutdown(signal, stopMode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  fileStream.write(`\n# stop_signal=${signal}\n`);
  fileStream.write(`# stop_mode=${stopMode}\n`);
  child.kill("SIGINT");

  if (options.stopTimeoutMs > 0) {
    stopTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        const forcedAt = new Date().toISOString();
        fileStream.write(`# force_stop_at=${forcedAt}\n`);
        child.kill("SIGTERM");
      }
    }, options.stopTimeoutMs);
  }
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  if (stopRequested || options.settleMs === 0) {
    beginShutdown(signal, stopRequested ? "forced" : "immediate");
    return;
  }

  stopRequested = true;
  const requestedAt = new Date().toISOString();
  fileStream.write(`\n# stop_requested_at=${requestedAt}\n`);
  console.log(
    `Stop requested. Waiting ${options.settleMs}ms for late-arriving logs before stopping. Press Ctrl+C again to force stop now.`
  );
  settleTimer = setTimeout(() => beginShutdown(signal, "settled"), options.settleMs);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

child.on("error", (error) => {
  console.error(`Failed to start wrangler tail: ${error.message}`);
  fileStream.end(() => process.exit(1));
});

child.on("exit", (code, signal) => {
  if (settleTimer) {
    clearTimeout(settleTimer);
  }
  if (stopTimer) {
    clearTimeout(stopTimer);
  }
  if (!shuttingDown) {
    const endedAt = new Date().toISOString();
    fileStream.write(`\n# ended_at=${endedAt}\n`);
    fileStream.write(`# signal=${signal ?? "none"}\n`);
  } else {
    const endedAt = new Date().toISOString();
    fileStream.write(`# ended_at=${endedAt}\n`);
    fileStream.write(`# signal=${signal ?? "none"}\n`);
  }

  fileStream.end(() => {
    if (typeof code === "number") {
      process.exit(code);
    }
    process.exit(signal ? 1 : 0);
  });
});
