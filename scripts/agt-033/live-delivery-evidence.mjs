/**
 * AGT-033 T4: real Feishu proactive delivery evidence.
 *
 * This script sends through the official locked SDK
 * (`@larksuiteoapi/node-sdk@1.76.0`, `client.im.message.create`) to:
 *
 *   1. one real personal `open_id` (from `FEISHU_TEST_OPEN_ID`, or captured from
 *      a private message the maintainer sends to the bot in the same session);
 *   2. one real authorized group `chat_id` (`FEISHU_ALLOWED_CHAT_IDS`);
 *   3. one deliberately unreachable but well-formed `open_id` to prove failure
 *      isolation without any message being created.
 *
 * The research run itself uses the real scheduler/executor/run store with a
 * deterministic runtime fixture (no model/network research); this script is
 * evidence for the delivery path, not for a live model research run.
 *
 * Evidence contains masked destinations, run id and Feishu message ids only —
 * never message text, topic, raw ids or credentials.
 *
 *   node --env-file-if-exists=.env scripts/agt-033/live-delivery-evidence.mjs \
 *     [--wait-dm-seconds 240] [--append]
 *
 * Exit code 0 means every required check below passed; otherwise the evidence
 * line is still written with `verified:false` and the process fails.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeliveringScheduler, createDeliveryCoordinator } from "../../src/delivery/index.mjs";
import { loadFeishuConfig, maskId } from "../../src/channels/feishu/config.mjs";
import { FeishuSendError, createFeishuTransport } from "../../src/channels/feishu/transport.mjs";
import { normalizeFeishuMessageEvent } from "../../src/channels/feishu/events.mjs";
import { RUNTIME_PORT_VERSION } from "../../src/research/port.mjs";
import { TOOL } from "../../src/research/contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const waitDmSeconds = Number(argValue("--wait-dm-seconds", "240"));
const append = args.includes("--append");
const dryRun = args.includes("--dry-run");
const outPath = argValue("--out", join(repoRoot, "poc", "evidence", "agt-033-live-delivery.jsonl"));
const stateRoot = join(repoRoot, ".work", "agt-033", `live-${Date.now()}`);

const REPORT_TEXT = [
  "## 摘要",
  "",
  "AGT-033 投递通道验证：本消息由 Scheduler → 研究终态 → Delivery 主动发送。",
  "",
  "## 说明",
  "",
  "- 研究内容来自确定性 fixture，仅用于验证飞书主动投递，不是真实研究结论。",
  "- 同一运行不会重复发送；收到两条相同内容的个人/群消息即为异常。",
].join("\n");

const UNREACHABLE_OPEN_ID = `ou_${"0".repeat(32)}`;

function usage() {
  return { inputTokens: 10, outputTokens: 20, totalTokens: 30, modelId: "fixture", providerId: "fixture", source: "provider" };
}

function fixtureDeps(runsDir) {
  const toolLayer = {
    tools: [
      { name: TOOL.SEARCH, label: "fixture", description: "unused", parameters: { type: "object" }, async execute() { throw new Error("unused"); } },
      { name: TOOL.READ_PAGE, label: "fixture", description: "unused", parameters: { type: "object" }, async execute() { throw new Error("unused"); } },
    ],
  };
  const runtimePort = {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent() {
      return { status: "completed", text: REPORT_TEXT, usage: usage(), toolCalls: [], error: null };
    },
  };
  return { runtimePort, toolLayer, rootDir: runsDir, env: {} };
}

function sanitize(text, secrets = []) {
  let value = String(text ?? "");
  for (const raw of secrets) {
    if (typeof raw === "string" && raw) value = value.split(raw).join(maskId(raw));
  }
  return value.slice(0, 500);
}

async function main() {
  const config = loadFeishuConfig(process.env);
  if (!config.allowedChatIds.length) {
    throw new Error("FEISHU_ALLOWED_CHAT_IDS is empty; no authorized test group is configured");
  }
  const groupChatId = config.allowedChatIds[0];
  const secrets = [config.appSecret, groupChatId];

  let personalOpenId = (process.env.FEISHU_TEST_OPEN_ID ?? "").trim();
  let personalSource = "env:FEISHU_TEST_OPEN_ID";
  if (dryRun && !personalOpenId) {
    personalOpenId = "ou_dryrunperson0001";
    personalSource = "dry-run (no network)";
  }
  let transportStarted = false;
  let pendingPrivate;
  const transport = createFeishuTransport({
    config,
    log: () => {},
    onEvent: async (raw) => {
      const event = normalizeFeishuMessageEvent(raw);
      if (!event || event.chatType !== "p2p" || event.senderType !== "user") return;
      if (!event.senderOpenId || !event.senderOpenId.startsWith("ou_")) return;
      if (event.senderOpenId === transport.getBotOpenId()) return;
      pendingPrivate?.resolve?.(event.senderOpenId);
    },
  });

  const sendLog = [];
  async function sendMessage(request) {
    let messageId;
    if (dryRun) {
      if (request.receiveId === UNREACHABLE_OPEN_ID) {
        throw new FeishuSendError("dry-run unreachable destination", {
          code: "feishu_api_error",
          retryable: false,
          feishuCode: 230001,
        });
      }
      messageId = `om_dryrun_${String(sendLog.length + 1).padStart(4, "0")}`;
    } else {
      ({ messageId } = await transport.send(request));
    }
    sendLog.push({
      type: request.receiveIdType,
      maskedId: maskId(request.receiveId),
      segmentIndex: request.segmentIndex,
      messageId,
    });
    return { messageId };
  }

  try {
    let dmTimer;
    if (dryRun) {
      console.log(`dry-run 个人目标：${maskId(personalOpenId)}（不发送真实消息）`);
    } else if (!personalOpenId) {
      let resolveCapture;
      let rejectCapture;
      const capturePromise = new Promise((resolve, reject) => {
        resolveCapture = resolve;
        rejectCapture = reject;
      });
      pendingPrivate = { resolve: resolveCapture };
      await transport.start();
      transportStarted = true;
      console.log("等待维护者私聊：请用要作为个人目标的飞书账号给 Mira 机器人发任意一条私聊消息（无需 @）。");
      dmTimer = setTimeout(
        () => rejectCapture(new Error(`no private Feishu message received within ${waitDmSeconds}s`)),
        waitDmSeconds * 1000,
      );
      dmTimer.unref?.();
      const captured = await capturePromise.catch((error) => {
        throw new Error(`${error.message}. If the window was not available, re-run with FEISHU_TEST_OPEN_ID set.`);
      });
      clearTimeout(dmTimer);
      personalOpenId = captured;
      personalSource = "captured from inbound private message";
      secrets.push(personalOpenId);
      console.log(`捕获到个人目标：${maskId(personalOpenId)}`);
    } else {
      secrets.push(personalOpenId);
      console.log(`使用 FEISHU_TEST_OPEN_ID 个人目标：${maskId(personalOpenId)}`);
    }
    if (!/^ou_[A-Za-z0-9]+$/.test(personalOpenId)) {
      throw new Error("personal target is not a valid Feishu open_id");
    }
    if (personalOpenId === UNREACHABLE_OPEN_ID) {
      throw new Error("refusing to use the unreachable probe id as the personal target");
    }

    // Sending via im.message.create does not require the long connection; it is
    // started above only when the personal open_id must be captured from a DM.

    console.log(`测试群目标：${maskId(groupChatId)}（唯一授权群）`);
    const runsDir = join(stateRoot, "runs");
    await mkdir(stateRoot, { recursive: true });

    const delivering = await createDeliveringScheduler({
      schedulerOptions: {
        stateDir: join(stateRoot, "scheduler"),
        now: () => new Date(),
        researchDeps: fixtureDeps(runsDir),
      },
      delivery: {
        stateDir: join(stateRoot, "delivery"),
        env: {},
        now: () => new Date(),
        sendMessage,
        researchRunsDir: runsDir,
        limits: { retryDelayMs: 250 },
      },
    });
    const scheduleId = `live-${Date.now()}`;
    const deliveryTargets = [
      { type: "open_id", id: personalOpenId, label: "维护者私聊" },
      { type: "chat_id", id: groupChatId, label: "测试群" },
    ];
    await delivering.scheduler.createSchedule({
      scheduleId,
      kind: "recurring",
      timezone: "Asia/Shanghai",
      cron: "0 0 1 1 *",
      request: { topic: "AGT-033 飞书主动投递通道验证", timeRange: "24h" },
      deliveryTargets,
    });

    const trigger = await delivering.scheduler.runNow(scheduleId);
    if (trigger.status !== "succeeded" || trigger.researchStatus !== "completed") {
      throw new Error(`fixture research did not complete: trigger=${trigger.status} research=${trigger.researchStatus}`);
    }
    const firstView = await delivering.getRunDelivery(trigger.runId);
    const personal = firstView.targets.find(
      (target) => target.destination.type === "open_id" && target.destination.maskedId === maskId(personalOpenId),
    );
    const group = firstView.targets.find(
      (target) => target.destination.type === "chat_id" && target.destination.maskedId === maskId(groupChatId),
    );
    const personalSent = personal?.status === "sent" && Boolean(personal?.messageId);
    const groupSent = group?.status === "sent" && Boolean(group?.messageId);
    console.log(`个人投递：${personal?.status ?? "missing"}（attempts=${personal?.attempts ?? 0}）`);
    console.log(`群投递：${group?.status ?? "missing"}（attempts=${group?.attempts ?? 0}）`);
    if (!personalSent || !groupSent) {
      throw new Error(`required live sends not both sent: personal=${personal?.status} group=${group?.status}`);
    }
    const realSendCount = sendLog.length;
    if (realSendCount !== 2) {
      throw new Error(`expected exactly 2 real messages (one per real destination), sent ${realSendCount}`);
    }

    // Idempotency: duplicate completion callbacks plus a fresh coordinator
    // (process restart) over the same delivery state must send nothing.
    await delivering.deliverTrigger(trigger);
    await delivering.deliverTrigger(trigger);
    const duplicateCallbackSends = sendLog.length;
    const restarted = createDeliveryCoordinator({
      stateDir: join(stateRoot, "delivery"),
      env: {},
      now: () => new Date(),
      sendMessage,
      researchRunsDir: runsDir,
    });
    const restartView = await restarted.deliverRun({
      runId: trigger.runId,
      researchStatus: "completed",
      triggerStatus: "succeeded",
      schedule: delivering.scheduler.getSchedule(scheduleId),
    });
    const restartSends = sendLog.length;
    const idempotentReplay = duplicateCallbackSends === realSendCount && restartSends === realSendCount;
    console.log(
      `幂等重放：callback后发送=${duplicateCallbackSends}，重启后发送=${restartSends}（期望均为 ${realSendCount}）`,
    );

    // Failure isolation: a trusted, explicitly configured but unreachable
    // destination. It must fail without creating a message and without
    // touching the already-sent personal/group records.
    const bogusScheduleId = `live-unreachable-${Date.now()}`;
    await delivering.scheduler.createSchedule({
      scheduleId: bogusScheduleId,
      kind: "recurring",
      timezone: "Asia/Shanghai",
      cron: "0 0 1 1 *",
      enabled: false,
      request: { topic: "AGT-033 不可达目标隔离验证", timeRange: "24h" },
      deliveryTargets: [{ type: "open_id", id: UNREACHABLE_OPEN_ID, label: "不可达测试目标" }],
    });
    secrets.push(UNREACHABLE_OPEN_ID);
    const bogusSchedule = delivering.scheduler.getSchedule(bogusScheduleId);
    const beforeBogus = sendLog.length;
    await delivering.coordinator.deliverRun({
      runId: trigger.runId,
      researchStatus: "completed",
      triggerStatus: "succeeded",
      schedule: bogusSchedule,
    });
    const bogusSendSuccesses = sendLog.length - beforeBogus;
    const finalView = await delivering.getRunDelivery(trigger.runId);
    const bogusTarget = finalView.targets.find(
      (target) => target.destination.type === "open_id" && target.destination.maskedId === maskId(UNREACHABLE_OPEN_ID),
    );
    const bogusAttempts = bogusTarget?.attempts ?? 0;
    const personalAfter = finalView.targets.find(
      (target) => target.destination.type === "open_id" && target.destination.maskedId === maskId(personalOpenId),
    );
    const groupAfter = finalView.targets.find(
      (target) => target.destination.type === "chat_id" && target.destination.maskedId === maskId(groupChatId),
    );
    const failureIsolation =
      bogusTarget?.status === "failed" &&
      bogusAttempts >= 1 &&
      bogusAttempts <= 3 &&
      bogusSendSuccesses === 0 &&
      personalAfter?.status === "sent" &&
      personalAfter?.messageId === personal?.messageId &&
      groupAfter?.status === "sent" &&
      groupAfter?.messageId === group?.messageId &&
      finalView.researchStatus === "completed" &&
      finalView.deliveryStatus === "partial" &&
      finalView.counts.total === 3 &&
      finalView.counts.sent === 2 &&
      finalView.counts.failed === 1;
    console.log(
      `失败隔离：不可达目标=${bogusTarget?.status ?? "missing"}（尝试 ${bogusAttempts} 次），"研究=${finalView.researchStatus}，投递=${finalView.deliveryStatus}`,
    );

    const writeEnabled = !dryRun;
    const checks = {
      personalSent,
      groupSent,
      oneMessagePerRealDestination: realSendCount === 2,
      idempotentReplay,
      failureIsolation,
    };
    const verified = Object.values(checks).every(Boolean);
    const entry = {
      evidence: "agt-033-live-delivery",
      generatedAt: new Date().toISOString(),
      node: process.version,
      sdk: "@larksuiteoapi/node-sdk@1.76.0 im.message.create",
      research: {
        runId: trigger.runId,
        scheduleId,
        researchStatus: finalView.researchStatus,
        triggerStatus: finalView.triggerStatus,
        modelBoundary: "deterministic fixture (no live model/network research)",
      },
      personalTarget: {
        type: "open_id",
        maskedId: maskId(personalOpenId),
        source: personalSource,
        status: personalAfter?.status ?? null,
        attempts: personalAfter?.attempts ?? 0,
        messageId: personalAfter?.messageId ?? null,
        sentAt: personalAfter?.sentAt ?? null,
      },
      groupTarget: {
        type: "chat_id",
        maskedId: maskId(groupChatId),
        status: groupAfter?.status ?? null,
        attempts: groupAfter?.attempts ?? 0,
        messageId: groupAfter?.messageId ?? null,
        sentAt: groupAfter?.sentAt ?? null,
      },
      sendCount: {
        realMessages: realSendCount,
        afterDuplicateCallbacks: duplicateCallbackSends,
        afterCoordinatorRestart: restartSends,
      },
      idempotency: {
        duplicateCallbacks: 2,
        coordinatorRestart: true,
        noAdditionalMessages: idempotentReplay,
        expectedMessageIdsUnchanged:
          personalAfter?.messageId === personal?.messageId && groupAfter?.messageId === group?.messageId,
      },
      failureIsolation: {
        injectedDestination: { type: "open_id", maskedId: maskId(UNREACHABLE_OPEN_ID) },
        status: bogusTarget?.status ?? null,
        attempts: bogusAttempts,
        createdMessages: bogusSendSuccesses,
        errorCode: bogusTarget?.lastError?.code ?? null,
        feishuCode: bogusTarget?.lastError?.feishuCode ?? null,
        retryable: bogusTarget?.lastError?.retryable ?? null,
        deliveryStatusAfter: finalView.deliveryStatus,
        counts: finalView.counts,
        researchStatusAfter: finalView.researchStatus,
        otherTargetsUnchanged:
          personalAfter?.messageId === personal?.messageId && groupAfter?.messageId === group?.messageId,
      },
      checks,
      verified,
    };
    if (writeEnabled) await writeEvidence(entry);
    if (!verified) {
      throw new Error(`live checks failed: ${JSON.stringify(checks)}`);
    }
    if (writeEnabled) console.log(`Live evidence written to ${outPath}`);
    else console.log("dry-run complete: no live evidence written");
    return entry;
  } finally {
    if (transportStarted) transport.stop();
  }
}

async function writeEvidence(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  await mkdir(dirname(outPath), { recursive: true });
  if (append) {
    let existing = "";
    try {
      existing = await readFile(outPath, "utf8");
    } catch {
      existing = "";
    }
    await writeFile(outPath, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${line}`);
  } else {
    await writeFile(outPath, line);
  }
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  const personal = process.env.FEISHU_TEST_OPEN_ID ?? "";
  const groupIds = String(process.env.FEISHU_ALLOWED_CHAT_IDS ?? "")
    .split(/[\s,;]+/)
    .filter(Boolean);
  const secrets = [personal, ...groupIds, UNREACHABLE_OPEN_ID].filter(Boolean);
  const message = sanitize(error?.message ?? error, secrets);
  console.error(`live delivery evidence failed: ${message}`);
  if (dryRun) process.exit(exitCode);
  try {
    await writeEvidence({
      evidence: "agt-033-live-delivery",
      generatedAt: new Date().toISOString(),
      node: process.version,
      sdk: "@larksuiteoapi/node-sdk@1.76.0 im.message.create",
      verified: false,
      error: {
        name: String(error?.name ?? "Error"),
        code: error instanceof FeishuSendError ? error.code : String(error?.code ?? "live_error"),
        message,
      },
      checks: {
        personalSent: false,
        groupSent: false,
        oneMessagePerRealDestination: false,
        idempotentReplay: false,
        failureIsolation: false,
      },
    });
    console.error(`failure evidence written to ${outPath}`);
  } catch (writeError) {
    console.error(`could not write failure evidence: ${String(writeError?.message ?? writeError)}`);
  }
}
process.exit(exitCode);
