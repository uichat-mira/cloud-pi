/**
 * T1 unit behaviour for the scheduler POC (AGT-030).
 *
 * Deterministic clock, no network and no model. Covers once/recurring parsing,
 * IANA time zones (including DST edges), next fire time, pause, run-now, stable
 * dedupe keys, the frozen missed-run policy and start/stop of the tick loop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createScheduler,
  makeDedupeKey,
  nextCronOccurrence,
  resolveOnceInstant,
  SchedulerError,
  TRIGGER_STATUS,
} from "../src/scheduler/index.mjs";
import { createFakeClock, completedPort, researchDeps } from "./helpers/scheduler-fixture.mjs";

const execFileAsync = promisify(execFile);
const CHILD = new URL("./helpers/next-run-child.mjs", import.meta.url);

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "cloud-pi-sched-t1-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function baseRequest() {
  return {
    topic: "研究最近 48 小时 AI Agent 工程进展",
    goal: "确认定时触发的确定性",
    timeRange: "48h",
  };
}

async function makeScheduler(t, clock, port, extra = {}) {
  const root = await tempRoot(t);
  const scheduler = await createScheduler({
    stateDir: join(root, "scheduler"),
    now: clock,
    researchDeps: researchDeps({ rootDir: join(root, "runs"), port }),
    ...extra,
  });
  return { root, scheduler };
}

test("T1 once: local wall time is resolved in the schedule IANA timezone", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { scheduler } = await makeScheduler(t, clock, completedPort());
  const schedule = await scheduler.createSchedule({
    scheduleId: "once-ai",
    kind: "once",
    timezone: "Asia/Shanghai",
    at: "2026-11-05T09:00",
    request: baseRequest(),
  });
  assert.equal(schedule.nextRunAt, "2026-11-05T01:00:00.000Z");
  assert.equal(schedule.onceAtUtc, "2026-11-05T01:00:00.000Z");
  assert.equal(schedule.status, "active");

  const loaded = (await scheduler.listSchedules())[0];
  assert.equal(loaded.timezone, "Asia/Shanghai");
  assert.equal(loaded.nextRunAt, "2026-11-05T01:00:00.000Z");
});

test("T1 recurring: cron next fire uses the IANA zone, not the host zone", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { scheduler } = await makeScheduler(t, clock, completedPort());
  const shanghai = await scheduler.createSchedule({
    scheduleId: "daily-shanghai",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest(),
  });
  const utc = await scheduler.createSchedule({
    scheduleId: "daily-utc",
    kind: "recurring",
    timezone: "UTC",
    cron: "0 9 * * *",
    request: baseRequest(),
  });
  assert.equal(shanghai.nextRunAt, "2026-11-03T01:00:00.000Z");
  assert.equal(utc.nextRunAt, "2026-11-03T09:00:00.000Z");
  assert.notEqual(shanghai.nextRunAt, utc.nextRunAt);

  // Exactly on the boundary the next occurrence is strictly in the future.
  const next = nextCronOccurrence("0 9 * * *", "Asia/Shanghai", new Date("2026-11-03T01:00:00Z"));
  assert.equal(next.toISOString(), "2026-11-04T01:00:00.000Z");
});

test("T1 next fire is independent of the process TZ environment", async () => {
  const args = ["tests/helpers/next-run-child.mjs", "0 9 * * *", "Asia/Shanghai", "2026-11-03T00:00:00Z"];
  const [utc, la] = await Promise.all([
    execFileAsync(process.execPath, args, { env: { ...process.env, TZ: "UTC" } }),
    execFileAsync(process.execPath, args, { env: { ...process.env, TZ: "America/Los_Angeles" } }),
  ]);
  assert.equal(utc.stdout.trim(), "2026-11-03T01:00:00.000Z");
  assert.equal(la.stdout.trim(), "2026-11-03T01:00:00.000Z");
});

test("T1 once: DST gap is rejected and ambiguous wall time resolves to the earlier instant", () => {
  assert.throws(
    () => resolveOnceInstant({ at: "2026-03-08T02:30", timezone: "America/New_York" }),
    (error) => error instanceof SchedulerError && /daylight-saving gap/.test(error.message),
  );
  const ambiguous = resolveOnceInstant({ at: "2026-11-01T01:30", timezone: "America/New_York" });
  assert.equal(ambiguous.toISOString(), "2026-11-01T05:30:00.000Z");
});

test("T1 invalid definitions are refused with clear codes", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { scheduler } = await makeScheduler(t, clock, completedPort());
  const invalid = [
    { kind: "once", timezone: "Not/AZone", at: "2026-11-05T09:00" },
    { kind: "recurring", timezone: "Asia/Shanghai", cron: "not a cron" },
    { kind: "once", timezone: "Asia/Shanghai", at: "2026-02-30T09:00" },
    { kind: "once", timezone: "Asia/Shanghai", at: "2026-11-01T09:00" },
    { kind: "recurring", timezone: "Asia/Shanghai", cron: "0 9 * * *", missedRunPolicy: "replay_all" },
  ];
  for (const input of invalid) {
    await assert.rejects(scheduler.createSchedule({ ...input, request: baseRequest() }), (error) => {
      assert.ok(error instanceof SchedulerError);
      assert.equal(error.code, "invalid_request");
      return true;
    });
  }
});

test("T1 pause stops firing; enable records missed occurrences without replaying them", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  let runs = 0;
  const port = completedPort({ onRun: () => (runs += 1) });
  const { scheduler } = await makeScheduler(t, clock, port);
  const created = await scheduler.createSchedule({
    scheduleId: "paused-daily",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest(),
  });
  assert.equal(created.nextRunAt, "2026-11-03T01:00:00.000Z");

  clock.set("2026-11-04T02:00:00Z");
  await scheduler.pause("paused-daily");
  await scheduler.tick();
  assert.equal(runs, 0, "a paused schedule must not trigger");

  // Explicit run-now still works while paused and does not change the schedule.
  const manual = await scheduler.runNow("paused-daily");
  assert.equal(runs, 1);
  assert.equal(manual.manual, true);
  assert.equal(manual.status, TRIGGER_STATUS.SUCCEEDED);
  const paused = scheduler.getSchedule("paused-daily");
  assert.equal(paused.status, "paused");
  assert.equal(paused.nextRunAt, "2026-11-03T01:00:00.000Z");

  // Enabling after a missed window records the skip and recomputes the future.
  const enabled = await scheduler.enable("paused-daily");
  assert.equal(enabled.status, "active");
  assert.equal(enabled.nextRunAt, "2026-11-05T01:00:00.000Z");
  const missed = enabled.triggers.filter((trigger) => trigger.status === TRIGGER_STATUS.MISSED);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].missedCount >= 1, true);
  assert.equal(enabled.stats.missed, 1);
  assert.equal(runs, 1, "pause/enable audit must not start a research run");
});

test("T1 missed-run policy: at most one coalesced catch-up, then advance", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  let runs = 0;
  const port = completedPort({ onRun: () => (runs += 1) });
  const { scheduler } = await makeScheduler(t, clock, port);
  await scheduler.createSchedule({
    scheduleId: "catchup-daily",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest(),
  });

  // Four daily occurrences are in the past: 11-03, 11-04, 11-05, 11-06 09:00.
  clock.set("2026-11-06T02:00:00Z");
  await scheduler.tick();
  assert.equal(runs, 1, "all missed occurrences collapse into one run");
  const schedule = scheduler.getSchedule("catchup-daily");
  const trigger = schedule.triggers.find((entry) => entry.status === TRIGGER_STATUS.SUCCEEDED);
  assert.ok(trigger);
  assert.equal(trigger.catchUp, true);
  assert.equal(trigger.missedCount, 3);
  assert.equal(trigger.scheduledFor, "2026-11-03T01:00:00.000Z");
  assert.equal(schedule.nextRunAt, "2026-11-07T01:00:00.000Z");

  await scheduler.tick();
  assert.equal(runs, 1, "the catch-up must not replay the remaining missed ticks");
});

test("T1 duplicate tick and stable dedupe key start only one run", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  let runs = 0;
  const port = completedPort({ onRun: () => (runs += 1) });
  const { scheduler } = await makeScheduler(t, clock, port);
  await scheduler.createSchedule({
    scheduleId: "dupe-daily",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest(),
  });
  clock.set("2026-11-03T01:00:00Z");

  assert.equal(
    makeDedupeKey("dupe-daily", "2026-11-03T01:00:00.000Z"),
    "dupe-daily@2026-11-03T01:00:00.000Z",
  );
  assert.notEqual(
    makeDedupeKey("dupe-daily", "2026-11-03T01:00:00.000Z"),
    makeDedupeKey("dupe-daily", "2026-11-04T01:00:00.000Z"),
  );

  await Promise.all([scheduler.tick(), scheduler.tick()]);
  assert.equal(runs, 1);
  const schedule = scheduler.getSchedule("dupe-daily");
  assert.equal(schedule.triggers.length, 1);
  assert.equal(schedule.activeTrigger, null);
});

test("T1 once schedule missed while stopped runs once and never repeats", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  let runs = 0;
  const port = completedPort({ onRun: () => (runs += 1) });
  const { scheduler } = await makeScheduler(t, clock, port);
  await scheduler.createSchedule({
    scheduleId: "once-late",
    kind: "once",
    timezone: "Asia/Shanghai",
    at: "2026-11-05T09:00",
    request: baseRequest(),
  });
  clock.set("2026-11-06T02:00:00Z");
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(runs, 1);
  const schedule = scheduler.getSchedule("once-late");
  assert.equal(schedule.status, "completed");
  assert.equal(schedule.nextRunAt, null);
  assert.equal(schedule.lastRun.status, TRIGGER_STATUS.SUCCEEDED);
  assert.equal(schedule.lastRun.scheduledFor, "2026-11-05T01:00:00.000Z");
});

test("T1 start/stop: tick loop fires a due schedule and stops firing after stop", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  let runs = 0;
  const port = completedPort({ onRun: () => (runs += 1) });
  const { scheduler } = await makeScheduler(t, clock, port);
  await scheduler.createSchedule({
    scheduleId: "timer-daily",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest(),
  });
  clock.set("2026-11-03T01:00:00Z");
  await scheduler.start({ tickIntervalMs: 10 });
  await scheduler.settle();
  assert.equal(runs, 1);
  await scheduler.stop({ abortActive: true });

  clock.set("2026-11-04T01:00:00Z");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runs, 1, "stopped scheduler must not fire");
});

test("T1 persisted JSON uses the frozen schema and has no temp files", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { root, scheduler } = await makeScheduler(t, clock, completedPort());
  await scheduler.createSchedule({
    scheduleId: "schema-daily",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest(),
  });
  const raw = await readFile(join(root, "scheduler", "schedules", "schema-daily.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.contractVersion, 1);
  assert.equal(parsed.missedRunPolicy, "coalesce_one");
  assert.equal(parsed.nextRunAt, "2026-11-03T01:00:00.000Z");
  const files = await import("node:fs/promises").then((fs) =>
    fs.readdir(join(root, "scheduler", "schedules")),
  );
  assert.deepEqual(files, ["schema-daily.json"]);
});
