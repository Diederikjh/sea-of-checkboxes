#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  applyWorkerLogPostFilters,
  buildWorkerLogQueryRequest,
  formatWorkerLogQueryResult,
  parseDotenvText,
  parseWorkerLogQueryArgs,
  printWorkerLogQueryHelp,
  replaceWorkerLogEvents,
  resolveCloudflareAuth,
} from "./query-worker-logs.lib.mjs";

function loadLogQueryEnvFromDotenv({
  cwd = process.cwd(),
  readFileSync = fs.readFileSync,
  existsSync = fs.existsSync,
} = {}) {
  const envPath = path.join(cwd, ".env.local");
  if (!existsSync(envPath)) {
    return {};
  }
  return parseDotenvText(readFileSync(envPath, "utf8"));
}

async function main() {
  const dotenvEnv = loadLogQueryEnvFromDotenv();
  const options = parseWorkerLogQueryArgs(process.argv.slice(2), {
    env: {
      ...dotenvEnv,
      ...process.env,
    },
  });

  if (options.help) {
    process.stdout.write(printWorkerLogQueryHelp());
    return;
  }

  if (options.dryRun) {
    const dryRunPayload = buildWorkerLogQueryRequest({
      ...options,
      accountId: options.accountId || "<account-id>",
      auth: { type: "api_token", token: "<dry-run>" },
    }).body;
    process.stdout.write(`${JSON.stringify(dryRunPayload, null, 2)}\n`);
    return;
  }

  const resolvedAuth = resolveCloudflareAuth(options);
  options.accountId = resolvedAuth.accountId;
  options.auth = resolvedAuth.auth;

  if (!options.accountId) {
    throw new Error(
      "Missing Cloudflare account ID. Set CLOUDFLARE_LOG_QUERY_ACCOUNT_ID, CLOUDFLARE_ACCOUNT_ID, pass --account-id, or use a Wrangler login with one account."
    );
  }

  const request = buildWorkerLogQueryRequest(options);
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  const payload = await response.json();

  if (!response.ok || payload?.success === false) {
    const errors = Array.isArray(payload?.errors) ? JSON.stringify(payload.errors) : "Unknown error";
    throw new Error(`Cloudflare query failed (${response.status}): ${errors}`);
  }

  const filteredPayload = replaceWorkerLogEvents(
    payload,
    applyWorkerLogPostFilters(
      payload?.result?.events?.events ?? payload?.result?.events ?? payload?.result ?? [],
      options
    ).slice(0, options.limit)
  );
  const output = formatWorkerLogQueryResult(filteredPayload, options);
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, output, "utf8");
    process.stdout.write(`Wrote ${options.output}\n`);
    return;
  }
  process.stdout.write(output);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
