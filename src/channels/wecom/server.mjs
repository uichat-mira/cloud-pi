/**
 * Process entry for the WeCom channel.
 *
 * Logs are JSON lines on stdout so a supervisor can parse them; they never
 * contain credentials, raw WeCom ids or message text. Exit codes match the CLI
 * convention: 0 clean stop, 1 runtime failure, 2 configuration error.
 */
import { fileURLToPath } from "node:url";
import { WecomConfigError } from "./config.mjs";
import { createWecomService } from "./service.mjs";

export function createJsonLogger(stream = process.stdout) {
  return (entry) => {
    const line = { ts: new Date().toISOString(), ...entry };
    stream.write(`${JSON.stringify(line, redactUndefined)}\n`);
  };
}

function redactUndefined(key, value) {
  return value === undefined ? undefined : value;
}

const CONFIG_CODES = new Set(["wecom_config_error", "config_error"]);

export function exitCodeFor(error) {
  const code = error?.code;
  if (code && CONFIG_CODES.has(code)) return 2;
  if (error instanceof WecomConfigError) return 2;
  // Anything else — instance lock, transport, auth, runtime — is a runtime
  // failure for a supervisor to restart, not a configuration error.
  return 1;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.argv]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {NodeJS.WriteStream} [options.stdout]
 * @param {object} [options.serviceOptions] injection for tests
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  serviceOptions = {},
} = {}) {
  const log = createJsonLogger(stdout);
  const checkOnly = argv.includes("--check");

  let service;
  try {
    service = createWecomService({ env, log, ...serviceOptions });
  } catch (error) {
    log({
      level: "error",
      event: "wecom_startup_failed",
      code: String(error?.code ?? error?.name ?? "error"),
      message: String(error?.message ?? error),
      fields: Array.isArray(error?.fields) ? error.fields : undefined,
    });
    return exitCodeFor(error);
  }

  if (checkOnly) {
    log({ level: "info", event: "wecom_config_ok", ...service.describe() });
    await service.runner.dispose();
    return 0;
  }

  try {
    await service.start();
  } catch (error) {
    log({
      level: "error",
      event: "wecom_start_failed",
      code: String(error?.code ?? error?.name ?? "error"),
      message: String(error?.message ?? error),
    });
    await service.stop().catch(() => {});
    return exitCodeFor(error);
  }

  // The SDK socket normally keeps the loop alive; this timer makes that explicit
  // so a channel process never exits silently while its timers are unref'd.
  const keepAlive = setInterval(() => {}, 60_000);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log({ level: "info", event: "wecom_shutdown_requested", signal });
    clearInterval(keepAlive);
    const result = await service.stop().catch((error) => {
      log({ level: "error", event: "wecom_shutdown_failed", message: String(error?.message ?? error) });
      return undefined;
    });
    log({ level: "info", event: "wecom_shutdown_complete", drained: result?.drained });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    log({
      level: "error",
      event: "wecom_unhandled_rejection",
      message: String(reason?.message ?? reason),
    });
  });

  // Signals are installed; return so callers (tests) can drive stop() directly.
  return { service, stop: () => shutdown("programmatic") };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main()
    .then((result) => {
      if (typeof result === "number") process.exit(result);
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ level: "error", event: "wecom_entry_failed" })}\n`);
      process.exit(exitCodeFor(error));
    });
}
