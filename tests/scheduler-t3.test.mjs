/**
 * T3 runtime integration for the scheduler POC (AGT-030).
 *
 * Everything below the model/network boundary is real: the scheduler calls the
 * existing AGT-028 `startResearch()` (the non-blocking public form of
 * `executeResearch()`), the executor writes the run store, and the test reads
 * the result back with `readResearchRun()`. Only the AGT-027 runtime port and
 * the research tool layer are deterministic fixtures, exactly as the Issue
 * allows. `startResearch` itself is never mocked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduler, TRIGGER_STATUS } from "../src/scheduler/index.mjs";
import { listResearchRuns, readResearchRun } from "../src/research/index.mjs";
import {
  completedPort,
  createFakeClock,
  researchDeps,
  scriptedRuntimePort,
} from "./helpers/scheduler-fixture.mjs";

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "cloud-pi-sched-t3-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function request() {
  return {
    topic: "研究最近 48 小时 AI Agent 工程进展",
    goal: "验证 Scheduler → executeResearch → run store → readResearchRun",
    timeRange: "48h",
  };
}

async function setup(t, { clock, port, root, stateDir } = {}) {
  const base = root ?? (await tempRoot(t));
  const schedulerState = stateDir ?? join(base, "scheduler");
  const runsDir = join(base, "runs");
  const scheduler = await createScheduler({
    stateDir: schedulerState,
    now: clock,
    researchDeps: researchDeps({ rootDir: runsDir, port }),
  });
  return { base, stateDir: schedulerState, runsDir, scheduler };
}

async function createDaily(scheduler, scheduleId = "daily-ai") {
  return scheduler.createSchedule({
    scheduleId,
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: request(),
  });
}

test("T3 real due tick: startResearch → run store → readResearchRun", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { runsDir, scheduler } = await setup(t, { clock, port: completedPort() });
  const created = await createDaily(scheduler, "t3-daily");
  assert.equal(created.nextRunAt, "2026-11-03T01:00:00.000Z");
  assert.equal(created.request.topic, request().topic);

  clock.set("2026-11-03T01:00:00Z");
  const result = await scheduler.tick();
  assert.equal(result.triggered.length, 1);
  const trigger = result.triggered[0];
  assert.equal(trigger.status, TRIGGER_STATUS.SUCCEEDED);
  assert.equal(trigger.researchStatus, "completed");

  const runs = await listResearchRuns({ rootDir: runsDir });
  assert.equal(runs.length, 1);
  const runId = runs[0].runId;
  assert.equal(trigger.runId, runId);
  const { run, report, sources } = await readResearchRun(runId, { rootDir: runsDir });
  assert.equal(run.status, "completed");
  assert.equal(run.request.topic, request().topic);
  assert.equal(run.createdAt, "2026-11-03T01:00:00.000Z");
  assert.match(report, /## 摘要/);
  assert.ok(Array.isArray(sources));

  const schedule = scheduler.getSchedule("t3-daily");
  assert.equal(schedule.lastRun.runId, runId);
  assert.equal(schedule.lastRun.status, TRIGGER_STATUS.SUCCEEDED);
  assert.equal(schedule.activeTrigger, null);
  assert.equal(schedule.nextRunAt, "2026-11-04T01:00:00.000Z");
  assert.equal(schedule.triggers[0].dedupeKey, "t3-daily@2026-11-03T01:00:00.000Z");
});

test("T3 paused schedule does not trigger, and run-now still runs once", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { runsDir, scheduler } = await setup(t, { clock, port: completedPort() });
  await createDaily(scheduler, "t3-paused");
  clock.set("2026-11-03T01:00:00Z");
  await scheduler.pause("t3-paused");
  assert.equal((await scheduler.tick()).triggered.length, 0);
  assert.equal((await listResearchRuns({ rootDir: runsDir })).length, 0);

  await scheduler.runNow("t3-paused");
  const runs = await listResearchRuns({ rootDir: runsDir });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "completed");
  const schedule = scheduler.getSchedule("t3-paused");
  assert.equal(schedule.status, "paused");
  assert.equal(schedule.lastRun.status, TRIGGER_STATUS.SUCCEEDED);
});

test("T3 duplicate concurrent ticks start exactly one real research run", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { runsDir, scheduler } = await setup(t, { clock, port: completedPort() });
  await createDaily(scheduler, "t3-dupe");
  clock.set("2026-11-03T01:00:00Z");
  await Promise.all([scheduler.tick(), scheduler.tick()]);
  const runs = await listResearchRuns({ rootDir: runsDir });
  assert.equal(runs.length, 1);
  const schedule = scheduler.getSchedule("t3-dupe");
  assert.equal(schedule.triggers.length, 1);
  assert.equal(schedule.activeTrigger, null);
});

test("T3 restart: a new scheduler process loads the plan and continues", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { base, stateDir, runsDir, scheduler } = await setup(t, { clock, port: completedPort() });
  await createDaily(scheduler, "t3-restart");
  clock.set("2026-11-03T01:00:00Z");
  await scheduler.tick();
  const firstRun = (await listResearchRuns({ rootDir: runsDir }))[0];

  const firstTriggered = clock.iso();
  const firstStop = await scheduler.stop({ abortActive: true });
  assert.equal(firstStop, scheduler);

  const restarted = await createScheduler({
    stateDir,
    now: clock,
    researchDeps: researchDeps({ rootDir: runsDir, port: completedPort() }),
  });
  const loaded = restarted.getSchedule("t3-restart");
  assert.equal(loaded.lastRun.runId, firstRun.runId);
  assert.equal(loaded.nextRunAt, "2026-11-04T01:00:00.000Z");
  assert.equal(loaded.activeTrigger, null);
  assert.equal(loaded.triggers.length, 1);

  clock.set("2026-11-04T01:00:00Z");
  await restarted.start({ tickIntervalMs: 60_000 });
  await restarted.settle();
  await restarted.stop({ abortActive: true });

  const runs = await listResearchRuns({ rootDir: runsDir });
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].runId, firstRun.runId);
  for (const run of runs) {
    assert.equal(run.status, "completed");
    const { report } = await readResearchRun(run.runId, { rootDir: runsDir });
    assert.match(report, /## 摘要/);
  }
  const after = restarted.getSchedule("t3-restart");
  assert.equal(after.triggers.length, 2);
  assert.equal(after.lastRun.status, TRIGGER_STATUS.SUCCEEDED);
  assert.equal(after.nextRunAt, "2026-11-05T01:00:00.000Z");
  assert.ok(Date.parse(firstTriggered) > 0);
  assert.ok(base);
});

test("T3 a failed run is recorded as failed, releases the lease and the next run succeeds", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  let calls = 0;
  const port = scriptedRuntimePort(async () => {
    calls += 1;
    const ok = calls > 1;
    return {
      status: ok ? "completed" : "failed",
      text: ok ? "## 摘要\n\n第二次真实执行成功，报告正文足够长。" : "",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelId: "fixture", providerId: "fixture", source: "provider" },
      toolCalls: [],
      error: ok ? null : { code: "model_error", message: "fixture first run failed" },
    };
  });
  const { runsDir, scheduler } = await setup(t, { clock, port });
  await createDaily(scheduler, "t3-failure");
  clock.set("2026-11-03T01:00:00Z");
  await scheduler.tick();
  let runs = await listResearchRuns({ rootDir: runsDir });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  const first = scheduler.getSchedule("t3-failure");
  assert.equal(first.lastRun.status, TRIGGER_STATUS.FAILED);
  assert.equal(first.activeTrigger, null);

  clock.set("2026-11-04T01:00:00Z");
  await scheduler.tick();
  runs = await listResearchRuns({ rootDir: runsDir });
  assert.equal(runs.length, 2);
  const statuses = runs.map((run) => run.status).sort();
  assert.deepEqual(statuses, ["completed", "failed"]);
  const second = scheduler.getSchedule("t3-failure");
  assert.equal(second.lastRun.status, TRIGGER_STATUS.SUCCEEDED);
  assert.equal(second.stats.failed, 1);
  assert.equal(second.stats.succeeded, 1);
});

test("T3 restart catch-up runs once for a long outage, not once per missed tick", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { base, stateDir, runsDir, scheduler } = await setup(t, { clock, port: completedPort() });
  await createDaily(scheduler, "t3-catchup");
  clock.set("2026-11-03T01:00:00Z");
  await scheduler.tick();
  assert.equal((await listResearchRuns({ rootDir: runsDir })).length, 1);
  await scheduler.stop({ abortActive: true });

  // Three more daily occurrences are missed (11-04, 11-05, 11-06 09:00).
  clock.set("2026-11-06T02:00:00Z");
  const restarted = await createScheduler({
    stateDir,
    now: clock,
    researchDeps: researchDeps({ rootDir: runsDir, port: completedPort() }),
  });
  await restarted.start({ tickIntervalMs: 60_000 });
  await restarted.settle();
  await restarted.stop({ abortActive: true });

  const runs = await listResearchRuns({ rootDir: runsDir });
  assert.equal(runs.length, 2, "exactly one catch-up run");
  const schedule = restarted.getSchedule("t3-catchup");
  const catchUp = schedule.triggers.find((trigger) => trigger.catchUp === true);
  assert.ok(catchUp);
  assert.equal(catchUp.status, TRIGGER_STATUS.SUCCEEDED);
  assert.equal(catchUp.missedCount, 2);
  assert.equal(catchUp.scheduledFor, "2026-11-04T01:00:00.000Z");
  assert.equal(schedule.nextRunAt, "2026-11-07T01:00:00.000Z");
  assert.equal((await listResearchRuns({ rootDir: runsDir })).length, 2);
  assert.ok(base);
});
