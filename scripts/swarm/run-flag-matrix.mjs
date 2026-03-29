#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import {
  buildSocketUrl,
  decodeServerMessageBinary,
  encodeClientMessageBinary,
  toUint8Array,
} from "./lib/protocol.mjs";

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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

function defaultConfig() {
  const runId = `flag-matrix-${timestamp()}`;
  const runDir = path.resolve("logs", "swarm", runId);
  return {
    runId,
    runDir,
    port: 8787,
    botCount: 2,
    durationMs: 6_000,
    help: false,
  };
}

function parseArgs(argv) {
  const config = defaultConfig();
  const args = [...argv];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      config.help = true;
      continue;
    }
    if (arg === "--run-id") {
      config.runId = argValue(args, index, arg);
      config.runDir = path.resolve("logs", "swarm", config.runId);
      index += 1;
      continue;
    }
    if (arg.startsWith("--run-id=")) {
      config.runId = arg.slice("--run-id=".length);
      config.runDir = path.resolve("logs", "swarm", config.runId);
      continue;
    }
    if (arg === "--run-dir") {
      config.runDir = path.resolve(argValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--run-dir=")) {
      config.runDir = path.resolve(arg.slice("--run-dir=".length));
      continue;
    }
    if (arg === "--port") {
      config.port = parseNumber(argValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      config.port = parseNumber(arg.slice("--port=".length), "--port");
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!config.help) {
    if (!Number.isInteger(config.botCount) || config.botCount <= 0) {
      throw new Error(`Invalid --bot-count value: ${config.botCount}`);
    }
    if (config.durationMs <= 0) {
      throw new Error(`Invalid --duration-ms value: ${config.durationMs}`);
    }
    if (!Number.isInteger(config.port) || config.port <= 0) {
      throw new Error(`Invalid --port value: ${config.port}`);
    }
  }

  return config;
}

function helpText() {
  return `Run the local runtime-flag swarm matrix.

Usage:
  pnpm swarm:flags [options]

Options:
  --run-id <id>                 Run identifier
  --run-dir <dir>               Output directory
  --port <n>                    Local Wrangler port (default: 8787)
  --bot-count <n>               Bots per swarm run (default: 2)
  --duration-ms <n>             Swarm duration per active case (default: 6000)
  -h, --help                    Show this help
`;
}

function baseUrls(port) {
  return {
    httpBaseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  };
}

function caseId(flags) {
  return [
    `app${flags.APP_DISABLED}`,
    `ro${flags.READONLY_MODE}`,
    `anon${flags.ANON_AUTH_ENABLED}`,
    `share${flags.SHARE_LINKS_ENABLED}`,
  ].join("-");
}

function enumerateCases() {
  const out = [];
  for (const appDisabled of ["0", "1"]) {
    for (const readOnly of ["0", "1"]) {
      for (const anonAuth of ["1", "0"]) {
        for (const shareLinks of ["1", "0"]) {
          const flags = {
            APP_DISABLED: appDisabled,
            READONLY_MODE: readOnly,
            ANON_AUTH_ENABLED: anonAuth,
            SHARE_LINKS_ENABLED: shareLinks,
          };
          out.push({
            id: caseId(flags),
            flags,
          });
        }
      }
    }
  }
  return out;
}

function caseDirectories(runDir, id) {
  const dir = path.resolve(runDir, "cases", id);
  return {
    dir,
    workerLog: path.resolve(dir, "worker.log"),
    swarmDir: path.resolve(dir, "swarm"),
  };
}

function startWorker({ flags, logFile, port }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logStream = fs.createWriteStream(logFile, { flags: "w" });
  const args = [
    "dlx",
    "wrangler",
    "dev",
    "--local",
    "--config",
    "wrangler.jsonc",
    "--port",
    String(port),
    "--var",
    `APP_DISABLED:${flags.APP_DISABLED}`,
    "--var",
    `READONLY_MODE:${flags.READONLY_MODE}`,
    "--var",
    `ANON_AUTH_ENABLED:${flags.ANON_AUTH_ENABLED}`,
    "--var",
    `SHARE_LINKS_ENABLED:${flags.SHARE_LINKS_ENABLED}`,
  ];
  const child = spawn("pnpm", args, {
    cwd: path.resolve("apps", "worker"),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  return {
    child,
    logStream,
  };
}

async function stopWorker(worker) {
  if (!worker) {
    return;
  }
  const { child, logStream } = worker;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGINT");
    await Promise.race([
      waitForExit(child),
      sleep(2_000),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
  logStream.end();
  await sleep(250);
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function waitForHealth({ httpBaseUrl, expectedStatus, expectedReason = null, timeoutMs = 15_000 }) {
  const startedAt = Date.now();
  let lastError = null;
  while ((Date.now() - startedAt) <= timeoutMs) {
    try {
      const response = await fetch(`${httpBaseUrl}/health`);
      const payload = await response.json();
      if (response.status === expectedStatus) {
        if (expectedReason === null && payload?.ok === true) {
          return {
            status: response.status,
            payload,
          };
        }
        if (expectedReason !== null && payload?.reason === expectedReason) {
          return {
            status: response.status,
            payload,
          };
        }
      }
      lastError = `Unexpected /health response ${response.status}: ${JSON.stringify(payload)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for /health (${expectedStatus}${expectedReason ? ` ${expectedReason}` : ""}): ${lastError ?? "no response"}`);
}

async function postShareLink(httpBaseUrl) {
  const response = await fetch(`${httpBaseUrl}/share-links`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      x: 10,
      y: -10,
      zoom: 16,
    }),
  });
  return {
    status: response.status,
    payload: await safeJson(response),
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function probeUpgradeStatus({ httpBaseUrl, token = "" }) {
  const url = new URL("/ws", httpBaseUrl);
  if (token) {
    url.searchParams.set("token", token);
  }
  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
    });

    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({
        status: response.statusCode ?? 101,
        body: "",
      });
    });

    request.on("error", reject);
    request.end();
  });
}

