#!/usr/bin/env node
/**
 * AGT-035 — real Feishu collaboration evidence.
 *
 * One real research run, delivered proactively to *confirmed* targets in the
 * maintainer's own Feishu tenant, with every target recorded independently and
 * read back through the local management API.
 *
 * What is real here:
 *   - Feishu chat discovery (`im/v1/chats`, read-only) and WebSocket events;
 *   - the maintainer's private message, used only to learn the real sender id;
 *   - one AGT-028 research run through the AGT-027 runtime and research tools;
 *   - the AGT-033 delivery stage (`im/message/create`) and the AGT-034 API.
 *
 * What this script never does:
 *   - invent a chat id: a group target must come from the platform chat list
 *     *and* the controlled allowlist; an unjoined group is reported as
 *     `bot_not_in_chat` (invite the bot) and aborts the run;
 *   - accept a person who never messaged the bot, or an unconfirmed sender;
 *   - send to any chat that is not an explicitly resolved target;
 *   - repeat a delivery: the run is replayed twice after delivery and the
 *     transport send counter must not move.
 *
 * Usage (`.env` is read, never written; no secret is printed):
 *
 *   node --env-file-if-exists=.env scripts/agt-035/live-collaboration-evidence.mjs \
 *     --group-name 东热战神 --confirm-dm --wait-dm-seconds 300 \
 *     --topic "研究最近 48 小时 AI Agent 工程进展"
 *
 * Options:
 *   --group-name <name>        wanted group (matched against the bot's chats)
 *   --topic <text>             research topic (default: 48h AI Agent progress)
 *   --wait-dm-seconds <n>      how long to wait for the maintainer's DM
 *   --confirm-dm               opt in to a DM target; bind it with a one-time challenge
 *   --group-only               skip the private target entirely
 *   --out <path>               evidence file
 *   --api-port <n>             0 picks an ephemeral loopback port
 */
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeliveringScheduler } from "../../src/delivery/index.mjs";
import {
  createFeishuChatDirectory,
  maskTarget,
  resolveTargets,
  toDeliveryTargets,
} from "../../src/delivery/targets.mjs";
import { loadFeishuConfig, maskId } from "../../src/channels/feishu/config.mjs";
import { createFeishuTransport } from "../../src/channels/feishu/transport.mjs";
import { normalizeFeishuMessageEvent } from "../../src/channels/feishu/events.mjs";
import {
  isSuccessfulCollaborationEvidence,
  matchesPrivateMessageChallenge,
  sanitizeDeliveryEvidence,
} from "./evidence-contract.mjs";
import { createManagementApi } from "../../src/api/index.mjs";
import { loadAgentRuntimePort } from "../../src/research/port.mjs";
import { ENV as RESEARCH_ENV } from "../../src/research/contracts.mjs";
import { appendFile, mkdir } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const DEFAULT_TOPIC = "研究最近 48 小时 AI Agent 工程进展";
const DEFAULT_EVIDENCE = join(repoRoot, "poc", "evidence", "agt-035-live-collaboration.jsonl");
const TIMEZONE = "Asia/Shanghai";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const groupName = argValue("--group-name", "").trim();
const topic = argValue("--topic", DEFAULT_TOPIC);
const waitDmSeconds = Number(argValue("--wait-dm-seconds", "300"));
const confirmDm = args.includes("--confirm-dm");
const groupOnly = args.includes("--group-only");
const outPath = argValue("--out", DEFAULT_EVIDENCE);
const apiPort = Number(argValue("--api-port", "0"));
const maxSearches = Number(argValue("--max-searches", "0"));
const maxPages = Number(argValue("--max-pages", "0"));
const maxRuntimeMs = Number(argValue("--max-runtime-ms", "0"));
const limits = {};
if (maxSearches > 0) limits.maxSearches = maxSearches;
if (maxPages > 0) limits.maxPages = maxPages;
if (maxRuntimeMs > 0) limits.maxRuntimeMs = maxRuntimeMs;
const stateRoot = join(repoRoot, ".work", "agt-035", `live-${Date.now()}`);
const runsDir = join(stateRoot, "research-runs");
const deliveryDir = join(stateRoot, "delivery");
const schedulerDir = join(stateRoot, "scheduler");

