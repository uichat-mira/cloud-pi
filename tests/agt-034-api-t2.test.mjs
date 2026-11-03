/**
 * T2: management API → Scheduler / Research contracts.
 *
 * Proves that HTTP create/update/pause/enable/run-now/cancel/delete match
 * direct Scheduler calls, that an in-flight schedule fails closed for
 * update/delete without a stale lease or duplicate trigger, that cancellation
 * reaches the executor, and that a restarted API reads the same persisted state
 * without a second index.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  baseRequest,
  startApiHarness,
  tempRoot,
} from "./agt-034-helpers.mjs";
import {
  cancellablePort,
  completedPort,
  createFakeClock,
  deferredPort,
} from "./helpers/scheduler-fixture.mjs";

function errorOf(response) {
  return response.body?.error;
}

async function createRecurring(harness, scheduleId, extra = {}) {
  return harness.request("POST", "/v1/schedules", {
    scheduleId,
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest(),
    ...extra,
  });
}

test("T2 create/update via HTTP match direct Scheduler state", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const harness = await startApiHarness(t, { clock, port: completedPort() });

  const created = await createRecurring(harness, "api-update-daily");
  assert.equal(created.status, 201);
  const direct = harness.scheduler.getSchedule("api-update-daily");
  assert.equal(created.body.data.schedule.nextRunAt, direct.nextRunAt);
  assert.equal(direct.nextRunAt, "2026-11-03T01:00:00.000Z");

  const updated = await harness.request("PATCH", "/v1/schedules/api-update-daily", {
    name: "每天九点研究",
    timezone: "UTC",
    cron: "30 10 * * *",
    request: baseRequest({ timeRange: "7d", limits: { maxRuntimeMs: 60_000 } }),
  });
  assert.equal(updated.status, 200);
  const after = updated.body.data.schedule;
  assert.equal(after.name, "每天九点研究");
  assert.equal(after.timezone, "UTC");
  assert.equal(after.cron, "30 10 * * *");
  assert.equal(after.request.timeRange, "7d");
  assert.equal(after.request.limits.maxRuntimeMs, 60_000);
  assert.equal(after.nextRunAt, "2026-11-03T10:30:00.000Z");

  const directAfter = harness.scheduler.getSchedule("api-update-daily");
  assert.equal(directAfter.name, after.name);
  assert.equal(directAfter.timezone, "UTC");
  assert.equal(directAfter.nextRunAt, after.nextRunAt);
  assert.equal(directAfter.request.timeRange, "7d");
  assert.equal(directAfter.request.limits.maxRuntimeMs, 60_000);

  // A paused schedule stays paused when only non-timing fields change.
  const paused = await harness.request("POST", "/v1/schedules/api-update-daily/pause");
  assert.equal(paused.body.data.schedule.status, "paused");
  const renamed = await harness.request("PATCH", "/v1/schedules/api-update-daily", { name: "改名" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.schedule.status, "paused");
  assert.equal(renamed.body.data.schedule.nextRunAt, paused.body.data.schedule.nextRunAt);

  const reenabled = await harness.request("POST", "/v1/schedules/api-update-daily/enable");
  assert.equal(reenabled.status, 200);
  assert.equal(reenabled.body.data.schedule.status, "active");
  assert.equal(harness.scheduler.getSchedule("api-update-daily").status, "active");

  // Internal identity/status fields are not writable through the API.
  for (const patch of [
    { scheduleId: "other-id" },
    { status: "paused" },
    { enabled: true },
    { enabled: false },
    { triggers: [] },
    { activeTrigger: { dedupeKey: "forged" } },
    { nextRunAt: "2020-01-01T00:00:00.000Z" },
  ]) {
    const rejected = await harness.request("PATCH", "/v1/schedules/api-update-daily", patch);
    assert.equal(rejected.status, 400);
    assert.equal(errorOf(rejected).code, "invalid_request");
  }
});

test("T2 PATCH cannot activate a paused schedule whose nextRunAt is already due", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const harness = await startApiHarness(t, { clock, port: completedPort() });
  await createRecurring(harness, "pause-update");
  const paused = await harness.request("POST", "/v1/schedules/pause-update/pause");
  assert.equal(paused.status, 200);
  const dueNextRunAt = paused.body.data.schedule.nextRunAt;
  assert.equal(dueNextRunAt, "2026-11-03T01:00:00.000Z");

  // The occurrence becomes due while paused. `enabled` must not become a
  // second activation path that keeps the past nextRunAt or replays the run.
  clock.set("2026-11-03T02:00:00Z");
  for (const patch of [{ enabled: true }, { enabled: false }]) {
    const rejected = await harness.request("PATCH", "/v1/schedules/pause-update", patch);
    assert.equal(rejected.status, 400);
    assert.equal(errorOf(rejected).code, "invalid_request");
    assert.match(errorOf(rejected).message, /unsupported schedule fields/);
  }

  const still = harness.scheduler.getSchedule("pause-update");
  assert.equal(still.status, "paused");
  assert.equal(still.nextRunAt, dueNextRunAt);
  assert.equal(still.stats.triggers, 0);
  assert.equal(still.stats.missed, 0);
  assert.equal(still.triggers.length, 0);

  const tick = await harness.scheduler.tick();
  assert.deepEqual(tick.triggered, []);
  const afterTick = harness.scheduler.getSchedule("pause-update");
  assert.equal(afterTick.status, "paused");
  assert.equal(afterTick.triggers.length, 0);
  assert.equal((await harness.request("GET", "/v1/runs")).body.data.total, 0);

  // The documented lifecycle path records one missed occurrence and recomputes
  // strictly after now; a tick immediately afterwards must not replay it.
  const enabled = await harness.request("POST", "/v1/schedules/pause-update/enable");
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.data.schedule.status, "active");
  assert.ok(Date.parse(enabled.body.data.schedule.nextRunAt) > Date.parse("2026-11-03T02:00:00Z"));
  assert.equal(enabled.body.data.schedule.stats.missed, 1);
  const afterEnableTick = await harness.scheduler.tick();
  assert.deepEqual(afterEnableTick.triggered, []);
  assert.equal((await harness.request("GET", "/v1/runs")).body.data.total, 0);
});

test("T2 scheduleId run filter is explicit beyond maxTriggerHistory", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const harness = await startApiHarness(t, { clock, port: completedPort() });
  await createRecurring(harness, "bounded-daily");

  // Warm the boundary through the real Scheduler/executor/run store; the
  // filter itself is then exercised through HTTP below.
  const runIds = [];
  for (let index = 0; index < 101; index += 1) {
    const trigger = await harness.scheduler.runNow("bounded-daily");
    assert.match(trigger.runId, /^r-/, `run ${index} did not complete`);
    runIds.push(trigger.runId);
  }
  const oldestRunId = runIds[0];
  const newestRunId = runIds.at(-1);

  const schedule = harness.scheduler.getSchedule("bounded-daily");
  assert.equal(schedule.stats.triggers, 101);
  assert.equal(schedule.triggers.length, 100);
  assert.equal(schedule.triggers.some((trigger) => trigger.runId === oldestRunId), false);

  // The unfiltered store keeps all 101 runs; limit truncation is explicit via
  // total (101) vs count (100).
  const all = await harness.request("GET", "/v1/runs?limit=100");
  assert.equal(all.status, 200);
  assert.equal(all.body.data.total, 101);
  assert.equal(all.body.data.count, 100);

  const filtered = await harness.request("GET", "/v1/runs?scheduleId=bounded-daily&limit=100");
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.data.total, 100);
  assert.equal(filtered.body.data.count, 100);
  assert.equal(filtered.body.data.truncated, true);
  assert.equal(filtered.body.data.filterComplete, false);
  assert.deepEqual(filtered.body.data.scheduleFilter, {
    retainedTriggerCount: 100,
    totalTriggerCount: 101,
    omittedTriggerCount: 1,
    truncated: true,
  });
  assert.match(filtered.body.data.filterReason, /bounded_to_retained_trigger_history/);
  assert.equal(filtered.body.data.runs.some((run) => run.runId === oldestRunId), false);
  assert.equal(filtered.body.data.runs.some((run) => run.runId === newestRunId), true);

  // Deleting the schedule must not turn the research-run filter into 404.
  const removed = await harness.request("DELETE", "/v1/schedules/bounded-daily");
  assert.equal(removed.status, 200);
  const afterDelete = await harness.request("GET", "/v1/runs?scheduleId=bounded-daily");
  assert.equal(afterDelete.status, 200);
  assert.equal(afterDelete.body.data.total, 0);
  assert.equal(afterDelete.body.data.scheduleMissing, true);
  assert.equal(afterDelete.body.data.filterComplete, false);
  assert.equal(afterDelete.body.data.truncated, false);
  assert.match(afterDelete.body.data.filterReason, /no_durable_run_link/);

  // History remains a Research fact and is still readable without the filter.
  const remaining = await harness.request("GET", "/v1/runs?limit=100");
  assert.equal(remaining.status, 200);
  assert.equal(remaining.body.data.total, 101);
});

test("T2 update/delete fail closed while the schedule owns an in-flight run", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const deferred = deferredPort();
  const harness = await startApiHarness(t, { clock, port: deferred.port });
  await createRecurring(harness, "lease-daily");

  const runNowRequest = harness.request("POST", "/v1/schedules/lease-daily/run-now");
  await deferred.started;
  assert.ok(harness.scheduler.getSchedule("lease-daily").activeTrigger);

  const update = await harness.request("PATCH", "/v1/schedules/lease-daily", { name: "too late" });
  assert.equal(update.status, 409);
  assert.equal(errorOf(update).code, "conflict");
  assert.match(errorOf(update).message, /active run/);

  // Lifecycle is not patchable at all, even while the schedule owns a lease.
  const lifecycle = await harness.request("PATCH", "/v1/schedules/lease-daily", { enabled: false });
  assert.equal(lifecycle.status, 400);
  assert.equal(errorOf(lifecycle).code, "invalid_request");

  const remove = await harness.request("DELETE", "/v1/schedules/lease-daily");
  assert.equal(remove.status, 409);
  assert.equal(errorOf(remove).code, "conflict");

  // The refused mutations did not touch the lease or append a trigger.
  const during = harness.scheduler.getSchedule("lease-daily");
  assert.equal(during.name, "");
  assert.equal(during.triggers.length, 1);
  assert.equal(during.activeTrigger.dedupeKey, during.triggers[0].dedupeKey);

  deferred.finish("completed");
  const completed = await runNowRequest;
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.trigger.status, "succeeded");
  assert.equal(completed.body.data.schedule.activeTrigger, null);
  const runId = completed.body.data.trigger.runId;
  assert.match(runId, /^r-/);

  const schedule = harness.scheduler.getSchedule("lease-daily");
  assert.equal(schedule.activeTrigger, null);
  assert.equal(schedule.lastRun.runId, runId);
  assert.equal(schedule.triggers.length, 1);
  assert.equal(schedule.stats.triggers, 1);

  const runs = await harness.request("GET", `/v1/runs?scheduleId=lease-daily`);
  assert.equal(runs.status, 200);
  assert.equal(runs.body.data.total, 1);
  assert.equal(runs.body.data.runs[0].runId, runId);
  assert.equal(runs.body.data.runs[0].status, "completed");

  // Once the lease is released, update and delete are allowed again.
  const rename = await harness.request("PATCH", "/v1/schedules/lease-daily", { name: "after run" });
  assert.equal(rename.status, 200);
  const deleted = await harness.request("DELETE", "/v1/schedules/lease-daily");
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.data, { scheduleId: "lease-daily", deleted: true });
  assert.equal((await harness.request("GET", "/v1/schedules/lease-daily")).status, 404);
  const files = await readdir(join(harness.stateDir, "schedules"));
  assert.deepEqual(files, []);

  // Re-creating the id after deletion is clean (no stale file/lease).
  const recreated = await createRecurring(harness, "lease-daily");
  assert.equal(recreated.status, 201);
});

test("T2 run-now is busy while another schedule owns the single run slot", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const deferred = deferredPort();
  const harness = await startApiHarness(t, { clock, port: deferred.port });
  await createRecurring(harness, "slot-a");
  await createRecurring(harness, "slot-b");

  const first = harness.request("POST", "/v1/schedules/slot-a/run-now");
  await deferred.started;
  const second = await harness.request("POST", "/v1/schedules/slot-b/run-now");
  assert.equal(second.status, 503);
  assert.equal(errorOf(second).code, "busy");
  assert.match(errorOf(second).message, /busy/);

  deferred.finish("completed");
  assert.equal((await first).status, 200);
});

test("T2 pause/enable/completed semantics are owned by the Scheduler", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const harness = await startApiHarness(t, { clock, port: completedPort() });
  await createRecurring(harness, "pause-daily");

  const pause = await harness.request("POST", "/v1/schedules/pause-daily/pause");
  assert.equal(pause.status, 200);
  assert.equal(pause.body.data.schedule.status, "paused");
  assert.equal(harness.scheduler.getSchedule("pause-daily").status, "paused");

  clock.advance(2 * 60 * 60 * 1000); // 02:00Z, past the 01:00Z occurrence
  const enable = await harness.request("POST", "/v1/schedules/pause-daily/enable");
  assert.equal(enable.status, 200);
  assert.equal(enable.body.data.schedule.status, "active");
  assert.equal(enable.body.data.schedule.nextRunAt, "2026-11-04T01:00:00.000Z");
  assert.equal(enable.body.data.schedule.stats.missed, 1);
  assert.equal(harness.scheduler.getSchedule("pause-daily").status, "active");

  // A completed one-time schedule cannot be paused; the Scheduler owns that rule.
  const once = await harness.request("POST", "/v1/schedules", {
    scheduleId: "once-completed",
    kind: "once",
    timezone: "Asia/Shanghai",
    at: "2026-11-05T09:00",
    request: baseRequest(),
  });
  assert.equal(once.status, 201);
  const run = await harness.request("POST", "/v1/schedules/once-completed/run-now");
  assert.equal(run.status, 200);
  assert.equal(run.body.data.schedule.status, "completed");
  const conflict = await harness.request("POST", "/v1/schedules/once-completed/pause");
  assert.equal(conflict.status, 409);
  assert.equal(errorOf(conflict).code, "conflict");

  // Updating a completed schedule requires a new future timing.
  const refused = await harness.request("PATCH", "/v1/schedules/once-completed", { name: "rename only" });
  assert.equal(refused.status, 409);
  assert.equal(errorOf(refused).code, "conflict");
  const rescheduled = await harness.request("PATCH", "/v1/schedules/once-completed", {
    at: "2026-11-06T09:00",
  });
  assert.equal(rescheduled.status, 200);
  assert.equal(rescheduled.body.data.schedule.status, "active");
  assert.equal(rescheduled.body.data.schedule.completedAt, null);
  assert.equal(rescheduled.body.data.schedule.nextRunAt, "2026-11-06T01:00:00.000Z");
});

test("T2 cancel reaches the executor, releases the lease and is idempotent-safe", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const { port, started } = cancellablePort();
  const harness = await startApiHarness(t, { clock, port });
  await createRecurring(harness, "cancel-daily");

  const runNowRequest = harness.request("POST", "/v1/schedules/cancel-daily/run-now");
  await started;
  const cancel = await harness.request("POST", "/v1/schedules/cancel-daily/cancel");
  assert.equal(cancel.status, 200);
  assert.deepEqual(cancel.body.data, { scheduleId: "cancel-daily", cancelled: true });

  const runNow = await runNowRequest;
  assert.equal(runNow.status, 200);
  assert.equal(runNow.body.data.trigger.status, "cancelled");
  assert.equal(runNow.body.data.trigger.researchStatus, "cancelled");

  const direct = harness.scheduler.getSchedule("cancel-daily");
  assert.equal(direct.activeTrigger, null);
  assert.equal(direct.lastRun.status, "cancelled");

  const runs = await harness.request("GET", "/v1/runs?scheduleId=cancel-daily");
  assert.equal(runs.body.data.runs[0].status, "cancelled");

  const secondCancel = await harness.request("POST", "/v1/schedules/cancel-daily/cancel");
  assert.equal(secondCancel.status, 409);
  assert.equal(errorOf(secondCancel).code, "conflict");

  const missing = await harness.request("POST", "/v1/schedules/no-such-schedule/cancel");
  assert.equal(missing.status, 404);
});

test("T2 research runs and reports are read through the AGT-028 public API", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const harness = await startApiHarness(t, { clock, port: completedPort() });
  await createRecurring(harness, "read-daily");

  const runNow = await harness.request("POST", "/v1/schedules/read-daily/run-now");
  assert.equal(runNow.status, 200);
  const runId = runNow.body.data.trigger.runId;

  const list = await harness.request("GET", "/v1/runs");
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 1);
  assert.equal(list.body.data.runs[0].runId, runId);
  assert.equal(list.body.data.runs[0].status, "completed");

  const detail = await harness.request("GET", `/v1/runs/${runId}`);
  assert.equal(detail.status, 200);
  const run = detail.body.data.run;
  assert.equal(run.runId, runId);
  assert.equal(run.request.topic, baseRequest().topic);
  assert.equal(run.request.timeRange, "48h");
  assert.equal(run.artifacts.report, true);
  assert.equal(run.artifacts.sources, true);
  assert.ok(!("paths" in run));
  assert.ok(!("transcript" in run));
  assert.ok(!("delivery" in run));
  assert.ok(!("deliveryTargets" in run));

  const report = await harness.request("GET", `/v1/runs/${runId}/report`);
  assert.equal(report.status, 200);
  assert.match(report.body.data.report.report, /## 摘要/);
  assert.ok(report.body.data.report.reportChars > 0);
  assert.ok(Array.isArray(report.body.data.report.sources));
  assert.ok(report.body.data.report.sourcesSummary.total >= 0);
  assert.ok(!("transcript" in report.body.data.report));

  const filtered = await harness.request("GET", "/v1/runs?scheduleId=read-daily&limit=1");
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.data.count, 1);
  assert.equal(filtered.body.data.limit, 1);

  const missingRun = await harness.request("GET", "/v1/runs/r-20261103T000000-abcdef");
  assert.equal(missingRun.status, 404);
  assert.equal(errorOf(missingRun).code, "not_found");
  const missingReport = await harness.request("GET", "/v1/runs/r-20261103T000000-abcdef/report");
  assert.equal(missingReport.status, 404);
  assert.equal(errorOf(missingReport).code, "not_found");

  const runNowMissing = await harness.request("POST", "/v1/schedules/no-such-schedule/run-now");
  assert.equal(runNowMissing.status, 404);
  assert.equal(errorOf(runNowMissing).code, "not_found");

  const invalidRun = await harness.request("GET", "/v1/runs/not-a-run");
  assert.equal(invalidRun.status, 400);
  assert.equal(errorOf(invalidRun).code, "invalid_request");
});

test("T2 a restarted API reads the same persisted state without a second index", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const root = await tempRoot(t);
  const first = await startApiHarness(t, { clock, port: completedPort(), root });
  await createRecurring(first, "restart-daily");
  const runNow = await first.request("POST", "/v1/schedules/restart-daily/run-now");
  const firstRunId = runNow.body.data.trigger.runId;
  const before = await first.request("GET", "/v1/schedules/restart-daily");
  const beforeSchedule = before.body.data.schedule;
  assert.equal(beforeSchedule.triggerCount, 1);
  assert.equal(beforeSchedule.lastRun.runId, firstRunId);

  await first.stop();

  const second = await startApiHarness(t, {
    clock,
    port: completedPort(),
    root,
    stateDir: first.stateDir,
    runsDir: first.runsDir,
  });
  const after = await second.request("GET", "/v1/schedules/restart-daily");
  assert.equal(after.status, 200);
  const afterSchedule = after.body.data.schedule;
  assert.equal(afterSchedule.scheduleId, "restart-daily");
  assert.equal(afterSchedule.nextRunAt, beforeSchedule.nextRunAt);
  assert.equal(afterSchedule.lastRun.runId, firstRunId);
  assert.equal(afterSchedule.triggerCount, 1);

  const runs = await second.request("GET", "/v1/runs?scheduleId=restart-daily");
  assert.equal(runs.body.data.total, 1);
  const report = await second.request("GET", `/v1/runs/${firstRunId}/report`);
  assert.equal(report.status, 200);
  assert.equal(report.body.data.report.runId, firstRunId);

  // The restarted instance triggers a second run without recreating the plan or
  // loading a private index; trigger history comes from the schedule file.
  const secondRun = await second.request("POST", "/v1/schedules/restart-daily/run-now");
  assert.equal(secondRun.status, 200);
  assert.notEqual(secondRun.body.data.trigger.runId, firstRunId);
  const finalSchedule = second.scheduler.getSchedule("restart-daily");
  assert.equal(finalSchedule.triggers.length, 2);
  assert.equal((await second.request("GET", "/v1/runs?scheduleId=restart-daily")).body.data.total, 2);
});