async function openHelloSocket({ wsUrl, token = "", clientSessionId }) {
  const url = buildSocketUrl(wsUrl, token, clientSessionId);
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const hello = await waitForSocketMessage(socket, (message) => message?.t === "hello");
  return {
    socket,
    hello,
  };
}

function waitForSocketMessage(socket, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };

    const onMessage = (event) => {
      const payload = toUint8Array(event.data);
      if (!payload) {
        return;
      }
      try {
        const decoded = decodeServerMessageBinary(payload);
        if (!predicate(decoded)) {
          return;
        }
        cleanup();
        resolve(decoded);
      } catch {
        // Ignore unrelated decode failures.
      }
    };

    const onError = () => {
      cleanup();
      reject(new Error("WebSocket error"));
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before expected message"));
    };

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

async function acquireAnonymousTokens({ wsUrl, count }) {
  const tokens = [];
  for (let index = 0; index < count; index += 1) {
    const { socket, hello } = await openHelloSocket({
      wsUrl,
      clientSessionId: `flag-matrix-seed-${index + 1}`,
    });
    tokens.push(hello.token);
    socket.close();
  }
  return tokens;
}

async function anonymousHello(wsUrl, suffix) {
  const { socket, hello } = await openHelloSocket({
    wsUrl,
    clientSessionId: `flag-matrix-anon-${suffix}`,
  });
  socket.close();
  return {
    uid: hello.uid,
    tokenPrefix: String(hello.token ?? "").slice(0, 12),
  };
}

async function probeReadonlyWrite({ wsUrl, token, suffix }) {
  const { socket } = await openHelloSocket({
    wsUrl,
    token,
    clientSessionId: `flag-matrix-readonly-${suffix}`,
  });

  try {
    socket.send(encodeClientMessageBinary({
      t: "sub",
      cid: `readonly-sub-${suffix}`,
      tiles: ["0:0"],
    }));
    await waitForSocketMessage(socket, (message) => message?.t === "subAck");

    socket.send(encodeClientMessageBinary({
      t: "setCell",
      tile: "0:0",
      i: 22,
      v: 1,
      op: `readonly-op-${suffix}`,
    }));

    const error = await waitForSocketMessage(
      socket,
      (message) => message?.t === "err" && typeof message.code === "string"
    );

    return {
      code: error.code,
      msg: error.msg,
    };
  } finally {
    socket.close();
  }
}

function spawnCommand({ command, args, cwd, outputFile }) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const output = fs.createWriteStream(outputFile, { flags: "w" });
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  return {
    child,
    output,
  };
}

