#!/usr/bin/env node
/**
 * AGT-036 follow-up live acceptance: ack → pushed final reply.
 *
 * Proves, against the real bot, the two-phase contract the channel now implements:
 *
 *   1. an inbound message is acknowledged inside the callback (`replyStream` on that
 *      callback's `req_id`) — measured, not assumed;
 *   2. the finished answer is pushed with `aibot_send_msg` to the *same*
 *      conversation with an explicit `chat_type`;
 *   3. both evidence lines carry the same callback `requestId` and the same hashed
 *      inbound message, so ack and final can be joined without a second tracing
 *      system.
 *
 * Usage (maintainer):
 *   node scripts/agt-036/two-phase-live.mjs [--secrets <path>] [--env-file <path>]
 *        [--inbound-timeout-ms 600000] [--ack-deadline-ms 5000]
 *        [--expect-chat-type any|single|group] [--evidence <path>] [--self-test]
 *
 * `--self-test` runs the same verifier over an in-process fake client; it proves the
 * harness, not the platform, and says so in the output.
 *
 * Exit codes: 0 verified, 1 live failure/timeout, 2 configuration or usage error.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashId } from "../../src/channels/wecom/config.mjs";
import { createWecomService } from "../../src/channels/wecom/service.mjs";
import { DEFAULT_MODEL_ENV_FILE, DEFAULT_SECRETS_FILE, loadEnvFiles } from "./wecom-live.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export const DEFAULT_EVIDENCE_FILE = join(REPO_ROOT, ".work", "wecom-channel", "two-phase-evidence.jsonl");
export const DEFAULT_INBOUND_TIMEOUT_MS = 600_000;
export const DEFAULT_ACK_DEADLINE_MS = 5_000;
export const EXPECT_CHAT_TYPES = Object.freeze(["any", "single", "group"]);

/**
 * Whitelist projection of one phase. `requestId` is the platform's callback handle
 * (not personal data); every user/chat identifier is hashed.
 */
export function phaseEvidence(outcome, model) {
  return {
    phase: outcome.phase,
    action: outcome.action,
    ok:
      outcome.phase === "ack"
        ? outcome.action === "acked"
        : outcome.action === "replied" && outcome.replyDelivered === true,
    delivery: outcome.delivery ?? null,
    requestId: outcome.requestId ?? null,
    chatType: outcome.chatType ?? null,
    chat: outcome.chatId ? hashId(outcome.chatId) : null,
    inboundMessage: outcome.messageId ? hashId(outcome.messageId) : null,
    runId: typeof outcome.runId === "string" ? outcome.runId : null,
    model: { provider: model?.provider ?? null, model: model?.model ?? null },
    ackMs: typeof outcome.ackMs === "number" ? outcome.ackMs : null,
    durationMs: outcome.durationMs ?? null,
    segments: outcome.segments ?? null,
    segmentsDelivered: outcome.segmentsDelivered ?? null,
    replyDelivered: outcome.replyDelivered === true,
    platformErrcode: typeof outcome.platformErrcode === "number" ? outcome.platformErrcode : null,
    platformCode: typeof outcome.platformCode === "number" ? outcome.platformCode : null,
  };
}

