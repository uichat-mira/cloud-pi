#!/usr/bin/env node
/**
 * AGT-036 live acceptance: subscribe → one inbound message → model reply → read back.
 *
 * This is the repeatable command a maintainer can run against the real WeCom
 * bot. It is the only place that reads a credentials file; the values go
 * straight into the process environment of the channel, never into a file, a
 * log line, an exception message or a test fixture.
 *
 * Usage:
 *   node scripts/agt-036/wecom-live.mjs [--secrets <path>] [--env-file <path>]
 *                                       [--timeout-ms 180000]
 *
 * Defaults: secrets at ~/.mira-secrets/wecom.env, model env at <repo>/.env.
 * Exit codes: 0 verified, 1 live failure/timeout, 2 configuration or usage error.
 *
 * What it proves, and what it does not:
 *  - proves the bot credentials authenticate over the long connection, that an
 *    inbound message reaches the channel, that the Agent runtime answers it and
 *    that the reply is delivered back to the same conversation;
 *  - does not prove scheduler delivery (that needs the delivery work item) and
 *    does not persist the chat run (chat-run persistence is AGT-037).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashId } from "../../src/channels/wecom/config.mjs";
import { createWecomService } from "../../src/channels/wecom/service.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export const DEFAULT_SECRETS_FILE = join(homedir(), ".mira-secrets", "wecom.env");
export const DEFAULT_MODEL_ENV_FILE = join(REPO_ROOT, ".env");
export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Parse a `KEY=VALUE` file. Comments and blanks are skipped, `export ` prefixes
 * and one layer of quotes are tolerated. Values are never logged by this module.
 */
export function parseEnvText(text) {
  const env = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** Later files win; a missing file contributes nothing. */
export function loadEnvFiles(paths) {
  const merged = {};
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    Object.assign(merged, parseEnvText(readFileSync(path, "utf8")));
  }
  return merged;
}

function parseArgs(argv) {
  const options = {
    secretsFile: DEFAULT_SECRETS_FILE,
    modelEnvFile: DEFAULT_MODEL_ENV_FILE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      return argv[index];
    };
    if (arg === "--secrets") options.secretsFile = next();
    else if (arg === "--env-file") options.modelEnvFile = next();
    else if (arg === "--timeout-ms") options.timeoutMs = Number(next());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else options.unknown = arg;
  }
  return options;
}

export function usage() {
  return [
    "Usage: node scripts/agt-036/wecom-live.mjs [options]",
    "",
    "  --secrets <path>     credentials file (default ~/.mira-secrets/wecom.env)",
    "  --env-file <path>    model configuration file (default <repo>/.env)",
    "  --timeout-ms <n>     how long to wait for an inbound message (default 180000)",
    "",
    "The command subscribes the bot's long connection, waits for one real inbound",
    "message, answers it with the real Agent runtime and reports a redacted result.",
  ].join("\n");
}

function evidenceOf(outcome) {
  return {
    ok: outcome.action === "replied" && outcome.replyDelivered === true,
    chatType: outcome.chatType,
    status: outcome.status,
    runId: typeof outcome.runId === "string" ? outcome.runId : null,
    segments: outcome.segments ?? 1,
    segmentsDelivered: outcome.segmentsDelivered ?? undefined,
    durationMs: outcome.durationMs,
    replyDelivered: outcome.replyDelivered === true,
    inboundMessage: outcome.messageId ? hashId(outcome.messageId) : undefined,
    inboundChat: outcome.chatId ? hashId(outcome.chatId) : undefined,
  };
}

/**
 * @param {object} [options]
 * @param {string[]} [options.argv]
 * @param {Record<string,string|undefined>} [options.env] ambient environment (wins over files)
 * @param {NodeJS.WriteStream} [options.stdout]
 * @param {NodeJS.WriteStream} [options.stderr]
 * @param {object} [options.serviceOptions] injection for tests
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  serviceOptions = {},
} = {}) {
  const options = parseArgs(argv);
  const write = (stream, payload) => stream.write(`${JSON.stringify(payload)}\n`);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.unknown) {
    write(stderr, { ok: false, phase: "usage", reason: "unknown_argument", argument: options.unknown });
    return 2;
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) {
    write(stderr, { ok: false, phase: "usage", reason: "invalid_timeout" });
    return 2;
  }

  const fromFiles = loadEnvFiles([options.modelEnvFile, options.secretsFile]);
  const merged = { ...fromFiles, ...env };
  if (!merged.WECOM_BOT_ID || !merged.WECOM_BOT_SECRET) {
    write(stderr, {
      ok: false,
      phase: "config",
      reason: "missing_bot_credentials",
      secretsFileFound: existsSync(options.secretsFile),
      modelEnvFileFound: existsSync(options.modelEnvFile),
    });
    return 2;
  }

  const outcomes = [];
  let settle;
  const answered = new Promise((resolvePromise) => {
    settle = resolvePromise;
  });

  let service;
  try {
    service = createWecomService({
      env: merged,
      log: (entry) => write(stdout, { ts: new Date().toISOString(), ...entry }),
      onOutcome: (outcome) => {
        outcomes.push(outcome);
        if (outcome.action === "replied" || outcome.action === "failed") settle(outcome);
      },
      ...serviceOptions,
    });
  } catch (error) {
    write(stderr, { ok: false, phase: "config", code: String(error?.code ?? error?.name ?? "error") });
    return 2;
  }

  try {
    await service.start();
  } catch (error) {
    write(stderr, { ok: false, phase: "connect", code: String(error?.code ?? error?.name ?? "error") });
    await service.stop().catch(() => {});
    return 1;
  }

  write(stderr, {
    ok: true,
    phase: "connected",
    authenticated: service.describe().transport?.state === "authenticated",
    waitingForInboundMs: options.timeoutMs,
    instruction: "Send one message to the bot in WeCom now.",
  });

  let timer;
  const timeout = new Promise((resolvePromise) => {
    timer = setTimeout(() => resolvePromise("timeout"), options.timeoutMs);
  });
  const result = await Promise.race([answered, timeout]);
  clearTimeout(timer);

  if (result === "timeout") {
    await service.stop().catch(() => {});
    write(stderr, { ok: false, phase: "wait_inbound", reason: "no_inbound_message", accepted: outcomes.length });
    return 1;
  }

  const payload = evidenceOf(result);
  await service.stop().catch(() => {});
  write(payload.ok ? stdout : stderr, { ts: new Date().toISOString(), event: "wecom_live_result", ...payload });
  return payload.ok ? 0 : 1;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ ok: false, phase: "unexpected", code: String(error?.code ?? error?.name ?? "error") })}\n`,
      );
      process.exit(1);
    });
}
