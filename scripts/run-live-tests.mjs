#!/usr/bin/env node
/**
 * Cross-platform launcher for the live suite.
 *
 * Loads `.env` (or `CLOUD_PI_ENV_FILE`) into the child process, sets
 * `CLOUD_PI_LIVE=1`, and runs only the live test file so the regular suite stays
 * free and offline.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const envFile = process.env.CLOUD_PI_ENV_FILE ?? ".env";
if (!existsSync(envFile)) {
  process.stderr.write(
    `test:live: environment file not found: ${envFile}\n` +
      "Set CLOUD_PI_ENV_FILE or create .env from .env.example.\n",
  );
  process.exit(2);
}

const args = ["--env-file=" + envFile, "--test", "tests/agt-027-live.test.mjs"];
const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, CLOUD_PI_LIVE: "1" },
});
process.exit(result.status ?? 1);