/**
 * Verify one accepted inbound's phases.
 *
 * @param {{accepted?: object, ack?: object, final?: object}} phases
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function verifyTwoPhase({ accepted, ack, final } = {}) {
  const reasons = [];
  if (!accepted) reasons.push("no_inbound");
  if (!ack) reasons.push("no_ack");
  if (!final) reasons.push("no_final");
  if (ack && ack.action !== "acked") reasons.push(`ack_not_delivered:${ack.action ?? "unknown"}`);
  if (final && final.delivery !== "push") reasons.push(`final_not_pushed:${final.delivery ?? "unknown"}`);
  if (final && final.action !== "replied") reasons.push(`final_failed:${final.reason ?? final.action ?? "unknown"}`);
  if (final && final.replyDelivered !== true) reasons.push("final_not_delivered");
  if (ack?.requestId && final?.requestId && ack.requestId !== final.requestId) reasons.push("request_id_mismatch");
  if (ack?.messageId && final?.messageId && ack.messageId !== final.messageId) reasons.push("message_id_mismatch");
  return { ok: reasons.length === 0, reasons };
}

function parseArgs(argv) {
  const options = {
    secretsFile: DEFAULT_SECRETS_FILE,
    modelEnvFile: DEFAULT_MODEL_ENV_FILE,
    inboundTimeoutMs: DEFAULT_INBOUND_TIMEOUT_MS,
    ackDeadlineMs: DEFAULT_ACK_DEADLINE_MS,
    expectChatType: "any",
    evidenceFile: DEFAULT_EVIDENCE_FILE,
    selfTest: false,
    help: false,
    unknown: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => argv[index + 1];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--secrets") {
      options.secretsFile = take();
      index += 1;
    } else if (arg === "--env-file") {
      options.modelEnvFile = take();
      index += 1;
    } else if (arg === "--evidence") {
      options.evidenceFile = take();
      index += 1;
    } else if (arg === "--inbound-timeout-ms") {
      options.inboundTimeoutMs = Number(take());
      index += 1;
    } else if (arg === "--ack-deadline-ms") {
      options.ackDeadlineMs = Number(take());
      index += 1;
    } else if (arg === "--expect-chat-type") {
      options.expectChatType = take();
      index += 1;
    } else options.unknown = arg;
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/agt-036/two-phase-live.mjs [--secrets <path>] [--env-file <path>]",
    "         [--inbound-timeout-ms 600000] [--ack-deadline-ms 5000]",
    "         [--expect-chat-type any|single|group] [--evidence <path>] [--self-test]",
  ].join("\n");
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  serviceOptions = {},
} = {}) {
  const options = parseArgs(argv);
  const write = (stream, payload) => stream.write(`${JSON.stringify(payload)}\n`);
  const appendEvidence = (entry) => {
    try {
      mkdirSync(dirname(options.evidenceFile), { recursive: true });
      appendFileSync(options.evidenceFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch {
      // Evidence persistence must never break the live run itself.
    }
  };

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.unknown) {
    write(stderr, { ok: false, phase: "usage", reason: "unknown_argument", argument: options.unknown });
    return 2;
  }
  if (!Number.isFinite(options.inboundTimeoutMs) || options.inboundTimeoutMs < 1_000) {
    write(stderr, { ok: false, phase: "usage", reason: "invalid_inbound_timeout" });
    return 2;
  }
  if (!Number.isFinite(options.ackDeadlineMs) || options.ackDeadlineMs < 100) {
    write(stderr, { ok: false, phase: "usage", reason: "invalid_ack_deadline" });
    return 2;
  }
  if (!EXPECT_CHAT_TYPES.includes(options.expectChatType)) {
    write(stderr, {
      ok: false,
      phase: "usage",
      reason: "invalid_expect_chat_type",
      allowed: EXPECT_CHAT_TYPES,
    });
    return 2;
  }

  const fromFiles = loadEnvFiles([options.modelEnvFile, options.secretsFile]);
  const merged = { ...fromFiles, ...env };
  if (options.selfTest) {
    // The self-test verifies the two-phase *transport* contract with a fake client
    // and a fake runtime; that runtime answers in a few ms, so the production ack
    // merge window (`WECOM_ACK_MERGE_MS`, 1.5 s) would legitimately suppress the
    // ack. Disable the window here so the self-test exercises ack → push.
    merged.WECOM_ACK_MERGE_MS = "0";
  }
  if (!options.selfTest && (!merged.WECOM_BOT_ID || !merged.WECOM_BOT_SECRET)) {
    write(stderr, {
      ok: false,
      phase: "config",
      reason: "missing_bot_credentials",
      secretsFileFound: existsSync(options.secretsFile),
      modelEnvFileFound: existsSync(options.modelEnvFile),
    });
    return 2;
  }

  /** @type {{accepted?: object, ack?: object, final?: object, failures: object[]}} */
  const phases = { failures: [] };
  let settleFinal;
  const finished = new Promise((resolvePromise) => {
    settleFinal = resolvePromise;
  });

  let service;
  try {
    service = createWecomService({
      env: merged,
      // Keep the run readable: transport/agent log lines go to stdout, the JSONL
      // evidence holds the whitelist projection only.
      log: (entry) => write(stdout, { ts: new Date().toISOString(), ...entry }),
      onOutcome: (outcome) => {
        if (outcome?.action === "accepted") {
          phases.accepted = outcome;
          return;
        }
        if (outcome?.phase === "ack") {
          // The first ack after the accepted message is the one under test.
          if (!phases.ack) phases.ack = outcome;
          return;
        }
        if (outcome?.phase === "final" || outcome?.phase === "hint") {
          if (!phases.final) {
            phases.final = outcome;
            settleFinal(outcome);
          }
          return;
        }
        if (outcome?.action === "failed" || outcome?.action === "ignored") phases.failures.push(outcome);
      },
      ...serviceOptions,
    });
  } catch (error) {
    write(stderr, { ok: false, phase: "config", code: String(error?.code ?? error?.name ?? "error") });
    return 2;
  }

  if (options.selfTest) {
    // The self-test uses the injected fake client from `serviceOptions`, which the
    // unit tests provide; it proves the verifier and wiring, not the platform.
    const selfTest = await runSelfTest({ service, phases, options, stdout, stderr });
    await service.stop().catch(() => {});
    return selfTest;
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
    expectChatType: options.expectChatType,
    waitingForInboundMs: options.inboundTimeoutMs,
    instruction: "Send one message to the bot in WeCom now; the ack should arrive immediately.",
  });

  let timer;
  const timeout = new Promise((resolvePromise) => {
    timer = setTimeout(() => resolvePromise("timeout"), options.inboundTimeoutMs);
  });
  const settled = await Promise.race([finished, timeout]);
  clearTimeout(timer);

  if (settled === "timeout") {
    await service.stop().catch(() => {});
    const payload = {
      ok: false,
      phase: "wait_inbound",
      reason: "no_inbound_message",
      observed: { accepted: Boolean(phases.accepted), ack: Boolean(phases.ack) },
    };
    write(stderr, payload);
    appendEvidence(payload);
    return 1;
  }

  const verdict = verifyTwoPhase(phases);
  const model = { provider: merged.CLOUD_PI_MODEL_PROVIDER_ID, model: merged.CLOUD_PI_MODEL_ID };
  const lines = [phases.ack, phases.final].filter(Boolean).map((outcome) => phaseEvidence(outcome, model));
  for (const line of lines) appendEvidence({ event: "two_phase_phase", ...line });

  // The acceptance contract says the ack must be fast; a slow ack still reaches the
  // user, so it is reported rather than silently accepted.
  const ackFast = typeof phases.ack?.ackMs === "number" && phases.ack.ackMs <= options.ackDeadlineMs;
  const chatTypeOk = options.expectChatType === "any" || phases.final?.chatType === options.expectChatType;

  const payload = {
    ok: verdict.ok && ackFast && chatTypeOk,
    phase: "result",
    expectChatType: options.expectChatType,
    ackFast,
    ackDeadlineMs: options.ackDeadlineMs,
    ackMs: typeof phases.ack?.ackMs === "number" ? phases.ack.ackMs : null,
    chatTypeOk,
    phases: lines,
    reasons: [
      ...verdict.reasons,
      ...(ackFast ? [] : ["ack_slower_than_deadline"]),
      ...(chatTypeOk ? [] : ["chat_type_mismatch"]),
    ],
  };
  await service.stop().catch(() => {});
  write(payload.ok ? stdout : stderr, { ts: new Date().toISOString(), event: "two_phase_live_result", ...payload });
  appendEvidence({ event: "two_phase_live_result", ...payload });
  return payload.ok ? 0 : 1;
}

async function runSelfTest({ service, phases, options, stdout = process.stdout, stderr = process.stderr }) {
  await service.start().catch(() => {});
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !phases.final) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  await service.channel.whenIdle().catch(() => {});
  const verdict = verifyTwoPhase(phases);
  const payload = {
    ok: verdict.ok,
    phase: "self_test",
    // Explicit: this proves the harness over a fake client, not the platform.
    real: false,
    note: "in-process fake client and fake runtime; not a live WeCom verification",
    reasons: verdict.reasons,
    ackMs: typeof phases.ack?.ackMs === "number" ? phases.ack.ackMs : null,
    ackDeadlineMs: options.ackDeadlineMs,
  };
  (payload.ok ? stdout : stderr).write(`${JSON.stringify(payload)}\n`);
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
