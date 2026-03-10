#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { createNdjsonLogger } from "./lib/logger.mjs";
import {
  buildBotLaunchConfigs,
  parseRunSwarmArgs,
  runSwarmHelpText,
  writeRunConfig,
} from "./lib/runSwarmConfig.mjs";

async function main() {
  const config = parseRunSwarmArgs(process.argv.slice(2));
  if (config.help) {
    console.log(runSwarmHelpText());
    return;
  }

  fs.mkdirSync(path.resolve(config.runDir, "bots"), { recursive: true });
  const logger = createNdjsonLogger(config.coordinatorLog);
  const botConfigs = buildBotLaunchConfigs(config);
  writeRunConfig(config, botConfigs);

  logger.log("run_start", {
    runId: config.runId,
    wsUrl: config.wsUrl,
    botCount: config.botCount,
    durationMs: config.durationMs,
    runDir: config.runDir,
  });

  const children = new Map();
  const childResults = [];
  let stopping = false;
  let forceKillTimer = null;
  let secondSignal = false;
  let stopReason = null;

  function launchBot(bot) {
    const child = spawn(process.execPath, bot.args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    children.set(bot.botId, {
      child,
      bot,
      exited: false,
      forced: false,
    });

    child.stdout.on("data", (chunk) => {
      logger.log("child_stdout", {
        runId: config.runId,
        botId: bot.botId,
        message: chunk.toString().trimEnd(),
      });
    });
    child.stderr.on("data", (chunk) => {
      logger.log("child_stderr", {
        runId: config.runId,
        botId: bot.botId,
        message: chunk.toString().trimEnd(),
      });
    });
    child.on("exit", (code, signal) => {
      const entry = children.get(bot.botId);
      if (entry) {
        entry.exited = true;
      }
      childResults.push({
        botId: bot.botId,
        code,
        signal,
        forced: entry?.forced === true,
        summaryOutput: bot.summaryOutput,
      });
      logger.log("child_exit", {
        runId: config.runId,
        botId: bot.botId,
        code,
        signal,
        forced: entry?.forced === true,
      });
      maybeFinish();
    });

    logger.log("child_spawn", {
      runId: config.runId,
      botId: bot.botId,
      scenarioId: bot.scenarioId,
      readonly: bot.readonly,
      output: bot.output,
      summaryOutput: bot.summaryOutput,
    });
  }

  function requestStop(reason, immediate = false) {
    if (secondSignal && immediate) {
      for (const entry of children.values()) {
        if (entry.exited) {
          continue;
        }
        entry.forced = true;
        try {
          entry.child.kill("SIGKILL");
        } catch {
          // Ignore kill failures on already-exited children.
        }
      }
      return;
    }

    if (stopping) {
      return;
    }

    stopping = true;
    stopReason = reason;
    logger.log("run_stopping", {
      runId: config.runId,
      reason,
      childCount: children.size,
    });

    for (const entry of children.values()) {
      if (entry.exited) {
        continue;
      }
      try {
        entry.child.kill("SIGTERM");
      } catch {
        // Ignore signal failures.
      }
    }

    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      for (const entry of children.values()) {
        if (entry.exited) {
          continue;
        }
        entry.forced = true;
        logger.log("child_force_kill", {
          runId: config.runId,
          botId: entry.bot.botId,
        });
        try {
          entry.child.kill("SIGKILL");
        } catch {
          // Ignore kill failures on already-exited children.
        }
      }
    }, config.killAfterMs);
  }

  function maybeFinish() {
    if (childResults.length < botConfigs.length) {
      return;
    }
    if (forceKillTimer !== null) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    const summary = buildSummary({
      config,
      childResults,
      stopReason,
    });
    fs.writeFileSync(config.summaryOutput, `${JSON.stringify(summary, null, 2)}\n`);
    logger.log("run_summary", summary);
    logger.close().finally(() => {
      process.exitCode = summary.ok ? 0 : 1;
    });
  }

  process.on("SIGINT", () => {
    if (secondSignal) {
      requestStop("signal_SIGINT_second", true);
      return;
    }
    secondSignal = true;
    requestStop("signal_SIGINT");
  });

  process.on("SIGTERM", () => {
    if (secondSignal) {
      requestStop("signal_SIGTERM_second", true);
      return;
    }
    secondSignal = true;
    requestStop("signal_SIGTERM");
  });

  for (const bot of botConfigs) {
    launchBot(bot);
  }
}

function buildSummary({ config, childResults, stopReason }) {
  const botSummaries = [];
  for (const result of childResults) {
    let summary = null;
    try {
      summary = JSON.parse(fs.readFileSync(result.summaryOutput, "utf8"));
    } catch {
      summary = null;
    }
    botSummaries.push({
      botId: result.botId,
      code: result.code,
      signal: result.signal,
      forced: result.forced,
      summary,
    });
  }

  const forcedKillCount = botSummaries.filter((item) => item.forced).length;
  const failedBots = botSummaries.filter(
    (item) => item.code !== 0 || item.signal !== null
  ).length;

  return {
    ok: failedBots === 0,
    runId: config.runId,
    stopReason,
    botCount: config.botCount,
    forcedKillCount,
    failedBots,
    bots: botSummaries,
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

