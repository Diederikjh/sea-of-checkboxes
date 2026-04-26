#!/usr/bin/env node

import {
  backupR2ToJson,
  loadR2BackupEnvFromDotenv,
  parseR2JsonBackupArgs,
  printR2JsonBackupHelp,
  resolveR2RuntimeCredentials,
  restoreR2FromJson,
  validateR2JsonBackupOptions,
} from "./r2-json-backup.lib.mjs";

async function main() {
  const dotenvEnv = loadR2BackupEnvFromDotenv();
  const options = parseR2JsonBackupArgs(process.argv.slice(2), {
    env: {
      ...dotenvEnv,
      ...process.env,
    },
  });

  if (options.help) {
    process.stdout.write(printR2JsonBackupHelp());
    return;
  }

  validateR2JsonBackupOptions(options);
  const runtimeOptions = await resolveR2RuntimeCredentials(options);

  if (runtimeOptions.command === "backup") {
    const result = await backupR2ToJson(runtimeOptions);
    process.stdout.write(
      `Backed up ${result.count} objects (${result.totalBytes} bytes) from ${runtimeOptions.bucket} to ${result.output}\n`
    );
    return;
  }

  const result = await restoreR2FromJson(runtimeOptions);
  process.stdout.write(
    `${result.dryRun ? "Checked" : "Restored"} ${result.count} objects (${result.totalBytes} bytes) into ${runtimeOptions.bucket}`
      + `${result.skipped ? `; skipped ${result.skipped} by prefix` : ""}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
