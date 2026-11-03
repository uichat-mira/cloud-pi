/**
 * T3: complete local HTTP chain against the real Scheduler and real Research
 * run store (only the model/network boundary is a deterministic fixture).
 *
 * create → run-now → read run/report → pause/enable/update → process restart →
 * delete, all through the actual listening loopback server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { baseRequest, startApiHarness, tempRoot } from "./agt-034-helpers.mjs";
import { completedPort, createFakeClock } from "./helpers/scheduler-fixture.mjs";

test("T3 full local chain: create → run-now → run/report → pause/enable → restart → delete", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const root = await tempRoot(t, "cloud-pi-agt-034-t3-");
  const harness = await startApiHarness(t, { clock, port: completedPort(), root });

  assert.equal(harness.address.host, "127.0.0.1");
  assert.equal(harness.address.family, "IPv4");
  assert.ok(harness.address.port > 0);
  assert.match(harness.address.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);

  const created = await harness.request("POST", "/v1/schedules", {
    scheduleId: "t3-daily",
    name: "T3 每日研究",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest({ timeRange: "7d" }),
  });
  assert.equal(created.status, 201);
  const scheduleId = created.body.data.schedule.scheduleId;
  assert.equal(scheduleId, "t3-daily");

  const listed = await harness.request("GET", "/v1/schedules");
  assert.equal(listed.body.data.count, 1);
  assert.equal(listed.body.data.schedules[0].name, "T3 每日研究");

  const runNow = await harness.request("POST", `/v1/schedules/${scheduleId}/run-now`);
  assert.equal(runNow.status, 200);
  const trigger = runNow.body.data.trigger;
  assert.equal(trigger.status, "succeeded");
  assert.equal(trigger.researchStatus, "completed");
  const runId = trigger.runId;
  assert.match(runId, /^r-\d{8}T\d{6}-[0-9a-f]{6}$/);

  const runDetail = await harness.request("GET", `/v1/runs/${runId}`);
  assert.equal(runDetail.status, 200);
  assert.equal(runDetail.body.data.run.status, "completed");
  assert.equal(runDetail.body.data.run.request.topic, baseRequest().topic);

  const report = await harness.request("GET", `/v1/runs/${runId}/report`);
  assert.equal(report.status, 200);
  assert.match(report.body.data.report.report, /## 摘要/);
  assert.ok(report.body.data.report.reportChars > 100);

  const paused = await harness.request("POST", `/v1/schedules/${scheduleId}/pause`);
  assert.equal(paused.body.data.schedule.status, "paused");
  assert.equal(harness.scheduler.getSchedule(scheduleId).status, "paused");

  const enabled = await harness.request("POST", `/v1/schedules/${scheduleId}/enable`);
  assert.equal(enabled.body.data.schedule.status, "active");
  assert.equal(harness.scheduler.getSchedule(scheduleId).status, "active");

  const updated = await harness.request("PATCH", `/v1/schedules/${scheduleId}`, {
    name: "T3 每日研究（更新）",
    request: baseRequest({ timeRange: "24h" }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.schedule.name, "T3 每日研究（更新）");
  assert.equal(updated.body.data.schedule.request.timeRange, "24h");
  assert.equal(harness.scheduler.getSchedule(scheduleId).request.timeRange, "24h");

  const beforeRestart = await harness.request("GET", `/v1/schedules/${scheduleId}`);
  const before = beforeRestart.body.data.schedule;
  await harness.stop();

  const restarted = await startApiHarness(t, {
    clock,
    port: completedPort(),
    root,
    stateDir: harness.stateDir,
    runsDir: harness.runsDir,
  });
  const afterRestart = await restarted.request("GET", `/v1/schedules/${scheduleId}`);
  assert.equal(afterRestart.status, 200);
  const after = afterRestart.body.data.schedule;
  assert.equal(after.scheduleId, scheduleId);
  assert.equal(after.name, before.name);
  assert.equal(after.nextRunAt, before.nextRunAt);
  assert.equal(after.lastRun.runId, runId);
  assert.equal(after.triggerCount, 1);

  const persistedRun = await restarted.request("GET", `/v1/runs/${runId}/report`);
  assert.equal(persistedRun.status, 200);
  assert.equal(persistedRun.body.data.report.runId, runId);
  assert.match(persistedRun.body.data.report.report, /## 摘要/);

  const deleted = await restarted.request("DELETE", `/v1/schedules/${scheduleId}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.data.deleted, true);
  assert.equal((await restarted.request("GET", `/v1/schedules/${scheduleId}`)).status, 404);
  assert.deepEqual(await readdir(join(restarted.stateDir, "schedules")), []);

  // Run history belongs to the research run store and survives schedule
  // deletion; the API still reads it after the plan is gone.
  const remainingRuns = await restarted.request("GET", "/v1/runs");
  assert.equal(remainingRuns.body.data.total, 1);
  assert.equal(remainingRuns.body.data.runs[0].runId, runId);
  const remainingReport = await restarted.request("GET", `/v1/runs/${runId}/report`);
  assert.equal(remainingReport.status, 200);
});
