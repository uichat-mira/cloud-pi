#!/usr/bin/env node
/**
 * Long-running Feishu channel process.
 *
 *   npm run channel:feishu
 *
 * Loads model + Feishu configuration from the environment (`.env` is loaded by
 * the npm script, but Feishu credentials should be injected per process). Logs
 * one JSON object per line, never message text, secrets or full Feishu ids.
 * Exits 0 on a clean signal shutdown, 1 if active work failed to drain, 2 for
 * invalid configuration.
 */
import { ConfigError } from "../../config.mjs";
import { FeishuConfigError } from "./config.mjs";
import { startFeishuService } from "./service.mjs";

function write(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

const log = (entry) => write({ ts: new Date().toISOString(), ...entry });

let service;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ level: "info", event: "feishu_channel_stopping", signal });
  const drained = await service.stop({ timeoutMs: 10_000 });
  log({ level: "info", event: "feishu_channel_stopped", drained });
  process.exit(drained ? 0 : 1);
}

try {
  service = await startFeishuService({ log });
  log({ level: "info", event: "feishu_channel_started", ...service.summary });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
} catch (error) {
  const isConfig = error instanceof FeishuConfigError || error instanceof ConfigError;
  log({
    level: "error",
    event: "feishu_channel_start_failed",
    code: String(error?.code ?? error?.name ?? "error"),
    fields: Array.isArray(error?.fields) ? error.fields : undefined,
    message: isConfig ? error.message : String(error?.message ?? error),
  });
  process.exit(isConfig ? 2 : 1);
}