async function runSwarmCase({ rootDir, caseDir, caseConfig, config, wsUrl, httpBaseUrl, botTokens }) {
  fs.mkdirSync(caseDir.swarmDir, { recursive: true });
  const outputFile = path.resolve(caseDir.dir, "swarm-command.log");
  const args = [
    "swarm:run",
    "--run-id",
    `${config.runId}-${caseConfig.id}`,
    "--run-dir",
    caseDir.swarmDir,
    "--ws-url",
    wsUrl,
    "--app-url",
    httpBaseUrl,
    "--bot-count",
    String(config.botCount),
    "--duration-ms",
    String(config.durationMs),
    "--scenario-pool",
    caseConfig.flags.READONLY_MODE === "1" ? "read-only-lurker" : "spread-editing,read-only-lurker",
  ];

  for (const token of botTokens) {
    if (typeof token === "string" && token.length > 0) {
      args.push("--bot-token", token);
    }
  }

  const command = spawnCommand({
    command: "pnpm",
    args,
    cwd: rootDir,
    outputFile,
  });

  const exit = await waitForExit(command.child);
  command.output.end();
  const summaryPath = path.resolve(caseDir.swarmDir, "summary.json");
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  return {
    exit,
    summaryPath,
    commandLog: outputFile,
    summary,
  };
}

function assertCase(caseConfig, result) {
  const { flags } = caseConfig;
  const isAppDisabled = flags.APP_DISABLED === "1";
  const isReadOnly = flags.READONLY_MODE === "1";
  const isAnonEnabled = flags.ANON_AUTH_ENABLED === "1";
  const isShareEnabled = flags.SHARE_LINKS_ENABLED === "1";

  if (isAppDisabled) {
    if (result.health?.status !== 503 || result.health?.payload?.reason !== "app_disabled") {
      throw new Error("Expected app-disabled /health response");
    }
    if (result.shareCreate?.status !== 503 || result.shareCreate?.payload?.code !== "app_disabled") {
      throw new Error("Expected app-disabled share-link response");
    }
    if (result.wsUpgrade?.status !== 503) {
      throw new Error("Expected app-disabled websocket rejection");
    }
    return;
  }

  if (result.health?.status !== 200 || result.health?.payload?.ok !== true) {
    throw new Error("Expected healthy /health response");
  }

  if (isShareEnabled) {
    if (result.shareCreate?.status !== 200 || typeof result.shareCreate?.payload?.id !== "string") {
      throw new Error("Expected share-link creation to succeed");
    }
  } else if (result.shareCreate?.status !== 503 || result.shareCreate?.payload?.code !== "share_links_disabled") {
    throw new Error("Expected share-links-disabled response");
  }

  if (isAnonEnabled) {
    if (typeof result.anonymousHello?.uid !== "string" || result.anonymousHello.uid.length === 0) {
      throw new Error("Expected anonymous websocket bootstrap to succeed");
    }
  } else if (result.wsUpgrade?.status !== 401) {
    throw new Error("Expected anonymous websocket bootstrap to be rejected");
  }

  if (isReadOnly) {
    if (result.readonlyWrite?.code !== "app_readonly") {
      throw new Error("Expected read-only websocket write rejection");
    }
  }

  const swarm = result.swarm?.summary;
  if (!swarm) {
    throw new Error("Missing swarm summary");
  }
  if (result.swarm?.exit?.code !== 0) {
    throw new Error(`Swarm command exited ${result.swarm?.exit?.code}`);
  }
  if (!String(swarm?.assessment?.status ?? "").startsWith("pass")) {
    throw new Error(`Unexpected swarm assessment: ${swarm?.assessment?.status ?? "unknown"}`);
  }
  if (isReadOnly && (swarm?.counters?.setCellSent ?? 0) !== 0) {
    throw new Error("Readonly swarm unexpectedly sent writes");
  }
  if (!isReadOnly && (swarm?.counters?.setCellResolved ?? 0) <= 0) {
    throw new Error("Writable swarm did not resolve any writes");
  }
  if (isShareEnabled && typeof swarm?.shareLink?.url !== "string") {
    throw new Error("Expected swarm share link to be created");
  }
  if (!isShareEnabled && swarm?.shareLink) {
    throw new Error("Expected swarm share link to be absent when sharing is disabled");
  }
}

