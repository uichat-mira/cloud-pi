#!/usr/bin/env node
/**
 * One-shot live POC driver for the Feishu channel.
 *
 *   FEISHU_APP_ID=... FEISHU_APP_SECRET=... npm run feishu:live
 *
 * Starts the real WebSocket transport and the real Cloud Pi runtime, waits for
 * one inbound Feishu message that satisfies `--expect`, and writes redacted
 * evidence to `poc/evidence/agt-029-live.jsonl`.
 *
 * The script cannot create an inbound user message by itself: a human must send
 * it from Feishu while this process is waiting. It never prints credentials or
 * message text.
 *
 * Options:
 *   --expect reply|ignored:<reason>   success condition (default: reply)
 *   --chat-type p2p|group             only judge outcomes for this chat type
 *   --timeout-ms N                    overall wait (default 180000)
 *   --evidence PATH                   JSONL evidence file
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEISHU_CONFIG_KEYS, maskId } from "../src/channels/feishu/config.mjs";
import { startFeishuService } from "../src/channels/feishu/service.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv) {
  const options = {
    expect: "reply",
    chatType: "p2p",
    timeoutMs: 180_000,
    evidence: join(ROOT, "poc", "evidence", "agt-029-live.jsonl"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === "--expect") options.expect = next();
    else if (arg === "--chat-type") options.chatType = next();
    else if (arg === "--timeout-ms") options.timeoutMs = Number(next());
    else if (arg === "--evidence") options.evidence = next();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["p2p", "group"].includes(options.chatType)) throw new Error("--chat-type must be p2p or group");
  if (!/^(reply|ignored:[a-z_]+)$/.test(options.expect)) throw new Error("--expect must be reply or ignored:<reason>");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) throw new Error("--timeout-ms must be >= 1000");
  return options;
}

function packageVersion(relativePath) {
  try {
    return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function gitHead() {
  try {
    return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stderr.write("usage: npm run feishu:live -- [--expect reply|ignored:<reason>] [--chat-type p2p|group] [--timeout-ms N] [--evidence PATH]\n");
  process.exit(0);
}

mkdirSync(dirname(options.evidence), { recursive: true });

function writeEvidence(entry) {
  appendFileSync(options.evidence, `${JSON.stringify(entry)}\n`);
}

function maskedOutcome(outcome) {
  return {
    action: outcome.action,
    reason: outcome.reason,
    chatType: outcome.chatType,
    messageId: outcome.messageId ? maskId(outcome.messageId) : undefined,
    eventId: outcome.eventId ? maskId(outcome.eventId) : undefined,
    chatId: outcome.chatId ? maskId(outcome.chatId) : undefined,
    replyMessageId: outcome.replyMessageId ? maskId(outcome.replyMessageId) : undefined,
    runId: outcome.runId,
    status: outcome.status,
    modelId: outcome.modelId,
    durationMs: outcome.durationMs,
    usage: outcome.usage,
    errorCode: outcome.errorCode,
    replyDelivered: outcome.replyDelivered,
  };
}

writeEvidence({
  kind: "session_start",
  at: new Date().toISOString(),
  commit: gitHead(),
  node: process.version,
  piCodingAgent: packageVersion("node_modules/@earendil-works/pi-coding-agent/package.json"),
  feishuSdk: packageVersion("node_modules/@larksuiteoapi/node-sdk/package.json"),
  bridgePlugin: "ax-feishu-bridge@0.4.9 (not reused: no transport export; ./pi is its own runtime)",
  configKeys: Object.values(FEISHU_CONFIG_KEYS),
  expect: options.expect,
  chatType: options.chatType,
  timeoutMs: options.timeoutMs,
});

let service;
let finished = false;
let timer;

function matches(outcome) {
  if (outcome?.chatType !== options.chatType) return false;
  if (options.expect === "reply") return outcome.action === "replied";
  return outcome.action === "ignored" && outcome.reason === options.expect.slice("ignored:".length);
}

async function finish(ok, detail) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  writeEvidence({ kind: "result", at: new Date().toISOString(), ok, ...detail });
  let drained = false;
  try {
    drained = await service.stop({ timeoutMs: 10_000 });
  } catch (error) {
    writeEvidence({ kind: "shutdown_error", code: String(error?.code ?? error?.name ?? "error") });
  }
  process.stderr.write(
    `${ok ? "PASS" : "FAIL"} agt-029 live: ${JSON.stringify({ expect: options.expect, chatType: options.chatType, ...detail, drained })}\n`,
  );
  process.exit(ok ? 0 : 1);
}

timer = setTimeout(() => {
  void finish(false, { reason: "timeout", message: "no matching Feishu event arrived before the deadline" });
}, options.timeoutMs);
timer.unref?.();

try {
  service = await startFeishuService({
    log: (entry) => {
      if (entry.level === "error") process.stderr.write(`${JSON.stringify(entry)}\n`);
    },
    onOutcome: (outcome) => {
      writeEvidence({ kind: "outcome", at: new Date().toISOString(), ...maskedOutcome(outcome) });
      if (finished) return;
      if (matches(outcome)) {
        void finish(true, { outcome: maskedOutcome(outcome) });
        return;
      }
      if (outcome.action === "failed" && outcome.chatType === options.chatType) {
        void finish(false, { outcome: maskedOutcome(outcome), message: "runtime or reply failed" });
      }
    },
  });
} catch (error) {
  const isConfig = error?.code === "feishu_config_error" || error?.name === "FeishuConfigError" || error?.name === "ConfigError";
  writeEvidence({
    kind: "start_failed",
    at: new Date().toISOString(),
    code: String(error?.code ?? error?.name ?? "error"),
    fields: Array.isArray(error?.fields) ? error.fields : undefined,
    message: isConfig ? error.message : undefined,
  });
  process.stderr.write(`feishu live start failed: ${error?.message ?? error}\n`);
  process.exit(isConfig ? 2 : 1);
}

writeEvidence({ kind: "connected", at: new Date().toISOString(), ...service.summary });
process.stderr.write(
  [
    "Feishu channel connected.",
    options.expect === "reply"
      ? `Send one private message to the bot (chat type ${options.chatType}); waiting for the real reply.`
      : `Trigger the expected event (${options.expect}) in a ${options.chatType}; waiting for evidence.`,
    `Timeout: ${Math.round(options.timeoutMs / 1000)}s. Evidence: ${options.evidence}`,
    "",
  ].join("\n"),
);
