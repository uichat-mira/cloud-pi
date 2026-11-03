/**
 * Local, reproducible delivery evidence for AGT-033.
 *
 * Runs the real scheduler → real AGT-028 `startResearch()` → real run store →
 * real delivery coordinator and store. Only the model/network boundary is a
 * deterministic fixture and the Feishu transport is a fake `sendMessage`; no
 * credential, real recipient or network call is involved.
 *
 *   node scripts/agt-033/local-delivery-evidence.mjs
 *
 * Appends one JSON line per scenario to
 * `poc/evidence/agt-033-local-delivery.jsonl` (override with --out).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FeishuSendError } from "../../src/channels/feishu/transport.mjs";
import {
  DELIVERY_STATUS,
  createDeliveryCoordinator,
  createDeliveringScheduler,
} from "../../src/delivery/index.mjs";
import { readResearchRun } from "../../src/research/index.mjs";
import { RUNTIME_PORT_VERSION } from "../../src/research/port.mjs";
import { TOOL } from "../../src/research/contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const args = process.argv.slice(2);
const outPath = (() => {
  const index = args.indexOf("--out");
  return index >= 0 ? args[index + 1] : join(repoRoot, "poc", "evidence", "agt-033-local-delivery.jsonl");
})();

const REPORT_TEXT = [
  "## 摘要",
  "",
  "本地证据：定时研究执行完成，命中真实 AGT-028 执行器与 run store。",
  "",
  "## 不确定性/失败项",
  "",
  "- 模型与网络由确定性 fixture 替代，这不是真实研究结果。",
].join("\n");

const TARGETS = [
  { type: "open_id", id: "ou_localperson0001", label: "个人" },
  { type: "chat_id", id: "oc_localgroup0001", label: "群" },
];

function usage() {
  return { inputTokens: 10, outputTokens: 20, totalTokens: 30, modelId: "fixture", providerId: "fixture", source: "provider" };
}

function toolLayer() {
  return {
    tools: [
      { name: TOOL.SEARCH, label: "fixture", description: "unused", parameters: { type: "object" }, async execute() { throw new Error("unused"); } },
      { name: TOOL.READ_PAGE, label: "fixture", description: "unused", parameters: { type: "object" }, async execute() { throw new Error("unused"); } },
    ],
  };
}

function completedPort({ text = REPORT_TEXT, toolCalls = [], status = "completed" } = {}) {
  return {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent() {
      return { status, text, usage: usage(), toolCalls, error: null };
    },
  };
}

function fakeTransport({ failures = [] } = {}) {
  const calls = [];
  async function sendMessage(request) {
    calls.push(request);
    const scripted = failures.length > 0 ? failures.shift() : null;
    if (scripted) throw scripted;
    return { messageId: `om_local_${String(calls.length).padStart(4, "0")}` };
  }
  return { sendMessage, calls };
}

function retryable(message = "simulated network error") {
  return new FeishuSendError(message, { code: "feishu_network_error", retryable: true });
}

function nonRetryable(message = "simulated invalid receive id") {
  return new FeishuSendError(message, { code: "feishu_api_error", retryable: false, feishuCode: 230001 });
}

function createClock(initial) {
  let ms = new Date(initial).getTime();
  const clock = () => new Date(ms);
  clock.set = (value) => {
    ms = new Date(value).getTime();
  };
  return clock;
}

async function withRoot(name, fn) {
  const root = await mkdtemp(join(tmpdir(), `cloud-pi-agt-033-${name}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function setup({ root, port, failures = [], limits = {} }) {
  const clock = createClock("2026-11-03T00:00:00Z");
  const runsDir = join(root, "runs");
  const transport = fakeTransport({ failures });
  const delivering = await createDeliveringScheduler({
    schedulerOptions: {
      stateDir: join(root, "scheduler"),
      now: clock,
      researchDeps: { runtimePort: port, toolLayer: toolLayer(), rootDir: runsDir, env: {} },
    },
    delivery: {
      stateDir: join(root, "delivery"),
      env: {},
      now: clock,
      sendMessage: transport.sendMessage,
      researchRunsDir: runsDir,
      limits: { retryDelayMs: 0, ...limits },
    },
  });
  return { clock, runsDir, delivering, transport };
}

async function createDaily(delivering, deliveryTargets = TARGETS) {
  return delivering.scheduler.createSchedule({
    scheduleId: "local-daily",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: { topic: "本地证据：48 小时 AI Agent 工程进展", timeRange: "48h" },
    deliveryTargets,
  });
}

function viewEvidence(view) {
  return {
    researchStatus: view.researchStatus,
    triggerStatus: view.triggerStatus,
    deliveryStatus: view.deliveryStatus,
    counts: view.counts,
    targets: view.targets.map((target) => ({
      type: target.destination.type,
      maskedId: target.destination.maskedId,
      status: target.status,
      attempts: target.attempts,
      deliveryKind: target.deliveryKind,
      messageId: target.messageId,
      messageIds: target.messageIds,
      lastError: target.lastError
          ? {
              code: target.lastError.code,
              retryable: target.lastError.retryable,
              ...(typeof target.lastError.feishuCode === "number" ? { feishuCode: target.lastError.feishuCode } : {}),
            }
          : null,
    })),
  };
}

const evidence = [];

// A. Clean success + duplicate completion callback + coordinator restart.
{
  const scenario = await withRoot("clean", async (root) => {
    const { clock, runsDir, delivering, transport } = await setup({ root, port: completedPort() });
    await createDaily(delivering);
    clock.set("2026-11-03T01:00:00Z");
    const [trigger] = (await delivering.scheduler.tick()).triggered;
    assert.equal(trigger.status, "succeeded");
    assert.equal(transport.calls.length, 2);
    const { run, report } = await readResearchRun(trigger.runId, { rootDir: runsDir });
    assert.equal(run.status, "completed");
    assert.match(report, /## 摘要/);

    const firstView = await delivering.getRunDelivery(trigger.runId);
    assert.equal(firstView.deliveryStatus, "sent");
    const sendsAfterFirst = transport.calls.length;

    // Duplicate completion callbacks.
    await delivering.deliverTrigger(trigger);
    await delivering.deliverTrigger(trigger);
    assert.equal(transport.calls.length, sendsAfterFirst, "duplicate callback must not send");

    // A new coordinator over the same persisted state (restart).
    const restartedTransport = fakeTransport();
    const restarted = createDeliveryCoordinator({
      stateDir: join(root, "delivery"),
      env: {},
      now: clock,
      sendMessage: restartedTransport.sendMessage,
      researchRunsDir: runsDir,
      limits: { retryDelayMs: 0 },
    });
    const restartView = await restarted.deliverRun({
      runId: trigger.runId,
      researchStatus: "completed",
      triggerStatus: "succeeded",
      schedule: delivering.scheduler.getSchedule("local-daily"),
    });
    assert.equal(restartedTransport.calls.length, 0, "restart must not send");
    assert.equal(restartView.deliveryStatus, "sent");

    return {
      scenario: "completed_report_two_targets_idempotent_replay_and_restart",
      runId: trigger.runId,
      runStatus: run.status,
      reportArtifact: run.paths.report,
      sends: transport.calls.length,
      sendsAfterDuplicateCallbacks: transport.calls.length,
      restartSends: restartedTransport.calls.length,
      delivery: viewEvidence(firstView),
      verified: true,
    };
  });
  evidence.push(scenario);
}

// B. One destination fails; the other keeps its sent record and research stays completed.
{
  const scenario = await withRoot("isolation", async (root) => {
    const { clock, delivering, transport } = await setup({
      root,
      port: completedPort(),
      failures: [null, nonRetryable()],
    });
    await createDaily(delivering);
    clock.set("2026-11-03T01:00:00Z");
    const [trigger] = (await delivering.scheduler.tick()).triggered;
    assert.equal(trigger.status, "succeeded");
    const view = await delivering.getRunDelivery(trigger.runId);
    assert.equal(view.deliveryStatus, "partial");
    assert.equal(view.researchStatus, "completed");
    const personal = view.targets.find((target) => target.destination.type === "open_id");
    const group = view.targets.find((target) => target.destination.type === "chat_id");
    assert.equal(personal.status, DELIVERY_STATUS.SENT);
    assert.equal(group.status, DELIVERY_STATUS.FAILED);
    assert.equal(transport.calls.length, 2);
    return {
      scenario: "single_destination_failure_isolation",
      runId: trigger.runId,
      researchStatus: view.researchStatus,
      triggerStatus: view.triggerStatus,
      deliveryStatus: view.deliveryStatus,
      counts: view.counts,
      targets: viewEvidence(view).targets,
      verified: true,
    };
  });
  evidence.push(scenario);
}

// C. Bounded retry: two transient failures then success; then an exhausted budget.
{
  const scenario = await withRoot("retry", async (root) => {
    const delivered = await setup({
      root,
      port: completedPort(),
      failures: [retryable(), retryable(), null],
      limits: { maxAttempts: 3 },
    });
    await createDaily(delivered.delivering, [TARGETS[0]]);
    delivered.clock.set("2026-11-03T01:00:00Z");
    const [trigger] = (await delivered.delivering.scheduler.tick()).triggered;
    const successView = await delivered.delivering.getRunDelivery(trigger.runId);
    assert.equal(successView.targets[0].attempts, 3);
    assert.equal(delivered.transport.calls.length, 3);

    const exhaustedRoot = join(root, "exhausted");
    const exhausted = await setup({
      root: exhaustedRoot,
      port: completedPort(),
      failures: Array.from({ length: 10 }, () => retryable()),
      limits: { maxAttempts: 3 },
    });
    await exhausted.delivering.scheduler.createSchedule({
      scheduleId: "local-daily",
      kind: "recurring",
      timezone: "Asia/Shanghai",
      cron: "0 9 * * *",
      request: { topic: "本地证据：重试上限", timeRange: "24h" },
      deliveryTargets: [TARGETS[0]],
    });
    exhausted.clock.set("2026-11-03T01:00:00Z");
    const [failedTrigger] = (await exhausted.delivering.scheduler.tick()).triggered;
    const failedView = await exhausted.delivering.getRunDelivery(failedTrigger.runId);
    assert.equal(failedView.targets[0].attempts, 3);
    assert.equal(exhausted.transport.calls.length, 3);
    await exhausted.delivering.deliverTrigger(failedTrigger);
    assert.equal(exhausted.transport.calls.length, 3, "terminal failure must not retry forever");

    return {
      scenario: "bounded_retry_and_exhaustion",
      retriedThenSent: {
        runId: trigger.runId,
        attempts: successView.targets[0].attempts,
        sends: 3,
        status: successView.targets[0].status,
        delivery: viewEvidence(successView),
      },
      exhausted: {
        runId: failedTrigger.runId,
        attempts: failedView.targets[0].attempts,
        sends: exhausted.transport.calls.length,
        status: failedView.targets[0].status,
        lastError: viewEvidence(failedView).targets[0].lastError,
        replaySends: exhausted.transport.calls.length,
      },
      verified: true,
    };
  });
  evidence.push(scenario);
}

// D. Long report segmentation and no duplicate segments on replay.
{
  const scenario = await withRoot("long", async (root) => {
    const longReport = `## 摘要\n\n${"长报告段落内容。".repeat(500)}`;
    const { clock, delivering, transport } = await setup({
      root,
      port: completedPort({ text: longReport }),
      limits: { maxCharsPerSegment: 500, maxSegments: 3 },
    });
    await createDaily(delivering, [TARGETS[0]]);
    clock.set("2026-11-03T01:00:00Z");
    const [trigger] = (await delivering.scheduler.tick()).triggered;
    const view = await delivering.getRunDelivery(trigger.runId);
    assert.equal(view.targets[0].messageIds.length, 3);
    assert.equal(transport.calls.length, 3);
    for (const call of transport.calls) assert.ok(Array.from(call.text).length <= 500);
    await delivering.deliverTrigger(trigger);
    assert.equal(transport.calls.length, 3);
    return {
      scenario: "long_report_bounded_segments",
      runId: trigger.runId,
      segments: view.targets[0].messageIds.length,
      maxSegmentChars: Math.max(...transport.calls.map((call) => Array.from(call.text).length)),
      sendsAfterReplay: transport.calls.length,
      delivery: viewEvidence(view),
      verified: true,
    };
  });
  evidence.push(scenario);
}

const lines = evidence.map((entry) =>
  JSON.stringify({
    evidence: "agt-033-local-delivery",
    generatedAt: new Date().toISOString(),
    node: process.version,
    modelNetworkBoundary: "deterministic fixture",
    feishuTransport: "fake sendMessage (no network)",
    ...entry,
  }),
);
await writeFile(outPath, `${lines.join("\n")}\n`);
console.log(`wrote ${evidence.length} scenario line(s) to ${outPath}`);
for (const entry of evidence) {
  const summary = [
    entry.scenario,
    entry.runId ? `run=${entry.runId}` : null,
    entry.delivery ? `delivery=${entry.delivery.deliveryStatus}` : null,
    entry.counts ? `sent=${entry.counts.sent} failed=${entry.counts.failed}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
  console.log(`  - ${summary}`);
}
console.log("all local scenarios verified against real scheduler/executor/store code");

