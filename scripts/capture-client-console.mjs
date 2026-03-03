#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  buildBrowserExitBeforeDevToolsError,
  buildDebugEndpointTimeoutError,
  formatLine,
  formatRemoteObject,
  makeUrl,
  parseClientCaptureArgs,
  pickPageTarget,
} from "./capture-client-console.lib.mjs";

function printHelp() {
  console.log(`Launch a browser test client and capture console logs to a file.

Usage:
  pnpm logs:client:capture [options]

Options:
  -u, --url <url>               App URL (default: SOC_TEST_URL or https://sea-of-checkboxes-web.pages.dev)
  -o, --output <file>           Output file (default: logs/client-<timestamp>.log)
  --browser-path <path>         Browser executable path (default: auto-detected Chrome/Chromium)
  --user-data-dir <dir>         Persistent profile dir when not in private mode
                                (default: .client-profile/chrome)
  --private                     Launch in private/incognito mode (default: off)
  --headless                    Launch browser headless (default: off)
  --timeout-ms <n>              DevTools connection timeout in ms (default: 15000)
  --app-logs                    Force URL param logs=protocol,ui,other (default: on)
  --no-app-logs                 Do not change URL logging params
  -h, --help                    Show this help

Examples:
  pnpm logs:client:capture --url https://sea-of-checkboxes.example.pages.dev
  pnpm logs:client:capture --private --output logs/client-private.log
`);
}

async function fetchJsonOnce(url, timeoutMs = 1_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function findBrowserPath(explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }

  const fromEnv = process.env.BROWSER_PATH?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Could not auto-detect a Chromium browser. Provide --browser-path or BROWSER_PATH."
  );
}

async function fetchJsonWithRetry(url, timeoutMs) {
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeoutMs) {
    try {
      return await fetchJsonOnce(url, 1_200);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "unknown error"}`);
}

async function waitForDebugEndpoint(options) {
  const {
    userDataDir,
    timeoutMs,
    getBrowserExitInfo,
    getBrowserStderrTail,
  } = options;
  const start = Date.now();
  const devToolsPortFile = path.join(userDataDir, "DevToolsActivePort");
  let lastPort = null;
  let lastError = null;

  while (Date.now() - start < timeoutMs) {
    const exitInfo = getBrowserExitInfo();
    if (exitInfo) {
      const stderrTail = getBrowserStderrTail();
      throw new Error(buildBrowserExitBeforeDevToolsError(exitInfo, stderrTail));
    }

    try {
      const content = await fs.promises.readFile(devToolsPortFile, "utf8");
      const [portLine] = content.split(/\r?\n/);
      const port = Number.parseInt((portLine ?? "").trim(), 10);
      if (Number.isInteger(port) && port > 0) {
        lastPort = port;
        const browserVersion = await fetchJsonOnce(
          `http://127.0.0.1:${port}/json/version`,
          1_200
        );
        return { port, browserVersion };
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(buildDebugEndpointTimeoutError(devToolsPortFile, lastPort, lastError));
}

