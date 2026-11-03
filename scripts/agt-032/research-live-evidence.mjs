#!/usr/bin/env node
/**
 * One-shot live evidence driver for AGT-032 (Feishu `/research`).
 *
 *   node --env-file-if-exists=.env scripts/agt-032/research-live-evidence.mjs \
 *     [--chat-type p2p|group] [--timeout-ms N] [--evidence PATH] [--runs-dir DIR]
 *
 * Starts the real Feishu service (real WebSocket transport, real AGT-027 chat
 * runtime, real AGT-028 research runtime + tool layer), waits for one human-sent
 * `/research <topic>` message, and writes redacted evidence after the run and
 * reply complete. The script cannot create the inbound message itself: a human
 * must send it from Feishu while this process is waiting.
 *
 * Evidence never contains message text, secrets/tokens, or full Feishu ids. It
 * records only run id, research status, duration, source count, replyDelivered
 * and masked ids. The run directory itself is the real AGT-028 artifact root.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maskId } from "../../src/channels/feishu/config.mjs";
import { startFeishuService } from "../../src/channels/feishu/service.mjs";
import { readResearchRun } from "../../src/research/index.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const options = {
    chatType: "p2p",
    timeoutMs: 600_000,
    evidence: join(ROOT, "poc", "evidence", "agt-032-live.jsonl"),
    runsDir: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === "--chat-type") options.chatType = next();
    else if (arg === "--timeout-ms") options.timeoutMs = Number(next());
    else if (arg === "--evidence") options.evidence = next();
    else if (arg === "--runs-dir") options.runsDir = next();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["p2p", "group"].includes(options.chatType)) throw new Error("--chat-type must be p2p or group");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10_000) {
    throw new Error("--timeout-ms must be >= 10000");
  }
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
    let gitDir = join(ROOT, ".git");
    if (statSync(gitDir).isFile()) {
      const pointer = readFileSync(gitDir, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!match) return null;
      gitDir = resolve(ROOT, match[1]);
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5);
    try {
      return readFileSync(join(gitDir, ref), "utf8").trim();
    } catch {
      const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
      const line = packed.split("\n").find((entry) => entry.endsWith(` ${ref}`));
      return line ? line.split(" ")[0] : null;
    }
  } catch {
    return null;
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stderr.write(
    "usage: node scripts/agt-032/research-live-evidence.mjs [--chat-type p2p|group] [--timeout-ms N] [--evidence PATH] [--runs-dir DIR]\n",
  );
  process.exit(0);
}

mkdirSync(dirname(options.evidence), { recursive: true });

function writeEvidence(entry) {
  appendFileSync(options.evidence, `${JSON.stringify(entry)}\n`);
}

/** Only whitelisted, non-content fields may enter evidence. */
function maskedOutcome(outcome) {
  return {
    action: outcome.action,
    kind: outcome.kind,
    reason: outcome.reason,
    chatType: outcome.chatType,
    status: outcome.status,
    researchStatus: outcome.researchStatus,
    runId: outcome.runId,
    durationMs: outcome.durationMs,
    sources: outcome.sources,
    errorCode: outcome.errorCode,
    replyDelivered: outcome.replyDelivered,
    messageId: outcome.messageId ? maskId(outcome.messageId) : undefined,
    eventId: outcome.eventId ? maskId(outcome.eventId) : undefined,
    chatId: outcome.chatId ? maskId(outcome.chatId) : undefined,
    replyMessageId: outcome.replyMessageId ? maskId(outcome.replyMessageId) : undefined,
  };
}

writeEvidence({
  kind: "session_start",
  at: new Date().toISOString(),
  commit: gitHead(),
  node: process.version,
  piCodingAgent: packageVersion("node_modules/@earendil-works/pi-coding-agent/package.json"),
  feishuSdk: packageVersion("node_modules/@larksuiteoapi/node-sdk/package.json"),
  chatType: options.chatType,
  timeoutMs: options.timeoutMs,
  runsDir: options.runsDir ?? "default (RESEARCH_RUNS_DIR or .work/research-runs)",
  redaction: "no message text, no secrets/tokens, full Feishu ids masked",
});

