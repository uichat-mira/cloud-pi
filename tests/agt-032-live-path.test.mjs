/**
 * AGT-032 T3: real Feishu → AGT-028 path.
 *
 * Everything below the model/network boundary is real: the Feishu adapter, the
 * research command contract, `startResearch()`, the executor, the run store and
 * `readResearchRun()`. Only the AGT-027 runtime port and the research tool layer
 * are deterministic fixtures, exactly as the Issue allows. Feishu reply is a
 * fake adapter. `startResearch` is never mocked here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeishuChannel } from "../src/channels/feishu/channel.mjs";
import { createFeishuResearchRunner } from "../src/channels/feishu/runtime.mjs";
import { listResearchRuns, readResearchRun } from "../src/research/index.mjs";
import { RUNTIME_PORT_VERSION } from "../src/research/port.mjs";
import { RUN_ID_PATTERN } from "../src/research/run-store.mjs";
import { textEvent } from "./helpers/feishu-events.mjs";
import {
  REPORT_TEXT,
  completedPort,
  fixtureToolLayer,
  hangingPort,
  pageFailed,
  partialPort,
  usage,
} from "./agt-032-fixtures.mjs";

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "cloud-pi-agt032-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function harness({ rootDir, runtimePort, toolLayer = fixtureToolLayer(), reply, maxConcurrent } = {}) {
  const outcomes = [];
  const replies = [];
  const runner = createFeishuResearchRunner({
    env: {},
    researchDeps: { runtimePort, toolLayer, rootDir },
    maxConcurrent,
  });
  const channel = createFeishuChannel({
    runTurn: async () => {
      assert.fail("chat runtime must not be called");
    },
    runResearch: runner.runResearch,
    reply:
      reply ??
      (async (messageId, text) => {
        replies.push({ messageId, text });
        return { messageId: `om_reply_${replies.length}` };
      }),
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  return { channel, replies, outcomes, runner };
}

test("T3 private /research → real startResearch → run store → bounded reply", async (t) => {
  const rootDir = await tempRoot(t);
  const { channel, replies, outcomes } = harness({ rootDir, runtimePort: completedPort() });

  channel.handleEvent(textEvent({ text: "/research AI Agent 工程进展" }));
  await channel.whenIdle();

  const runs = await listResearchRuns({ rootDir });
  assert.equal(runs.length, 1);
  const runId = runs[0].runId;
  assert.match(runId, RUN_ID_PATTERN);

  const { run, report, sources } = await readResearchRun(runId, { rootDir });
  assert.equal(run.status, "completed");
  assert.equal(run.request.topic, "AI Agent 工程进展");
  assert.equal(run.paths.report, "report.md");
  assert.match(report, /## 摘要/);
  assert.match(report, /来源: 共/);
  assert.ok(Array.isArray(sources));

  const outcome = outcomes.find((entry) => entry.kind === "research" && entry.action === "replied");
  assert.equal(outcome.runId, runId, "the reply outcome must name the real run id");
  assert.equal(outcome.researchStatus, "completed");
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.replyDelivered, true);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].messageId, "om_0000000000000001");
  assert.match(replies[0].text, /研究完成/);
  assert.ok(replies[0].text.includes(runId));
  assert.match(replies[0].text, /fixture runtime/);
});

test("T3 a partial run is persisted as completed_with_errors and replied as partial", async (t) => {
  const rootDir = await tempRoot(t);
  const { channel, replies, outcomes } = harness({
    rootDir,
    runtimePort: partialPort(),
    toolLayer: fixtureToolLayer({ read: (params) => pageFailed(params.url) }),
  });

  channel.handleEvent(textEvent({ text: "/research partial failure topic" }));
  await channel.whenIdle();

  const runs = await listResearchRuns({ rootDir });
  assert.equal(runs.length, 1);
  const { run } = await readResearchRun(runs[0].runId, { rootDir });
  assert.equal(run.status, "completed_with_errors");
  assert.ok(run.tools.calls.some((call) => call.status === "error"));

  const outcome = outcomes.find((entry) => entry.kind === "research" && entry.action !== "accepted");
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.researchStatus, "completed_with_errors");
  assert.match(replies[0].text, /研究部分完成/);
  assert.equal(replies[0].text.startsWith("研究完成"), false);
  assert.ok(replies[0].text.includes(runs[0].runId));
});

test("T3 /stop cancels the real research run and persists the cancelled terminal state", async (t) => {
  const rootDir = await tempRoot(t);
  const { port, started } = hangingPort();
  const { channel, replies, outcomes } = harness({ rootDir, runtimePort: port });

  channel.handleEvent(textEvent({ eventId: "evt_r", messageId: "om_r", text: "/research slow topic" }));
  await started;

  channel.handleEvent(textEvent({ eventId: "evt_stop", messageId: "om_stop", text: "/stop" }));
  await channel.whenIdle();

  const runs = await listResearchRuns({ rootDir });
  assert.equal(runs.length, 1);
  const { run, report } = await readResearchRun(runs[0].runId, { rootDir });
  assert.equal(run.status, "cancelled");
  assert.equal(run.paths.report, null);
  assert.equal(report, null);
  assert.ok(run.errors.some((error) => error.code === "aborted"));

  assert.deepEqual(replies, [{ messageId: "om_stop", text: "已停止当前任务。" }]);
  const cancelled = outcomes.find((entry) => entry.kind === "research" && entry.action === "cancelled");
  assert.equal(cancelled.runId, runs[0].runId);
  assert.equal(outcomes.some((entry) => entry.status === "succeeded"), false);
});

test("T3 a Feishu reply failure never rewrites the persisted research status", async (t) => {
  const rootDir = await tempRoot(t);
  const { channel, outcomes } = harness({
    rootDir,
    runtimePort: completedPort(),
    reply: async () => {
      throw Object.assign(new Error("feishu send failed"), { code: "reply_failed" });
    },
  });

  channel.handleEvent(textEvent({ text: "/research reply failure topic" }));
  await channel.whenIdle();

  const runs = await listResearchRuns({ rootDir });
  const { run } = await readResearchRun(runs[0].runId, { rootDir });
  assert.equal(run.status, "completed");
  const outcome = outcomes.find((entry) => entry.kind === "research" && entry.action === "replied");
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.replyDelivered, false);
});

test("T3 cross-chat cap: queued chat waits, /stop in one chat releases the other without cancelling it", async (t) => {
  const rootDir = await tempRoot(t);
  let slowStarted;
  const slowStartedPromise = new Promise((resolve) => {
    slowStarted = resolve;
  });
  const port = {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent(spec) {
      if (spec.prompt.includes("slow topic")) {
        slowStarted();
        await new Promise((_resolve, reject) => {
          const abort = () => {
            const error = new Error("client cancelled");
            error.name = "AbortError";
            reject(error);
          };
          if (spec.signal.aborted) abort();
          else spec.signal.addEventListener("abort", abort, { once: true });
        });
      }
      return { status: "completed", text: REPORT_TEXT, usage: usage(), toolCalls: [], error: null };
    },
  };
  const { channel, replies, outcomes } = harness({ rootDir, runtimePort: port, maxConcurrent: 1 });

  channel.handleEvent(textEvent({ eventId: "evt_slow", messageId: "om_slow", chatId: "oc_a", text: "/research slow topic" }));
  await slowStartedPromise;
  channel.handleEvent(textEvent({ eventId: "evt_fast", messageId: "om_fast", chatId: "oc_b", text: "/research fast topic" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(channel.pendingCount > 0, true);

  channel.handleEvent(textEvent({ eventId: "evt_stop", messageId: "om_stop", chatId: "oc_a", text: "/stop" }));
  await channel.whenIdle();

  const runs = await listResearchRuns({ rootDir });
  assert.equal(runs.length, 2);
  const byTopic = new Map(runs.map((run) => [run.request.topic, run]));
  assert.equal(byTopic.get("slow topic").status, "cancelled");
  assert.equal(byTopic.get("fast topic").status, "completed");

  const fastOutcome = outcomes.find((entry) => entry.chatId === "oc_b" && entry.kind === "research" && entry.action === "replied");
  assert.equal(fastOutcome.status, "succeeded");
  assert.match(replies.at(-1).text, /研究完成/);
});
