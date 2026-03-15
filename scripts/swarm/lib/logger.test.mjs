import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNdjsonLogger } from "./logger.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ndjson logger", () => {
  it("drops late writes after close and closes idempotently", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-logger-"));
    tempDirs.push(tempDir);
    const outputPath = path.join(tempDir, "bot.ndjson");
    const logger = createNdjsonLogger(outputPath);

    expect(logger.log("bot_start", { botId: "bot-001" })).toBe(true);

    await logger.close();

    expect(logger.log("late_event", { botId: "bot-001" })).toBe(false);
    await expect(logger.close()).resolves.toBeUndefined();

    const lines = fs.readFileSync(outputPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      event: "bot_start",
      botId: "bot-001",
    });
  });
});
