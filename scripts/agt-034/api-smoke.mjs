#!/usr/bin/env node
/**
 * Reproducible local smoke for the AGT-034 management API.
 *
 * Starts the *real* loopback HTTP server and the *real* Scheduler + AGT-028
 * research executor against a temporary state directory. Only the AGT-027
 * runtime port (model/network boundary) is a deterministic fixture, so this
 * smoke needs no credential, model call, network or `.env` value.
 *
 * Output is JSON Lines so the evidence document can quote it directly. It
 * records the listening loopback address, request/response status codes,
 * schedule id, run id and the before/after state across an API restart. It
 * never records a credential, request body or report content.
 *
 *   npm run api:smoke
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementApi } from "../../src/api/index.mjs";
import { createScheduler } from "../../src/scheduler/index.mjs";
import { completedPort, createFakeClock, researchDeps } from "../../tests/helpers/scheduler-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "cloud-pi-agt-034-smoke-"));
const stateDir = join(root, "scheduler");
const runsDir = join(root, "runs");
const clock = createFakeClock("2026-11-03T00:00:00Z");
const events = [];
let failed = false;

function emit(event) {
  events.push(event);
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(baseUrl, method, path, body) {
  const init = { method, headers: {}, signal: AbortSignal.timeout(15_000) };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json };
}

function logRequest(label, method, path, response) {
  emit({
    event: "request",
    label,
    method,
    path,
    status: response.status,
    code: response.body?.ok === false ? response.body.error.code : undefined,
  });
  return response;
}

let scheduler = null;
let api = null;

try {
  // 1. Bind policy: a non-loopback host is refused before a socket exists.
  let bindRejected = false;
  let bindCode = null;
  try {
    createManagementApi({ scheduler: { listSchedules: () => [] }, host: "0.0.0.0", port: 0 });
  } catch (error) {
    bindRejected = true;
    bindCode = error.code;
  }
  emit({ event: "bind-policy", requestedHost: "0.0.0.0", rejected: bindRejected, code: bindCode });
  check(bindRejected && bindCode === "invalid_request", "0.0.0.0 bind must be refused");

  scheduler = await createScheduler({
    stateDir,
    now: clock,
    researchDeps: researchDeps({ rootDir: runsDir, port: completedPort() }),
  });
  api = createManagementApi({
    scheduler,
    runsDir,
    host: "127.0.0.1",
    port: 0,
    env: {},
    shutdownTimeoutMs: 500,
  });
  const address = await api.start();
  const baseUrl = address.url;
  emit({ event: "listen", host: address.host, family: address.family, port: address.port, url: baseUrl });
  check(address.host === "127.0.0.1" && address.port > 0, "must listen on 127.0.0.1");

  // 2. Health/status.
  const health = logRequest("health", "GET", "/health", await request(baseUrl, "GET", "/health"));
  check(health.status === 200 && health.body.data.apiVersion === "v1", "health must be v1");

  const status = logRequest("status", "GET", "/status", await request(baseUrl, "GET", "/status"));
  check(status.status === 200 && status.body.data.capabilities.deliveryStatus === false, "status must report delivery closure");

  // 3. Create a recurring plan.
  const created = logRequest(
    "create",
    "POST",
    "/schedules",
    await request(baseUrl, "POST", "/schedules", {
      scheduleId: "smoke-daily",
      name: "AGT-034 smoke 定时研究",
      kind: "recurring",
      timezone: "Asia/Shanghai",
      cron: "0 9 * * *",
      request: {
        topic: "研究最近 48 小时 AI Agent 工程进展",
        goal: "本地管理 API smoke",
        timeRange: "48h",
        limits: { maxRuntimeMs: 60_000 },
      },
    }),
  );
  check(created.status === 201, "create must return 201");
  const scheduleId = created.body.data.schedule.scheduleId;
  emit({ event: "schedule", scheduleId, nextRunAt: created.body.data.schedule.nextRunAt, status: created.body.data.schedule.status });
  check(scheduleId === "smoke-daily", "schedule id must round-trip");

  // 4. List/get consistency.
  const list = logRequest("list", "GET", "/schedules", await request(baseUrl, "GET", "/schedules"));
  check(list.status === 200 && list.body.data.count === 1, "list must contain one schedule");
  const detail = logRequest("get", "GET", `/schedules/${scheduleId}`, await request(baseUrl, "GET", `/schedules/${scheduleId}`));
  check(detail.status === 200 && detail.body.data.schedule.scheduleId === scheduleId, "detail must match");

  // 5. Update business fields.
  const updated = logRequest(
    "update",
    "PATCH",
    `/schedules/${scheduleId}`,
    await request(baseUrl, "PATCH", `/schedules/${scheduleId}`, {
      name: "AGT-034 smoke 定时研究（更新）",
      request: { topic: "研究最近 24 小时 AI Agent 工程进展", timeRange: "24h" },
    }),
  );
  check(updated.status === 200 && updated.body.data.schedule.request.timeRange === "24h", "update must apply");

  // 6. Run now. The real executor and run store are used; only the model port
  // and research tool layer are fixtures.
  const runNow = logRequest(
    "run-now",
    "POST",
    `/schedules/${scheduleId}/run-now`,
    await request(baseUrl, "POST", `/schedules/${scheduleId}/run-now`),
  );
  check(runNow.status === 200, "run-now must succeed");
  const trigger = runNow.body.data.trigger;
  const runId = trigger.runId;
  emit({ event: "run-now", scheduleId, triggerStatus: trigger.status, researchStatus: trigger.researchStatus, runId });
  check(trigger.status === "succeeded" && trigger.researchStatus === "completed", "run must complete");
  check(/^r-\d{8}T\d{6}-[0-9a-f]{6}$/.test(runId), "run id must be stable");

  // 7. Read run + report through the API.
  const runs = logRequest("runs", "GET", `/runs?scheduleId=${scheduleId}`, await request(baseUrl, "GET", `/runs?scheduleId=${scheduleId}`));
  check(runs.status === 200 && runs.body.data.total === 1, "run list must contain the run");
  const runDetail = logRequest("run", "GET", `/runs/${runId}`, await request(baseUrl, "GET", `/runs/${runId}`));
  check(runDetail.status === 200 && runDetail.body.data.run.status === "completed", "run detail must be completed");
  const report = logRequest("report", "GET", `/runs/${runId}/report`, await request(baseUrl, "GET", `/runs/${runId}/report`));
  check(report.status === 200 && typeof report.body.data.report.report === "string", "report must be readable");
  emit({
    event: "report",
    runId,
    reportChars: report.body.data.report.reportChars,
    sourcesTotal: report.body.data.report.sourcesSummary?.total ?? 0,
  });

  // 8. Conditional delivery closure: the route is a documented 404.
  const delivery = logRequest("delivery", "GET", `/runs/${runId}/delivery`, await request(baseUrl, "GET", `/runs/${runId}/delivery`));
  check(delivery.status === 404 && delivery.body.error.code === "not_found", "delivery must be an explicit 404");

  // 9. Pause/enable.
  const paused = logRequest("pause", "POST", `/schedules/${scheduleId}/pause`, await request(baseUrl, "POST", `/schedules/${scheduleId}/pause`));
  check(paused.status === 200 && paused.body.data.schedule.status === "paused", "pause must apply");
  const enabled = logRequest("enable", "POST", `/schedules/${scheduleId}/enable`, await request(baseUrl, "POST", `/schedules/${scheduleId}/enable`));
  check(enabled.status === 200 && enabled.body.data.schedule.status === "active", "enable must apply");

  // 10. Restart the API on the same state directory.
  const beforeRestart = {
    scheduleId: enabled.body.data.schedule.scheduleId,
    nextRunAt: enabled.body.data.schedule.nextRunAt,
    lastRunId: enabled.body.data.schedule.lastRun.runId,
    triggerCount: enabled.body.data.schedule.triggerCount,
  };
  await api.stop();
  await scheduler.stop({ abortActive: true });
  api = null;
  scheduler = null;

  scheduler = await createScheduler({
    stateDir,
    now: clock,
    researchDeps: researchDeps({ rootDir: runsDir, port: completedPort() }),
  });
  api = createManagementApi({ scheduler, runsDir, host: "127.0.0.1", port: 0, env: {}, shutdownTimeoutMs: 500 });
  const restartedAddress = await api.start();
  emit({ event: "listen", phase: "restart", host: restartedAddress.host, port: restartedAddress.port, url: restartedAddress.url });

  const afterRestartResponse = logRequest(
    "get-after-restart",
    "GET",
    `/schedules/${scheduleId}`,
    await request(restartedAddress.url, "GET", `/schedules/${scheduleId}`),
  );
  check(afterRestartResponse.status === 200, "schedule must survive restart");
  const after = afterRestartResponse.body.data.schedule;
  const afterRestart = {
    scheduleId: after.scheduleId,
    nextRunAt: after.nextRunAt,
    lastRunId: after.lastRun.runId,
    triggerCount: after.triggerCount,
  };
  const consistent =
    afterRestart.scheduleId === beforeRestart.scheduleId &&
    afterRestart.nextRunAt === beforeRestart.nextRunAt &&
    afterRestart.lastRunId === beforeRestart.lastRunId &&
    afterRestart.triggerCount === beforeRestart.triggerCount;
  emit({ event: "restart-consistency", before: beforeRestart, after: afterRestart, consistent });
  check(consistent, "restart must read the same persisted state");

  const runAfterRestart = logRequest(
    "run-after-restart",
    "GET",
    `/runs/${runId}/report`,
    await request(restartedAddress.url, "GET", `/runs/${runId}/report`),
  );
  check(runAfterRestart.status === 200 && runAfterRestart.body.data.report.runId === runId, "run must survive restart");

  // 11. Delete, then confirm the plan is gone while run history remains.
  const deleted = logRequest(
    "delete",
    "DELETE",
    `/schedules/${scheduleId}`,
    await request(restartedAddress.url, "DELETE", `/schedules/${scheduleId}`),
  );
  check(deleted.status === 200 && deleted.body.data.deleted === true, "delete must succeed");
  const afterDelete = logRequest(
    "get-after-delete",
    "GET",
    `/schedules/${scheduleId}`,
    await request(restartedAddress.url, "GET", `/schedules/${scheduleId}`),
  );
  check(afterDelete.status === 404 && afterDelete.body.error.code === "not_found", "deleted schedule must be 404");
  const retained = logRequest("runs-after-delete", "GET", "/runs", await request(restartedAddress.url, "GET", "/runs"));
  check(retained.status === 200 && retained.body.data.total === 1, "run history must remain readable");

  await api.stop();
  api = null;
  await scheduler.stop({ abortActive: true });
  scheduler = null;
  emit({ event: "stop", drained: true });
  emit({ event: "result", ok: true, requests: events.filter((event) => event.event === "request").length });
} catch (error) {
  failed = true;
  emit({ event: "failure", message: String(error?.message ?? error).slice(0, 300) });
} finally {
  if (api) await api.stop().catch(() => {});
  if (scheduler) await scheduler.stop({ abortActive: true }).catch(() => {});
  await rm(root, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
