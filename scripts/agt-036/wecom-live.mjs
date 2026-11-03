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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
/** Redacted JSONL evidence: only the projection below ever lands on disk. */
export const DEFAULT_EVIDENCE_FILE = join(REPO_ROOT, ".work", "wecom-channel", "live-evidence.jsonl");
export const EXPECT_MODES = Object.freeze(["reply", "any"]);

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
    expect: "reply",
    evidenceFile: DEFAULT_EVIDENCE_FILE,
    help: false,
    waitInbound: false,
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
    else if (arg === "--expect") options.expect = next();
    else if (arg === "--evidence") options.evidenceFile = next();
    else if (arg === "--wait-inbound") options.waitInbound = true;
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
    "  --expect reply|any   reply (default) requires a delivered answer; any accepts",
    "                       any processed inbound outcome",
    "  --wait-inbound       hold the connection and report the first inbound outcome",
    "                       (alias for --expect any; keep the window short)",
    "  --evidence <path>    JSONL evidence file (default <repo>/.work/wecom-channel/live-evidence.jsonl)",
    "",
    "The command subscribes the bot's long connection, waits for one real inbound",
    "message, answers it with the real Agent runtime and reports a redacted result.",
  ].join("\n");
}

function evidenceOf(outcome, model) {
  return {
    ok: outcome.action === "replied" && outcome.replyDelivered === true,
    chatType: outcome.chatType,
    status: outcome.status,
    runId: typeof outcome.runId === "string" ? outcome.runId : null,
    // Model identity is configuration, never a credential.
    model: { provider: model?.provider ?? null, model: model?.model ?? null },
    usage: outcome.usage ? { input: outcome.usage.input, output: outcome.usage.output, total: outcome.usage.total } : null,
    segments: outcome.segments ?? 1,
    segmentsDelivered: outcome.segmentsDelivered ?? undefined,
    durationMs: outcome.durationMs,
    replyDelivered: outcome.replyDelivered === true,
    platformErrcode: typeof outcome.platformErrcode === "number" ? outcome.platformErrcode : null,
    // Two-phase projection: which phase this line is and how the answer left.
    phase: outcome.phase ?? undefined,
    delivery: outcome.delivery ?? undefined,
    requestId: outcome.requestId ?? undefined,
    ackMs: typeof outcome.ackMs === "number" ? outcome.ackMs : null,
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
  // `--wait-inbound` is the maintainer-controlled mode: hold the one allowed long
  // connection and report whatever the first real inbound message produces,
  // without requiring a delivered answer.
  if (options.waitInbound && !argv.includes("--expect")) options.expect = "any";
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
  if (!EXPECT_MODES.includes(options.expect)) {
    write(stderr, { ok: false, phase: "usage", reason: "invalid_expect", allowed: EXPECT_MODES });
    return 2;
  }

  const appendEvidence = (entry) => {
    try {
      mkdirSync(dirname(options.evidenceFile), { recursive: true });
      appendFileSync(options.evidenceFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch {
      // Evidence persistence must never break the live run itself.
    }
  };

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
  const TERMINAL_ACTIONS = new Set(["replied", "failed", "cancelled", "stopped"]);

  let service;
  try {
    service = createWecomService({
      env: merged,
      log: (entry) => write(stdout, { ts: new Date().toISOString(), ...entry }),
      onOutcome: (outcome) => {
        outcomes.push(outcome);
        if (TERMINAL_ACTIONS.has(outcome.action)) settle(outcome);
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

  const connected = {
    phase: "connected",
    authenticated: service.describe().transport?.state === "authenticated",
    expect: options.expect,
  };
  write(stderr, {
    ok: true,
    ...connected,
    waitingForInboundMs: options.timeoutMs,
    instruction: "Send one message to the bot in WeCom now.",
  });
  appendEvidence(connected);

  let timer;
  const timeout = new Promise((resolvePromise) => {
    timer = setTimeout(() => resolvePromise("timeout"), options.timeoutMs);
  });
  const result = await Promise.race([answered, timeout]);
  clearTimeout(timer);

  if (result === "timeout") {
    await service.stop().catch(() => {});
    const payload = { ok: false, phase: "wait_inbound", reason: "no_inbound_message", handled: outcomes.length };
    write(stderr, payload);
    appendEvidence(payload);
    return 1;
  }

  const payload = {
    phase: "result",
    expect: options.expect,
    action: result.action,
    ...evidenceOf(result, {
      provider: merged.CLOUD_PI_MODEL_PROVIDER_ID,
      model: merged.CLOUD_PI_MODEL_ID,
    }),
  };
  // `--expect any` verifies that a real inbound message reached the channel even
  // when the answer itself could not be delivered.
  const ok = options.expect === "any" ? true : payload.ok;
  const final = { ...payload, ok };
  await service.stop().catch(() => {});
  write(ok ? stdout : stderr, { ts: new Date().toISOString(), event: "wecom_live_result", ...final });
  appendEvidence(final);
  return ok ? 0 : 1;
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