async function findPageTargetWithRetry(debugPort, timeoutMs, launchUrl) {
  const start = Date.now();
  let lastTargets = [];

  while (Date.now() - start < timeoutMs) {
    const targets = await fetchJsonWithRetry(
      `http://127.0.0.1:${debugPort}/json/list`,
      2_000
    );
    lastTargets = targets;

    const selected = pickPageTarget(targets, launchUrl);
    if (selected) {
      return selected;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Could not find page target in DevTools. Last targets: ${JSON.stringify(lastTargets)}`);
}

async function main() {
  const options = parseClientCaptureArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  const output = fs.createWriteStream(options.output, { flags: "a" });
  const browserPath = findBrowserPath(options.browserPath);
  const launchUrl = makeUrl(options.url, options.appLogs);

  let userDataDir = options.userDataDir;
  let cleanupUserDataDir = false;
  if (options.private) {
    userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soc-client-private-"));
    cleanupUserDataDir = true;
  } else {
    fs.mkdirSync(userDataDir, { recursive: true });
  }
  await fs.promises.rm(path.join(userDataDir, "DevToolsActivePort"), { force: true });

  const headerLines = [
    `# started_at=${new Date().toISOString()}`,
    `# output=${options.output}`,
    `# url=${launchUrl}`,
    `# browser_path=${browserPath}`,
    `# user_data_dir=${userDataDir}`,
    `# private=${options.private}`,
    `# headless=${options.headless}`,
    "",
  ];
  output.write(`${headerLines.join("\n")}\n`);

  const browserArgs = [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
  ];
  if (options.private) {
    browserArgs.push("--incognito");
  }
  if (options.headless) {
    browserArgs.push("--headless=new");
  }
  browserArgs.push(launchUrl);

  console.log(`Capturing client logs to ${options.output}`);
  console.log(`Launching browser: ${browserPath}`);
  console.log(`URL: ${launchUrl}`);
  console.log(options.private ? "Private mode: enabled" : "Private mode: disabled");
  console.log("Press Ctrl+C to stop.\n");

  let pageWs;
  let shuttingDown = false;
  let pendingMessages = new Map();
  let nextMessageId = 1;
  let browserExitInfo = null;
  const browserStderrTail = [];
  let captureReady = false;

  const browserProcess = spawn(browserPath, browserArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  browserProcess.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output.write(formatLine("browser.stdout", text.trimEnd()));
  });
  browserProcess.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    output.write(formatLine("browser.stderr", text.trimEnd()));
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      browserStderrTail.push(trimmed);
      if (browserStderrTail.length > 25) {
        browserStderrTail.shift();
      }
    }
  });

  function closeOutputAndExit(code) {
    output.write(`\n# ended_at=${new Date().toISOString()}\n`);
    output.end(() => {
      if (cleanupUserDataDir) {
        fs.rm(userDataDir, { recursive: true, force: true }, () => process.exit(code));
        return;
      }
      process.exit(code);
    });
  }

  function cleanupAndExit(code) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (pageWs && pageWs.readyState === WebSocket.OPEN) {
      pageWs.close();
    }
    browserProcess.kill("SIGINT");
    setTimeout(() => closeOutputAndExit(code), 100);
  }

  process.on("SIGINT", () => cleanupAndExit(0));
  process.on("SIGTERM", () => cleanupAndExit(0));

  browserProcess.on("exit", (code, signal) => {
    browserExitInfo = { code, signal };
    output.write(
      formatLine(
        "browser.exit",
        `code=${code ?? "null"} signal=${signal ?? "null"}`
      )
    );
    if (!shuttingDown && captureReady) {
      closeOutputAndExit(typeof code === "number" ? code : 0);
    }
  });
  try {
    const { port: debugPort, browserVersion } = await waitForDebugEndpoint(
      {
        userDataDir,
        timeoutMs: options.timeoutMs,
        getBrowserExitInfo: () => browserExitInfo,
        getBrowserStderrTail: () => browserStderrTail,
      }
    );
    output.write(formatLine("browser.version", JSON.stringify(browserVersion)));
    const pageTarget = await findPageTargetWithRetry(debugPort, options.timeoutMs, launchUrl);
    output.write(formatLine("target.page", JSON.stringify({ id: pageTarget.id, url: pageTarget.url })));
    pageWs = new WebSocket(pageTarget.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      pageWs.addEventListener("open", resolve, { once: true });
      pageWs.addEventListener("error", reject, { once: true });
    });

    pageWs.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        output.write(formatLine("cdp.parse_error", String(event.data)));
        return;
      }

      if (typeof payload.id === "number" && pendingMessages.has(payload.id)) {
        const { resolve, reject } = pendingMessages.get(payload.id);
        pendingMessages.delete(payload.id);
        if (payload.error) {
          reject(new Error(payload.error.message ?? "Unknown CDP error"));
        } else {
          resolve(payload.result);
        }
        return;
      }

      if (payload.method === "Runtime.consoleAPICalled") {
        const type = payload.params?.type ?? "log";
        const args = Array.isArray(payload.params?.args) ? payload.params.args : [];
        const text = args.map(formatRemoteObject).join(" ");
        output.write(formatLine(`console.${type}`, text));
        return;
      }

      if (payload.method === "Runtime.exceptionThrown") {
        const details = payload.params?.exceptionDetails;
        output.write(formatLine("runtime.exception", JSON.stringify(details)));
        return;
      }

      if (payload.method === "Log.entryAdded") {
        const entry = payload.params?.entry ?? {};
        const text = `${entry.level ?? "info"} ${entry.source ?? "unknown"} ${entry.text ?? ""}`.trim();
        output.write(formatLine("browser.log", text));
      }
    });

    function sendCdp(method, params = {}) {
      const id = nextMessageId;
      nextMessageId += 1;
      return new Promise((resolve, reject) => {
        pendingMessages.set(id, { resolve, reject });
        pageWs.send(JSON.stringify({ id, method, params }));
      });
    }

    await sendCdp("Runtime.enable");
    await sendCdp("Log.enable");
    await sendCdp("Page.enable");

    captureReady = true;
    output.write(formatLine("ready", "Console capture started"));
  } catch (error) {
    output.write(formatLine("capture.error", error.message));
    console.error(error.message);
    cleanupAndExit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