function formatSummaryText(runId, results) {
  const lines = [
    `Run ${runId}`,
    `Cases: ${results.length}`,
    `Passed: ${results.filter((result) => result.ok).length}`,
    `Failed: ${results.filter((result) => !result.ok).length}`,
    "",
  ];

  for (const result of results) {
    lines.push(`${result.ok ? "PASS" : "FAIL"} ${result.id}`);
    lines.push(
      `  flags app=${result.flags.APP_DISABLED} ro=${result.flags.READONLY_MODE} anon=${result.flags.ANON_AUTH_ENABLED} share=${result.flags.SHARE_LINKS_ENABLED}`
    );
    lines.push(
      `  health=${result.health?.status ?? "n/a"} shareCreate=${result.shareCreate?.status ?? "n/a"} ws=${result.wsUpgrade?.status ?? "n/a"}`
    );
    if (result.readonlyWrite) {
      lines.push(`  readonlyWrite=${result.readonlyWrite.code}`);
    }
    if (result.swarm?.summary) {
      lines.push(
        `  swarm=${result.swarm.summary.assessment?.status ?? "n/a"} setCellResolved=${result.swarm.summary.counters?.setCellResolved ?? 0} shareLink=${result.swarm.summary.shareLink ? "yes" : "no"}`
      );
    }
    if (!result.ok) {
      lines.push(`  error=${result.error}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function runCase({ caseConfig, config, reusableTokens, rootDir }) {
  const urls = baseUrls(config.port);
  const dirs = caseDirectories(config.runDir, caseConfig.id);
  const worker = startWorker({
    flags: caseConfig.flags,
    logFile: dirs.workerLog,
    port: config.port,
  });
  const result = {
    id: caseConfig.id,
    flags: caseConfig.flags,
    ok: false,
  };

  try {
    result.health = await waitForHealth({
      httpBaseUrl: urls.httpBaseUrl,
      expectedStatus: caseConfig.flags.APP_DISABLED === "1" ? 503 : 200,
      expectedReason: caseConfig.flags.APP_DISABLED === "1" ? "app_disabled" : null,
    });

    result.shareCreate = await postShareLink(urls.httpBaseUrl);
    result.wsUpgrade = await probeUpgradeStatus({
      httpBaseUrl: urls.httpBaseUrl,
    });

    if (caseConfig.flags.APP_DISABLED !== "1") {
      if (caseConfig.flags.ANON_AUTH_ENABLED === "1") {
        result.anonymousHello = await anonymousHello(urls.wsUrl, caseConfig.id);
      }

      if (caseConfig.flags.READONLY_MODE === "1") {
        const readonlyToken = caseConfig.flags.ANON_AUTH_ENABLED === "1" ? "" : (reusableTokens[0] ?? "");
        result.readonlyWrite = await probeReadonlyWrite({
          wsUrl: urls.wsUrl,
          token: readonlyToken,
          suffix: caseConfig.id,
        });
      }

      result.swarm = await runSwarmCase({
        rootDir,
        caseDir: dirs,
        caseConfig,
        config,
        wsUrl: urls.wsUrl,
        httpBaseUrl: urls.httpBaseUrl,
        botTokens: caseConfig.flags.ANON_AUTH_ENABLED === "1" ? [] : reusableTokens,
      });
    }

    assertCase(caseConfig, result);
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await stopWorker(worker);
  }

  return result;
}

async function acquireReusableTokensForMatrix(config) {
  const urls = baseUrls(config.port);
  const worker = startWorker({
    flags: {
      APP_DISABLED: "0",
      READONLY_MODE: "0",
      ANON_AUTH_ENABLED: "1",
      SHARE_LINKS_ENABLED: "1",
    },
    logFile: path.resolve(config.runDir, "token-seed-worker.log"),
    port: config.port,
  });

  try {
    await waitForHealth({
      httpBaseUrl: urls.httpBaseUrl,
      expectedStatus: 200,
    });
    return await acquireAnonymousTokens({
      wsUrl: urls.wsUrl,
      count: config.botCount,
    });
  } finally {
    await stopWorker(worker);
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    console.log(helpText());
    return;
  }

  const rootDir = process.cwd();
  fs.mkdirSync(config.runDir, { recursive: true });
  const reusableTokens = await acquireReusableTokensForMatrix(config);
  const results = [];

  for (const caseConfig of enumerateCases()) {
    const result = await runCase({
      caseConfig,
      config,
      reusableTokens,
      rootDir,
    });
    results.push(result);
  }

  const summary = {
    runId: config.runId,
    runDir: config.runDir,
    botCount: config.botCount,
    durationMs: config.durationMs,
    caseCount: results.length,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
  const summaryJsonPath = path.resolve(config.runDir, "matrix-summary.json");
  const summaryTextPath = path.resolve(config.runDir, "matrix-summary.txt");
  fs.writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(summaryTextPath, formatSummaryText(config.runId, results));

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
