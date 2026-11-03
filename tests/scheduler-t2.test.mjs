/**
 * T2 contract/persistence behaviour for the scheduler POC (AGT-030).
 *
 * These tests pin the boundary between the scheduler and AGT-028: the executor
 * call contract, persisted schema/reload, lease and dedupe behaviour, failure
 * release, cancellation, timeout and restart recovery. T3 proves the same path
 * with the real executor and real run store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduler,
  createScheduleStore,
  makeDedupeKey,
  SCHEDULER_CONTRACT_VERSION,
  SchedulerError,
  TRIGGER_STATUS,
} from "../src/scheduler/index.mjs";
import { listResearchRuns, readResearchRun } from "../src/research/index.mjs";
import {
  cancellablePort,
  completedPort,
  createFakeClock,
  deferredPort,
  researchDeps,
  scriptedRuntimePort,
  slowPort,
} from "./helpers/scheduler-fixture.mjs";

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "cloud-pi-sched-t2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function baseRequest(extra = {}) {
  return {
    topic: "研究最近 48 小时 AI Agent 工程进展",
    timeRange: "48h",
    ...extra,
  };
}

async function makeScheduler(t, clock, port, extra = {}) {
  const root = await tempRoot(t);
  const stateDir = join(root, "scheduler");
  const runsDir = join(root, "runs");
  const scheduler = await createScheduler({
    stateDir,
    now: clock,
    researchDeps: researchDeps({ rootDir: runsDir, port }),
    ...extra,
  });
  return { root, stateDir, runsDir, scheduler };
}

async function createDaily(scheduler, scheduleId = "daily") {
  return scheduler.createSchedule({
    scheduleId,
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest(),
  });
}

test("T2 persisted definition reloads in a new scheduler instance", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { stateDir, runsDir } = await makeScheduler(t, clock, completedPort());
  const first = await createScheduler({
    stateDir,
    now: clock,
    researchDeps: researchDeps({ rootDir: runsDir, port: completedPort() }),
  });
  await createDaily(first, "reload-daily");
  const second = await createScheduler({
    stateDir,
    now: clock,
    researchDeps: researchDeps({ rootDir: runsDir, port: completedPort() }),
  });
  const loaded = second.getSchedule("reload-daily");
  assert.equal(loaded.nextRunAt, "2026-11-03T01:00:00.000Z");
  assert.equal(loaded.timezone, "Asia/Shanghai");
  assert.equal(loaded.activeTrigger, null);
  assert.equal(loaded.contractVersion, SCHEDULER_CONTRACT_VERSION);

  const raw = JSON.parse(await readFile(join(stateDir, "schedules", "reload-daily.json"), "utf8"));
  assert.equal(raw.scheduleId, "reload-daily");
  assert.equal(raw.request.topic, baseRequest().topic);
});

test("T2 a corrupt schedule file fails the load instead of being dropped", async (t) => {
  const root = await tempRoot(t);
  const stateDir = join(root, "scheduler");
  await import("node:fs/promises").then((fs) => fs.mkdir(join(stateDir, "schedules"), { recursive: true }));
  await writeFile(join(stateDir, "schedules", "broken.json"), "{not-json", "utf8");
  await assert.rejects(createScheduler({ stateDir }), (error) => {
    assert.ok(error instanceof SchedulerError);
    assert.equal(error.code, "parse_error");
    return true;
  });
});

test("T2 lease: an active trigger blocks a second tick and run-now until it finishes", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { port, started, finish } = deferredPort();
  let runs = 0;
  const runPort = scriptedRuntimePort(async (spec) => {
    runs += 1;
    return port.runAgent(spec);
  });
  const { scheduler } = await makeScheduler(t, clock, runPort);
  await createDaily(scheduler, "lease-daily");
  clock.set("2026-11-03T01:00:00Z");

  const tickPromise = scheduler.tick();
  await started;
  const active = scheduler.getSchedule("lease-daily");
  assert.ok(active.activeTrigger);
  assert.ok("runId" in active.activeTrigger);

  const second = await scheduler.tick();
  assert.equal(second.triggered.length, 0, "a second tick must not start a parallel run");
  await assert.rejects(scheduler.runNow("lease-daily"), (error) => {
    assert.equal(error.code, "scheduler_busy");
    return true;
  });

  finish("completed");
  await tickPromise;
  const finished = scheduler.getSchedule("lease-daily");
  assert.equal(finished.activeTrigger, null);
  assert.equal(finished.lastRun.status, TRIGGER_STATUS.SUCCEEDED);
  assert.equal(runs, 1);
});

test("T2 duplicate persisted callback is skipped by its stable dedupe key", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  let runs = 0;
  const { root, stateDir, runsDir, scheduler } = await makeScheduler(
    t,
    clock,
    completedPort({ onRun: () => (runs += 1) }),
  );
  await createDaily(scheduler, "duplicate-callback");
  const store = createScheduleStore({ stateDir });
  const record = await store.read("duplicate-callback");
  record.triggers.push({
    dedupeKey: makeDedupeKey("duplicate-callback", "2026-11-03T01:00:00.000Z"),
    scheduledFor: "2026-11-03T01:00:00.000Z",
    triggerAt: "2026-11-03T01:00:00.000Z",
    claimedAt: "2026-11-03T01:00:00.000Z",
    runId: null,
    status: TRIGGER_STATUS.SUCCEEDED,
    researchStatus: "completed",
    manual: false,
    catchUp: false,
    missedCount: 0,
    missedThrough: null,
    capped: false,
    lateByMs: 0,
    finishedAt: "2026-11-03T01:00:01.000Z",
    durationMs: 1000,
    error: null,
  });
  await store.write(record);

  const restarted = await createScheduler({
    stateDir,
    now: clock,
    researchDeps: researchDeps({ rootDir: runsDir, port: completedPort({ onRun: () => (runs += 1) }) }),
  });
  clock.set("2026-11-03T01:00:02Z");
  await restarted.tick();
  assert.equal(runs, 0, "the already-claimed occurrence must not start a second run");
  const after = restarted.getSchedule("duplicate-callback");
  assert.equal(after.stats.duplicatesSkipped, 1);
  assert.equal(after.nextRunAt, "2026-11-04T01:00:00.000Z");
  assert.equal(after.triggers.length, 1);
  assert.equal(after.activeTrigger, null);
  assert.ok(root);
});

test("T2 a failed research run releases the lease and the next occurrence still runs", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  let calls = 0;
  const port = scriptedRuntimePort(async () => {
    calls += 1;
    const ok = calls > 1;
    return {
      status: ok ? "completed" : "failed",
      text: ok ? "## 摘要\n\n第二次执行成功，报告正文足够长。" : "",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelId: "fixture", providerId: "fixture", source: "provider" },
      toolCalls: [],
      error: ok ? null : { code: "model_error", message: "fixture first run failed" },
    };
  });
  const { scheduler } = await makeScheduler(t, clock, port);
  await createDaily(scheduler, "failure-release");

  clock.set("2026-11-03T01:00:00Z");
  await scheduler.tick();
  const first = scheduler.getSchedule("failure-release");
  assert.equal(first.lastRun.status, TRIGGER_STATUS.FAILED);
  assert.equal(first.lastRun.researchStatus, "failed");
  assert.equal(first.activeTrigger, null);

  clock.set("2026-11-04T01:00:00Z");
  await scheduler.tick();
  const second = scheduler.getSchedule("failure-release");
  assert.equal(second.lastRun.status, TRIGGER_STATUS.SUCCEEDED);
  assert.equal(second.activeTrigger, null);
  assert.equal(second.stats.failed, 1);
  assert.equal(second.stats.succeeded, 1);
  assert.equal(second.triggers.length, 2);
});

test("T2 completed_with_errors is recorded as partial, never as a clean success", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const port = scriptedRuntimePort(async () => ({
    status: "completed",
    text: "## 摘要\n\n报告正文足够长，但引用了一个不存在的来源 [S9]。",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelId: "fixture", providerId: "fixture", source: "provider" },
    toolCalls: [],
    error: null,
  }));
  const { scheduler } = await makeScheduler(t, clock, port);
  await createDaily(scheduler, "partial-run");
  clock.set("2026-11-03T01:00:00Z");
  await scheduler.tick();
  const schedule = scheduler.getSchedule("partial-run");
  assert.equal(schedule.lastRun.researchStatus, "completed_with_errors");
  assert.equal(schedule.lastRun.status, TRIGGER_STATUS.PARTIAL);
  assert.equal(schedule.stats.partial, 1);
  assert.equal(schedule.stats.succeeded, 0);
});

test("T2 cancellation aborts the executor signal and releases the lease", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { port, started } = cancellablePort();
  const { scheduler } = await makeScheduler(t, clock, port);
  await createDaily(scheduler, "cancel-daily");
  clock.set("2026-11-03T01:00:00Z");

  const tickPromise = scheduler.tick();
  await started;
  assert.equal(scheduler.cancel("cancel-daily", "test cancellation"), true);
  await tickPromise;
  const schedule = scheduler.getSchedule("cancel-daily");
  assert.equal(schedule.lastRun.status, TRIGGER_STATUS.CANCELLED);
  assert.equal(schedule.lastRun.researchStatus, "cancelled");
  assert.equal(schedule.activeTrigger, null);
  assert.equal(scheduler.cancel("cancel-daily"), false);
});

test("T2 timeout comes from the executor deadline and releases the lease", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { scheduler } = await makeScheduler(t, clock, slowPort({ delayMs: 80 }));
  await scheduler.createSchedule({
    scheduleId: "timeout-daily",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest({ limits: { maxRuntimeMs: 20 } }),
  });
  clock.set("2026-11-03T01:00:00Z");
  await scheduler.tick();
  const schedule = scheduler.getSchedule("timeout-daily");
  assert.equal(schedule.lastRun.status, TRIGGER_STATUS.TIMEOUT);
  assert.equal(schedule.lastRun.researchStatus, "timeout");
  assert.equal(schedule.activeTrigger, null);
  assert.equal(schedule.stats.timeout, 1);
});

test("T2 executor contract: request, signal and injected clock are forwarded", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const calls = [];
  const startResearchFn = async (request, deps) => {
    calls.push({ request, deps });
    return {
      runId: "r-20261103T010000-abc123",
      done: Promise.resolve({
        runId: "r-20261103T010000-abc123",
        status: "completed",
        errors: [],
      }),
    };
  };
  const root = await tempRoot(t);
  const stateDir = join(root, "scheduler");
  const scheduler = await createScheduler({
    stateDir,
    now: clock,
    researchDeps: { rootDir: join(root, "runs"), env: {} },
    startResearchFn,
  });
  await createDaily(scheduler, "contract-daily");
  clock.set("2026-11-03T01:00:00Z");
  await scheduler.tick();

  assert.equal(calls.length, 1);
  const [{ request, deps }] = calls;
  assert.equal(request.topic, baseRequest().topic);
  assert.equal(request.timeRange, "48h");
  assert.ok(deps.signal instanceof AbortSignal);
  assert.equal(deps.signal.aborted, false);
  assert.equal(typeof deps.now, "function");
  assert.equal(deps.now().toISOString(), "2026-11-03T01:00:00.000Z");
  assert.equal(deps.rootDir, join(root, "runs"));
  const schedule = scheduler.getSchedule("contract-daily");
  assert.equal(schedule.lastRun.status, TRIGGER_STATUS.SUCCEEDED);
});

test("T2 restart recovery adopts a terminal run and clears a stale lease", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  let runs = 0;
  const port = completedPort({ onRun: () => (runs += 1) });
  const { stateDir, runsDir, scheduler } = await makeScheduler(t, clock, port);
  await createDaily(scheduler, "recover-terminal");
  clock.set("2026-11-03T01:00:00Z");
  await scheduler.tick();
  const completed = scheduler.getSchedule("recover-terminal");
  const runId = completed.lastRun.runId;
  assert.equal(runs, 1);

  // Simulate a crash after `startResearch` persisted the run but before the
  // scheduler wrote the terminal transition: put the lease back and reset stats.
  const store = createScheduleStore({ stateDir });
  const record = await store.read("recover-terminal");
  record.stats.succeeded = 0;
  record.activeTrigger = {
    dedupeKey: record.lastRun.dedupeKey,
    scheduledFor: record.lastRun.scheduledFor,
    claimedAt: record.lastRun.startedAt,
    runId,
  };
  record.triggers[record.triggers.length - 1].status = TRIGGER_STATUS.STARTED;
  record.triggers[record.triggers.length - 1].finishedAt = null;
  record.lastRun = null;
  await store.write(record);

  const restarted = await createScheduler({
    stateDir,
    now: clock,
    researchDeps: researchDeps({ rootDir: runsDir, port: completedPort({ onRun: () => (runs += 1) }) }),
  });
  clock.set("2026-11-03T01:05:00Z");
  await restarted.start({ tickIntervalMs: 60_000 });
  await restarted.settle();
  await restarted.stop({ abortActive: true });

  const recovered = restarted.getSchedule("recover-terminal");
  assert.equal(recovered.activeTrigger, null);
  assert.equal(recovered.lastRun.status, TRIGGER_STATUS.SUCCEEDED);
  assert.equal(recovered.triggers[recovered.triggers.length - 1].recovery, true);
  assert.equal(recovered.stats.succeeded, 1);
  assert.equal(runs, 1, "recovery must not start a replacement run");
  assert.equal((await listResearchRuns({ rootDir: runsDir })).length, 1);
  const { run } = await readResearchRun(runId, { rootDir: runsDir });
  assert.equal(run.status, "completed");
});

test("T2 restart recovery marks an unreadable active run as interrupted without retrying", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  let runs = 0;
  const { stateDir, runsDir, scheduler } = await makeScheduler(
    t,
    clock,
    completedPort({ onRun: () => (runs += 1) }),
  );
  await createDaily(scheduler, "recover-orphan");
  const store = createScheduleStore({ stateDir });
  const record = await store.read("recover-orphan");
  record.activeTrigger = {
    dedupeKey: makeDedupeKey("recover-orphan", "2026-11-03T01:00:00.000Z"),
    scheduledFor: "2026-11-03T01:00:00.000Z",
    claimedAt: "2026-11-03T01:00:00.000Z",
    runId: "r-20261103T010000-aaaaaa",
  };
  record.triggers.push({
    dedupeKey: record.activeTrigger.dedupeKey,
    scheduledFor: record.activeTrigger.scheduledFor,
    triggerAt: record.activeTrigger.claimedAt,
    claimedAt: record.activeTrigger.claimedAt,
    runId: record.activeTrigger.runId,
    status: TRIGGER_STATUS.STARTED,
    researchStatus: null,
    manual: false,
    catchUp: false,
    missedCount: 0,
    missedThrough: null,
    capped: false,
    lateByMs: 0,
    finishedAt: null,
    durationMs: null,
    error: null,
  });
  // The claim had already advanced the schedule before the simulated crash.
  record.nextRunAt = "2026-11-04T01:00:00.000Z";
  await store.write(record);

  const restarted = await createScheduler({
    stateDir,
    now: clock,
    researchDeps: researchDeps({ rootDir: runsDir, port: completedPort({ onRun: () => (runs += 1) }) }),
  });
  clock.set("2026-11-03T01:05:00Z");
  await restarted.start({ tickIntervalMs: 60_000 });
  await restarted.settle();
  await restarted.stop({ abortActive: true });

  const recovered = restarted.getSchedule("recover-orphan");
  assert.equal(recovered.activeTrigger, null);
  assert.equal(recovered.lastRun.status, TRIGGER_STATUS.INTERRUPTED);
  assert.equal(recovered.triggers[recovered.triggers.length - 1].status, TRIGGER_STATUS.INTERRUPTED);
  assert.equal(recovered.stats.interrupted, 1);
  assert.equal(runs, 0);
  assert.equal((await listResearchRuns({ rootDir: runsDir })).length, 0);
});

test("T2 an explicit startResearch call in recovery never runs the executor itself", async (t) => {
  // Guards the boundary: recovery only reads the run store. A scheduler with no
  // researchDeps can still start and recover an orphaned lease.
  const root = await tempRoot(t);
  const stateDir = join(root, "scheduler");
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const seed = await createScheduler({ stateDir, now: clock });
  await seed.createSchedule({
    scheduleId: "no-runtime",
    kind: "once",
    timezone: "Asia/Shanghai",
    at: "2026-11-05T09:00",
    request: baseRequest(),
  });
  const store = createScheduleStore({ stateDir });
  const record = await store.read("no-runtime");
  record.activeTrigger = {
    dedupeKey: makeDedupeKey("no-runtime", "2026-11-05T01:00:00.000Z"),
    scheduledFor: "2026-11-05T01:00:00.000Z",
    claimedAt: "2026-11-05T01:00:00.000Z",
    runId: null,
  };
  await store.write(record);

  const restarted = await createScheduler({ stateDir, now: clock });
  clock.set("2026-11-06T02:00:00Z");
  await restarted.start({ tickIntervalMs: 60_000 });
  await restarted.settle();
  await restarted.stop({ abortActive: true });
  const recovered = restarted.getSchedule("no-runtime");
  assert.equal(recovered.activeTrigger, null);
  assert.equal(recovered.lastRun.status, TRIGGER_STATUS.INTERRUPTED);
  // The once occurrence was claimed before the crash, so it is not fired again.
  assert.equal(recovered.status, "completed");
});

test("T2 load() is idle-only: refused while a run is active, usable after it finishes", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const deferred = deferredPort();
  const completed = completedPort();
  let calls = 0;
  const port = scriptedRuntimePort((spec) => {
    calls += 1;
    return calls === 1 ? deferred.port.runAgent(spec) : completed.runAgent(spec);
  });
  const { scheduler } = await makeScheduler(t, clock, port);
  await createDaily(scheduler, "reload-idle-daily");
  clock.set("2026-11-03T01:00:00Z");

  const tickPromise = scheduler.tick();
  await deferred.started;

  await assert.rejects(scheduler.load(), (error) => {
    assert.ok(error instanceof SchedulerError);
    assert.equal(error.code, "scheduler_busy");
    return true;
  });
  // The live map still owns the lease the running execution will release.
  assert.ok(scheduler.getSchedule("reload-idle-daily").activeTrigger);

  deferred.finish("completed");
  await tickPromise;

  await scheduler.load();
  const reloaded = scheduler.getSchedule("reload-idle-daily");
  assert.equal(reloaded.activeTrigger, null);
  assert.equal(reloaded.lastRun.status, TRIGGER_STATUS.SUCCEEDED);
  assert.equal(reloaded.nextRunAt, "2026-11-04T01:00:00.000Z");

  // The reloaded instance is not stuck: the next occurrence still fires.
  clock.set("2026-11-04T01:00:00Z");
  const next = await scheduler.tick();
  assert.equal(next.triggered.length, 1);
  assert.equal(next.triggered[0].status, TRIGGER_STATUS.SUCCEEDED);
  assert.equal(calls, 2);
});

test("T2 load() is refused while the tick loop runs and allowed after stop", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { scheduler } = await makeScheduler(t, clock, completedPort());
  await createDaily(scheduler, "reload-running-daily");
  await scheduler.start({ tickIntervalMs: 60_000 });
  t.after(() => scheduler.stop({ abortActive: false }));

  await assert.rejects(scheduler.load(), (error) => {
    assert.ok(error instanceof SchedulerError);
    assert.equal(error.code, "scheduler_busy");
    return true;
  });

  await scheduler.stop({ abortActive: false });
  await scheduler.load();
  assert.equal(scheduler.getSchedule("reload-running-daily").activeTrigger, null);
});