let service;
let finished = false;
let timer;

async function finish(ok, detail) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  writeEvidence({ kind: "result", at: new Date().toISOString(), ok, ...detail });
  let drained = false;
  try {
    drained = service ? await service.stop({ timeoutMs: 15_000 }) : false;
  } catch (error) {
    writeEvidence({ kind: "shutdown_error", code: String(error?.code ?? error?.name ?? "error") });
  }
  process.stderr.write(
    `${ok ? "PASS" : "FAIL"} agt-032 live: ${JSON.stringify({ ok, ...detail, drained })}\n`,
  );
  process.exit(ok ? 0 : 1);
}

async function inspectRun(runId) {
  try {
    const { run, report, sources } = await readResearchRun(runId, {
      ...(options.runsDir ? { rootDir: options.runsDir } : {}),
    });
    return {
      persistedStatus: run.status,
      statusHistory: Array.isArray(run.statusHistory)
        ? run.statusHistory.map((entry) => entry.status)
        : undefined,
      reportChars: typeof report === "string" ? report.length : 0,
      sourcesCount: Array.isArray(sources) ? sources.length : null,
      durationMs: run.durationMs,
      errorCodes: Array.isArray(run.errors) ? run.errors.map((error) => error.code) : [],
    };
  } catch (error) {
    return { readError: String(error?.code ?? error?.name ?? "error") };
  }
}

timer = setTimeout(() => {
  void finish(false, { reason: "timeout", message: "no research outcome arrived before the deadline" });
}, options.timeoutMs);
timer.unref?.();

try {
  service = await startFeishuService({
    log: (entry) => {
      if (entry.level === "error") process.stderr.write(`${JSON.stringify(entry)}\n`);
    },
    onOutcome: (outcome) => {
      if (outcome.kind !== "research" || outcome.action === "accepted") return;
      if (outcome.chatType !== options.chatType) return;
      writeEvidence({ kind: "outcome", at: new Date().toISOString(), ...maskedOutcome(outcome) });
      if (finished) return;
      if (outcome.action === "replied" && outcome.status === "succeeded") {
        void (async () => {
          const inspected = outcome.runId ? await inspectRun(outcome.runId) : { readError: "missing_run_id" };
          const ok = inspected.persistedStatus === "completed";
          await finish(ok, {
            reason: ok ? "research_completed" : "run_status_mismatch",
            outcome: maskedOutcome(outcome),
            run: inspected,
          });
        })();
        return;
      }
      void finish(false, {
        reason: "research_not_completed",
        outcome: maskedOutcome(outcome),
      });
    },
  });
} catch (error) {
  const isConfig =
    error?.code === "feishu_config_error" ||
    error?.name === "FeishuConfigError" ||
    error?.name === "ConfigError";
  writeEvidence({
    kind: "start_failed",
    at: new Date().toISOString(),
    code: String(error?.code ?? error?.name ?? "error"),
    fields: Array.isArray(error?.fields) ? error.fields : undefined,
    message: isConfig ? error.message : undefined,
  });
  process.stderr.write(`agt-032 live start failed: ${error?.message ?? error}\n`);
  process.exit(isConfig ? 2 : 1);
}

writeEvidence({ kind: "connected", at: new Date().toISOString(), ...service.summary });
process.stderr.write(
  [
    "Feishu channel connected (real transport + AGT-028 research runtime).",
    `Send exactly one ${options.chatType === "group" ? "authorized-group @bot" : "private"} message: /research <short topic>`,
    `Waiting up to ${Math.round(options.timeoutMs / 1000)}s; evidence → ${options.evidence}`,
  ].join("\n"),
);