if (!groupName && !groupOnly) {
  throw new Error("--group-name is required (the group the bot already joined)");
}
if (confirmDm && groupOnly) {
  throw new Error("--confirm-dm cannot be combined with --group-only");
}
if (!Number.isFinite(waitDmSeconds) || waitDmSeconds <= 0) {
  throw new Error("--wait-dm-seconds expects a positive number");
}

async function record(entry) {
  await mkdir(dirname(outPath), { recursive: true });
  await appendFile(outPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
}

function localWallTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

async function waitForPrivateMessage(transport, seconds, challenge) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.__captureP2p = null;
      resolve({ ...value, waitedMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => finish({ observed: false, openId: null }), seconds * 1000);
    // A sender is bound only by the unpredictable code printed to this local
    // terminal. An arbitrary DM during the window is not an identity proof.
    transport.__captureP2p = (event) => {
      if (!matchesPrivateMessageChallenge(event, challenge, transport.getBotOpenId())) return;
      finish({ observed: true, openId: event.senderOpenId });
    };
  });
}

async function buildResearchDeps() {
  const runtimeModule = process.env[RESEARCH_ENV.AGENT_RUNTIME_MODULE];
  const runtimePort = await loadAgentRuntimePort({ moduleSpecifier: runtimeModule });
  const [{ createWebSearchTool }, { createReadPageTool }] = await Promise.all([
    import("../../src/research/tools/search.mjs"),
    import("../../src/research/tools/read-page.mjs"),
  ]);
  const provider = process.env[RESEARCH_ENV.SEARCH_PROVIDER];
  const toolLayer = {
    tools: [
      createWebSearchTool(provider ? { provider } : {}),
      createReadPageTool({}),
    ],
  };
  return { runtimePort, toolLayer };
}

