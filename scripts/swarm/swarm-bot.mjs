#!/usr/bin/env node

import { parseSwarmBotArgs, swarmBotHelpText } from "./lib/config.mjs";
import { createNdjsonLogger } from "./lib/logger.mjs";
import { SwarmBotSession } from "./lib/swarmBotSession.mjs";

async function main() {
  const config = parseSwarmBotArgs(process.argv.slice(2));
  if (config.help) {
    console.log(swarmBotHelpText());
    return;
  }

  const logger = createNdjsonLogger(config.output);
  const session = new SwarmBotSession(config, {
    logger,
  });

  let secondSignal = false;
  const handleSignal = (signal) => {
    if (secondSignal) {
      process.exitCode = 130;
      process.exit();
      return;
    }
    secondSignal = true;
    logger.log("process_signal", {
      runId: config.runId,
      botId: config.botId,
      signal,
      escalation: "stop_immediately",
    });
    void session.stop(`signal_${signal}`);
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  try {
    await session.start();
  } finally {
    await logger.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
