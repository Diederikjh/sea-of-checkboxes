import path from "node:path";

export function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function parseBooleanFlag(flag, current, explicitValue) {
  if (explicitValue === undefined) {
    return current;
  }
  if (flag.startsWith("--no-")) {
    return false;
  }
  if (explicitValue === "") {
    return true;
  }
  const normalized = explicitValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value "${explicitValue}" for ${flag}`);
}

export function argValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function parseClientCaptureArgs(argv, {
  env = process.env,
  resolvePath = path.resolve,
  makeTimestamp = timestamp,
} = {}) {
  const options = {
    url: env.SOC_TEST_URL ?? "https://sea-of-checkboxes-web.pages.dev",
    output: resolvePath("logs", `client-${makeTimestamp()}.log`),
    browserPath: "",
    userDataDir: resolvePath(".client-profile", "chrome"),
    private: false,
    headless: false,
    timeoutMs: 15_000,
    appLogs: true,
    help: false,
  };

  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "-u" || arg === "--url") {
      options.url = argValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      options.url = arg.slice("--url=".length);
      continue;
    }
    if (arg === "-o" || arg === "--output") {
      options.output = resolvePath(argValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = resolvePath(arg.slice("--output=".length));
      continue;
    }
    if (arg === "--browser-path") {
      options.browserPath = argValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--browser-path=")) {
      options.browserPath = arg.slice("--browser-path=".length);
      continue;
    }
    if (arg === "--user-data-dir") {
      options.userDataDir = resolvePath(argValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--user-data-dir=")) {
      options.userDataDir = resolvePath(arg.slice("--user-data-dir=".length));
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(argValue(args, index, arg), 10);
      index += 1;
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number.parseInt(arg.slice("--timeout-ms=".length), 10);
      continue;
    }
    if (arg === "--private" || arg === "--no-private") {
      options.private = parseBooleanFlag(arg, options.private, "");
      continue;
    }
    if (arg.startsWith("--private=")) {
      options.private = parseBooleanFlag("--private", options.private, arg.slice("--private=".length));
      continue;
    }
    if (arg === "--headless" || arg === "--no-headless") {
      options.headless = parseBooleanFlag(arg, options.headless, "");
      continue;
    }
    if (arg.startsWith("--headless=")) {
      options.headless = parseBooleanFlag("--headless", options.headless, arg.slice("--headless=".length));
      continue;
    }
    if (arg === "--app-logs" || arg === "--no-app-logs") {
      options.appLogs = parseBooleanFlag(arg, options.appLogs, "");
      continue;
    }
    if (arg.startsWith("--app-logs=")) {
      options.appLogs = parseBooleanFlag("--app-logs", options.appLogs, arg.slice("--app-logs=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms value: ${options.timeoutMs}`);
  }

  return options;
}

export function makeUrl(rawUrl, forceAppLogs) {
  if (!forceAppLogs) {
    return rawUrl;
  }

  const parsed = new URL(rawUrl);
  if (!parsed.searchParams.has("logs")) {
    parsed.searchParams.set("logs", "protocol,ui,other");
  }
  return parsed.toString();
}

export function buildBrowserExitBeforeDevToolsError(exitInfo, stderrTail) {
  const stderrHint = stderrTail.length > 0 ? `\nRecent browser stderr:\n${stderrTail.join("\n")}` : "";
  return (
    `Browser exited before DevTools became available (code=${exitInfo.code ?? "null"}, signal=${exitInfo.signal ?? "null"}). `
      + "If another Chrome instance is locking this profile, close it or run with --private."
      + stderrHint
  );
}

export function buildDebugEndpointTimeoutError(devToolsPortFile, lastPort, lastError) {
  const suffix =
    lastPort === null
      ? `DevToolsActivePort file was never readable: ${devToolsPortFile}`
      : `Last discovered DevTools port was ${lastPort}, but it was not reachable.`;

  return `Timed out waiting for Chrome DevTools endpoint. ${suffix} ${lastError ? `Last error: ${lastError.message}` : ""}`.trim();
}

export function pickPageTarget(targets, launchUrl) {
  const preferred = targets.find(
    (target) =>
      target.type === "page"
      && typeof target.webSocketDebuggerUrl === "string"
      && target.webSocketDebuggerUrl.length > 0
      && typeof target.url === "string"
      && target.url.length > 0
      && target.url !== "about:blank"
      && launchUrl.startsWith(target.url.split("#")[0].split("?")[0])
  );
  if (preferred) {
    return preferred;
  }

  return targets.find(
    (target) =>
      target.type === "page"
      && typeof target.webSocketDebuggerUrl === "string"
      && target.webSocketDebuggerUrl.length > 0
      && typeof target.url === "string"
      && target.url !== "about:blank"
      && !target.url.startsWith("chrome://")
  ) ?? null;
}

export function formatRemoteObject(arg) {
  if (Object.hasOwn(arg, "value")) {
    return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  }
  if (Object.hasOwn(arg, "unserializableValue")) {
    return String(arg.unserializableValue);
  }
  if (typeof arg.description === "string" && arg.description.length > 0) {
    return arg.description;
  }
  return arg.type ?? "unknown";
}

export function formatLine(kind, message) {
  return `[${new Date().toISOString()}] [${kind}] ${message}\n`;
}