async function main() {
  const config = loadFeishuConfig(process.env);
  if (!config.allowedChatIds.length) {
    throw new Error("FEISHU_ALLOWED_CHAT_IDS is empty: no group is authorized for delivery");
  }
  const secrets = [config.appSecret];
  const sanitizeText = (text) => {
    let value = String(text ?? "");
    for (const secret of secrets) {
      if (secret) value = value.split(secret).join("[redacted]");
    }
    return value.slice(0, 300);
  };

  let api;
  let transport;
  let delivering;
  let sendCalls = 0;

  try {
    // 1) Read-only discovery: which chats has the bot already joined?
    const directory = createFeishuChatDirectory({ config });
    const discovered = await directory.listChats();
    await record({
      event: "chat_discovery",
      botChatCount: discovered.chats.length,
      truncated: discovered.truncated,
      chats: discovered.chats.map((chat) => ({
        name: chat.name,
        maskedId: maskId(chat.chatId),
        chatMode: chat.chatMode,
      })),
    });

    // 2) Watch real events until the maintainer messages the bot privately.
    transport = createFeishuTransport({
      config,
      log: () => {},
      onEvent: async (raw) => {
        const event = normalizeFeishuMessageEvent(raw);
        if (!event) return;
        transport.__captureP2p?.(event);
      },
    });
    const started = await transport.start();
    const botOpenId = started?.botOpenId ?? transport.getBotOpenId();

    let observation = { observed: false, openId: null, waitedMs: 0 };
    if (!groupOnly && confirmDm) {
      const challenge = randomBytes(16).toString("hex");
      console.log(
        `\n请从准备授权的飞书账号，向机器人私聊发送这段一次性验证码：\n\n${challenge}\n\n验证码仅在本机显示，不写入证据。等待 ${waitDmSeconds}s…`,
      );
      observation = await waitForPrivateMessage(transport, waitDmSeconds, challenge);
      await record({
        event: "private_message_capture",
        observed: observation.observed,
        challengeMatched: observation.observed,
        confirmationMethod: "one_time_challenge",
        maskedSender: observation.openId ? maskId(observation.openId) : null,
        waitedMs: observation.waitedMs,
      });
      if (!observation.observed) {
        throw new Error(
          "no private message with the one-time challenge was observed; run again with the intended Feishu account available (or use --group-only)",
        );
      }
    } else if (!groupOnly) {
      console.log("未启用 --confirm-dm：跳过私聊目标，本次只解析群目标。");
    }

    // 3) Resolve targets from platform facts + controlled config only.
    const resolution = resolveTargets({
      authorizedChatIds: config.allowedChatIds,
      botChats: discovered.chats,
      wantedGroups: groupName ? [{ name: groupName }] : [],
      observedP2pSenderIds: observation.openId ? [observation.openId] : [],
      confirmedP2pOpenIds: confirmDm && observation.openId ? [observation.openId] : [],
    });
    await record({
      event: "target_resolution",
      requestedGroup: groupName || null,
      confirmDm,
      confirmationMethod: confirmDm ? "one_time_challenge" : null,
      targets: resolution.targets.map(maskTarget),
      unavailable: resolution.unavailable,
      rejected: resolution.rejected,
      counts: resolution.counts,
    });
    if (resolution.targets.length === 0) {
      throw new Error("no deliverable target was resolved; see the unavailable/rejected evidence");
    }
    const deliveryTargets = toDeliveryTargets(resolution);
    console.log(`\n解析到 ${deliveryTargets.length} 个已确认目标（脱敏）：`);
    for (const target of resolution.targets.map(maskTarget)) {
      console.log(`  - ${target.type} ${target.maskedId} (${target.label ?? "-"})`);
    }

    // 4) Real research dependencies (AGT-027 runtime + real research tools).
    const researchDeps = await buildResearchDeps();
    delivering = await createDeliveringScheduler({
      schedulerOptions: {
        stateDir: schedulerDir,
        env: process.env,
        researchDeps: { ...researchDeps, rootDir: runsDir, env: process.env },
      },
      delivery: {
        stateDir: deliveryDir,
        researchRunsDir: runsDir,
        env: process.env,
        sendMessage: async ({ receiveIdType, receiveId, text, uuid }) => {
          sendCalls += 1;
          return transport.send({ receiveIdType, receiveId, text, uuid });
        },
      },
    });

    // 5) One manual run of one schedule: one real research run, N targets.
    const schedule = await delivering.scheduler.createSchedule({
      kind: "once",
      timezone: TIMEZONE,
      at: localWallTime(new Date(Date.now() + 120_000), TIMEZONE),
      request: { topic, ...(Object.keys(limits).length > 0 ? { limits } : {}) },
      deliveryTargets,
    });
    await record({
      event: "schedule_created",
      scheduleId: schedule.scheduleId,
      kind: schedule.kind,
      deliveryTargetCount: deliveryTargets.length,
      targets: deliveryTargets.map(maskTarget),
      // Research-only proxy hint (RESEARCH_HTTPS_PROXY); the value is never logged.
      researchProxyConfigured: Boolean(process.env.RESEARCH_HTTPS_PROXY),
      limits,
    });

    console.log(`\n开始唯一一次真实研究：${topic}`);
    const trigger = await delivering.scheduler.runNow(schedule.scheduleId);
    const runId = trigger?.runId ?? null;
    await record({
      event: "research_run",
      scheduleId: schedule.scheduleId,
      runId,
      triggerStatus: trigger?.status ?? null,
      researchStatus: trigger?.researchStatus ?? null,
      durationMs: trigger?.durationMs ?? null,
      errorCode: trigger?.error?.code ?? null,
    });
    if (!runId) throw new Error("the research run produced no run id; nothing could be delivered");

    const delivery = await delivering.getRunDelivery(runId);
    await record({
      event: "delivery_record",
      delivery: sanitizeDeliveryEvidence(delivery),
    });

    // 6) Idempotent replay: the same terminal trigger twice must not send again.
    const beforeReplay = sendCalls;
    await delivering.deliverTrigger(trigger);
    await delivering.deliverTrigger(trigger);
    const afterReplay = sendCalls;
    await record({
      event: "idempotent_replay",
      runId,
      sendCallsBefore: beforeReplay,
      sendCallsAfter: afterReplay,
      unchanged: beforeReplay === afterReplay,
    });

    // 7) Read every target back through the local management API (AGT-034).
    api = createManagementApi({
      deliveringScheduler: delivering,
      runsDir,
      host: "127.0.0.1",
      port: apiPort,
      env: process.env,
    });
    const address = await api.start();
    // `address.url` already carries the API prefix (for example
    // `http://127.0.0.1:5563/v1`), so paths must not repeat `/v1`.
    const statusResponse = await fetch(`${address.url}/status`);
    const statusBody = await statusResponse.json();
    const deliveryResponse = await fetch(`${address.url}/runs/${runId}/delivery`);
    const deliveryBody = await deliveryResponse.json();
    const apiDelivery = deliveryBody?.data?.delivery ?? null;
    const safeApiDelivery = sanitizeDeliveryEvidence(apiDelivery);
    await record({
      event: "management_api_readback",
      url: address.url,
      statusCode: statusResponse.status,
      deliveryStatusCode: deliveryResponse.status,
      deliveryCapability: statusBody?.data?.capabilities?.deliveryStatus ?? null,
      delivery: safeApiDelivery,
    });

    const ok = isSuccessfulCollaborationEvidence({
      statusCode: statusResponse.status,
      statusBody,
      deliveryStatusCode: deliveryResponse.status,
      deliveryBody,
      expectedTargets: deliveryTargets.map(maskTarget),
      sendCallsBefore: beforeReplay,
      sendCallsAfter: afterReplay,
      runId,
    });
    await record({
      event: "result",
      ok,
      runId,
      researchStatus: safeApiDelivery?.researchStatus ?? null,
      deliveryStatus: safeApiDelivery?.deliveryStatus ?? null,
      counts: safeApiDelivery?.counts ?? null,
      apiTargetCount: safeApiDelivery?.targets?.length ?? 0,
      idempotent: beforeReplay === afterReplay,
    });

    console.log(`\nrun: ${runId}`);
    console.log(`research: ${delivery?.researchStatus ?? "?"} / delivery: ${delivery?.deliveryStatus ?? "?"}`);
    console.log(`targets: ${JSON.stringify(delivery?.counts ?? {})}`);
    for (const target of deliveryBody?.data?.delivery?.targets ?? []) {
      console.log(`  - ${target.destination?.type} ${target.destination?.maskedId}: ${target.status} (${target.attempts}x)`);
    }
    console.log(`幂等重放：发送计数 ${beforeReplay} -> ${afterReplay}`);
    console.log(`证据：${outPath}`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    await record({
      event: "error",
      code: String(error?.code ?? error?.name ?? "error"),
      message: sanitizeText(error?.message ?? error),
    });
    throw error;
  } finally {
    try {
      await api?.stop();
    } catch {
      /* observation only */
    }
    transport?.stop();
    try {
      await delivering?.scheduler?.dispose?.();
    } catch {
      /* observation only */
    }
  }
}

main().catch((error) => {
  console.error(`error: ${sanitizeErrorMessage(error)}`);
  process.exitCode = 1;
});

function sanitizeErrorMessage(error) {
  return String(error?.message ?? error).slice(0, 300);
}
