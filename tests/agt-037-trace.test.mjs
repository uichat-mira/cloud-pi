/**
 * AGT-037 T3/T4: one `runId` spans channel run 鈫?run store 鈫?schedule trigger 鈫? * delivery record, and the loopback management API resolves the same run.
 *
 * The external platform boundary (Feishu send, model call) is faked; the run
 * store, the scheduler, the delivery store/coordinator and the API are real.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManagementApi } from "../src/api/server.mjs";
import { createDeliveringScheduler } from "../src/delivery/index.mjs";
import { readResearchRun } from "../src/research/index.mjs";
import { assertRunShape, createRunStore } from "../src/research/run-store.mjs";
import { createChatRunRecorder, toChatRunRecord } from "../src/runs/chat-runs.mjs";
import { completedPort, createFakeClock, researchDeps } from "./helpers/scheduler-fixture.mjs";

const PERSONAL_TARGET = Object.freeze([{ type: "open_id", id: "ou_personal1", label: "owner" }]);

async function tempDir(t, prefix = "cloud-agent-trace-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("chat runs: the record reuses the run-store schema and stores no content", () => {
  const outcome = {
    action: "replied",
    status: "succeeded",
    runId: "r-20261104T010000-abcdef",
    durationMs: 1234,
    chatType: "single",
    chatId: "dj-fixture-user",
    replyDelivered: true,
    segments: 2,
    segmentsDelivered: 2,
    usage: { input: 11, output: 22, total: 33 },
  };
  const record = toChatRunRecord({ outcome, channel: "wecom", now: () => new Date("2026-11-04T01:00:00Z") });
  assert.doesNotThrow(() => assertRunShape(record, { expectRunId: outcome.runId }));
  assert.equal(record.status, "completed");
  assert.equal(record.request.topic, "chat message");
  assert.equal(record.request.channel, "wecom");
  assert.deepEqual(record.usage, { inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  assert.equal(record.reply.delivered, true);
  assert.equal(record.durationMs, 1234);
  // No message body, sender id or raw chat id anywhere in the record.
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("hello"), false);
  // The channel outcome carries the platform's raw id; only its hash may persist.
  assert.match(record.chatIdMasked, /^id:[0-9a-f]+$/);
  assert.equal(record.chatIdMasked.includes("fixture"), false, "a raw chat id must never reach the run store");

  // A run id the store cannot address is refused rather than re-keyed.
  assert.equal(toChatRunRecord({ outcome: { ...outcome, runId: "not-a-run-id" }, channel: "wecom" }), null);
  assert.equal(toChatRunRecord({ outcome: { ...outcome, runId: undefined }, channel: "feishu" }), null);
});

test("chat runs: a recorded turn is readable from the same run store by id", async (t) => {
  const root = await tempDir(t);
  const recorder = createChatRunRecorder({ rootDir: root, env: {} });
  const runId = await recorder.record(
    {
      action: "replied",
      status: "succeeded",
      runId: "r-20261104T010000-bbbbbb",
      durationMs: 10,
      chatType: "group",
      chatId: "id:aaaaaa",
      usage: { input: 1, output: 2, total: 3 },
    },
    { channel: "wecom" },
  );
  assert.equal(runId, "r-20261104T010000-bbbbbb");
  const { run, report } = await readResearchRun(runId, { rootDir: root });
  assert.equal(run.runId, runId);
  assert.equal(run.channel, "wecom");
  assert.equal(run.status, "completed");
  assert.equal(report, null, "a chat run has no report artifact");

  // A store failure never throws into the channel.
  const failing = createChatRunRecorder({
    rootDir: root,
    env: {},
    store: {
      async createRun() {
        throw new Error("disk full");
      },
    },
  });
  assert.equal(
    await failing.record({ runId: "r-20261104T010000-cccccc", status: "succeeded" }, { channel: "feishu" }),
    null,
  );
});

test("trace: schedule trigger 鈫?run 鈫?delivery all carry one runId and the API reads it back", async (t) => {
  const root = await tempDir(t);
  const runsDir = join(root, "runs");
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const sends = [];
  const delivering = await createDeliveringScheduler({
    schedulerOptions: {
      stateDir: join(root, "scheduler"),
      now: clock,
      researchDeps: researchDeps({ rootDir: runsDir, port: completedPort() }),
    },
    delivery: {
      stateDir: join(root, "delivery"),
      env: {},
      now: clock,
      researchRunsDir: runsDir,
      sendMessage: async (request) => {
        sends.push(request);
        return { messageId: `om_${sends.length}` };
      },
      limits: { retryDelayMs: 0 },
    },
  });
  const api = createManagementApi({
    deliveringScheduler: delivering,
    runsDir,
    env: {},
    port: 0,
    shutdownTimeoutMs: 500,
  });
  const address = await api.start();
  t.after(async () => {
    await api.stop();
    await delivering.scheduler.stop();
  });

  await delivering.scheduler.createSchedule({
    scheduleId: "trace-daily",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: { topic: "research the last 24 hours of AI Agent engineering", timeRange: "24h" },
    deliveryTargets: PERSONAL_TARGET,
  });
  clock.set("2026-11-03T01:00:00Z");
  const { triggered } = await delivering.scheduler.tick();
  assert.equal(triggered.length, 1);
  const runId = triggered[0].runId;
  assert.match(runId, /^r-\d{8}T\d{6}-[0-9a-f]{6}$/);
  assert.equal(triggered[0].dedupeKey, `trace-daily@${triggered[0].scheduledFor}`);

  const base = address.url; // already includes the /v1 prefix
  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.json() };
  };

  const health = await get("/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const runView = await get(`/runs/${runId}`);
  assert.equal(runView.status, 200);
  assert.equal(runView.body.data.run.runId, runId);

  // The chat facts are part of the same projection (AGT-037): without them the
  // runId would be readable but the record would not prove it was a chat turn.
  const chatRecord = await (async () => {
    const recorder = createChatRunRecorder({ rootDir: runsDir, env: {} });
    const id = await recorder.record(
      {
        status: "succeeded",
        runId: "r-20261103T010500-abcdef",
        durationMs: 7,
        chatType: "single",
        chatId: "djtest-user",
        replyDelivered: true,
        segments: 1,
        segmentsDelivered: 1,
        usage: { input: 2, output: 3, total: 5 },
      },
      { channel: "wecom" },
    );
    assert.equal(id, "r-20261103T010500-abcdef");
    const view = await get(`/runs/${id}`);
    return { status: view.status, run: view.body?.data?.run };
  })();
  assert.equal(chatRecord.status, 200);
  assert.equal(chatRecord.run.chat.channel, "wecom");
  assert.equal(chatRecord.run.chat.chatType, "single");
  assert.equal(chatRecord.run.chat.reply.delivered, true);
  assert.deepEqual(chatRecord.run.chat.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  assert.match(chatRecord.run.chat.chatIdMasked, /^id:[0-9a-f]+$/);
  assert.equal(JSON.stringify(chatRecord.run).includes("djtest-user"), false);
  // A research run keeps `chat: null`: the projection is additive, not a rewrite.
  assert.equal(runView.body.data.run.chat, null);

  const scheduleView = await get("/schedules/trace-daily");
  assert.equal(scheduleView.status, 200);
  const triggerRunIds = (scheduleView.body.data.schedule.recentTriggers ?? []).map((trigger) => trigger.runId);
  assert.ok(triggerRunIds.includes(runId), "the schedule trigger references the same runId");
  assert.equal(scheduleView.body.data.schedule.lastRun.runId, runId, "lastRun carries the same runId");

  const deliveryView = await get(`/runs/${runId}/delivery`);
  assert.equal(deliveryView.status, 200);
  assert.equal(deliveryView.body.data.delivery.runId, runId);
  assert.equal(deliveryView.body.data.delivery.targets[0].status, "sent");

  // The run store is the same source the API reads: one record, one runId.
  const { run } = await readResearchRun(runId, { rootDir: runsDir });
  assert.equal(run.runId, runId);
  assert.equal(sends.length, 1);

  // Replaying the same terminal trigger must not send a second message.
  await delivering.deliverTrigger(triggered[0]);
  await delivering.deliverTrigger(triggered[0]);
  assert.equal(sends.length, 1, "duplicate terminal callbacks stay idempotent");

  // A second tick at the same instant fires nothing: the occurrence is consumed.
  const second = await delivering.scheduler.tick();
  assert.equal(second.triggered.length, 0);
  assert.equal(sends.length, 1);
});

test("trace: chat runs and scheduled runs live in the same store", async (t) => {
  const root = await tempDir(t);
  const store = createRunStore({ rootDir: root, env: {} });
  const recorder = createChatRunRecorder({ rootDir: root, env: {}, store });
  const chatRunId = await recorder.record(
    { status: "succeeded", runId: "r-20261104T020000-aaaaaa", durationMs: 5, chatType: "single" },
    { channel: "wecom" },
  );
  const { run } = await readResearchRun(chatRunId, { rootDir: root });
  assert.equal(run.runId, chatRunId);
  assert.equal(run.channel, "wecom");
  assert.equal(run.status, "completed");
});
