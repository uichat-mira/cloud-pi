/**
 * T1: management API contract surface.
 *
 * Route/method/query/schema validation, the frozen error envelope, the loopback
 * bind policy, the delivery conditional-closure and sensitive-field filtering.
 * These tests exercise the real HTTP server but not real research runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_ERROR,
  ApiError,
  createManagementApi,
  normalizeApiHost,
  normalizeApiPort,
} from "../src/api/index.mjs";
import {
  baseRequest,
  captureLogger,
  rawHttpRequest,
  startApiHarness,
  tempRoot,
} from "./agt-034-helpers.mjs";
import { completedPort, createFakeClock } from "./helpers/scheduler-fixture.mjs";

function errorOf(response) {
  return response.body?.error;
}

test("T1 health and status use the versioned JSON envelope", async (t) => {
  const harness = await startApiHarness(t);
  const health = await harness.request("GET", "/v1/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.data.apiVersion, "v1");
  assert.equal(health.body.data.status, "ok");
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.match(health.headers.get("x-request-id") ?? "", /^[0-9a-f]{12}$/);

  const status = await harness.request("GET", "/v1/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.data.apiVersion, "v1");
  assert.equal(status.body.data.scheduler.scheduleCount, 0);
  assert.equal(status.body.data.capabilities.deliveryStatus, false);
  assert.equal(status.body.data.capabilities.publicListener, false);
  assert.match(status.body.data.capabilities.deliveryReason, /AGT-033/);
});

test("T1 unmatched routes are 404, matched paths with other methods are 405", async (t) => {
  const harness = await startApiHarness(t);

  const unknown = await harness.request("GET", "/v1/unknown");
  assert.equal(unknown.status, 404);
  assert.equal(errorOf(unknown).code, "not_found");

  const wrongMethod = await harness.request("DELETE", "/v1/health");
  assert.equal(wrongMethod.status, 405);
  assert.equal(errorOf(wrongMethod).code, "method_not_allowed");
  assert.equal(wrongMethod.headers.get("allow"), "GET");

  const collection = await harness.request("PUT", "/v1/schedules");
  assert.equal(collection.status, 405);
  assert.equal(collection.headers.get("allow"), "GET, POST");

  // Trailing slashes are harmless, malformed encoding is not.
  const trailing = await harness.request("GET", "/v1/health/");
  assert.equal(trailing.status, 200);

  const malformed = await rawHttpRequest({
    port: harness.address.port,
    path: "/v1/schedules/%E0%A4%A",
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "invalid_request");
});

test("T1 body validation: JSON required, bounded size, object shape", async (t) => {
  const harness = await startApiHarness(t);

  const wrongType = await harness.request("POST", "/v1/schedules", "{}", {
    headers: { "content-type": "text/plain" },
  });
  assert.equal(wrongType.status, 415);
  assert.equal(errorOf(wrongType).code, "unsupported_media_type");

  const invalidJson = await harness.request("POST", "/v1/schedules", "{not-json", {
    headers: { "content-type": "application/json" },
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(errorOf(invalidJson).code, "invalid_request");

  const missing = await harness.request("POST", "/v1/schedules");
  assert.equal(missing.status, 400);
  assert.equal(errorOf(missing).code, "invalid_request");

  const arrayBody = await harness.request("POST", "/v1/schedules", []);
  assert.equal(arrayBody.status, 400);
  assert.equal(errorOf(arrayBody).code, "invalid_request");

  const oversized = await harness.request(
    "POST",
    "/v1/schedules",
    JSON.stringify({ name: "x".repeat(70 * 1024) }),
  );
  assert.equal(oversized.status, 413);
  assert.equal(errorOf(oversized).code, "payload_too_large");

  const unknownField = await harness.request("PATCH", "/v1/schedules/does-not-exist", { nope: 1 });
  assert.equal(unknownField.status, 400);
  assert.equal(errorOf(unknownField).code, "invalid_request");
});

test("T1 query parameters are validated per route", async (t) => {
  const harness = await startApiHarness(t);

  const unknownQuery = await harness.request("GET", "/v1/health?debug=1");
  assert.equal(unknownQuery.status, 400);
  assert.equal(errorOf(unknownQuery).code, "invalid_request");

  const badLimit = await harness.request("GET", "/v1/runs?limit=abc");
  assert.equal(badLimit.status, 400);
  assert.equal(errorOf(badLimit).code, "invalid_request");

  const zeroLimit = await harness.request("GET", "/v1/runs?limit=0");
  assert.equal(zeroLimit.status, 400);

  const hugeLimit = await harness.request("GET", "/v1/runs?limit=101");
  assert.equal(hugeLimit.status, 400);

  const badFilter = await harness.request("GET", "/v1/runs?scheduleId=missing");
  assert.equal(badFilter.status, 404);
  assert.equal(errorOf(badFilter).code, "not_found");
});

test("T1 schedule schema errors map to invalid_request", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const harness = await startApiHarness(t, { clock, port: completedPort() });
  const cases = [
    { kind: "recurring", timezone: "Mars/Olympus", cron: "0 9 * * *", request: baseRequest() },
    { kind: "once", timezone: "Asia/Shanghai", request: baseRequest() },
    { kind: "once", timezone: "Asia/Shanghai", at: "2026-11-05T09:00", cron: "0 9 * * *", request: baseRequest() },
    { kind: "recurring", timezone: "Asia/Shanghai", cron: "not a cron", request: baseRequest() },
    { kind: "recurring", timezone: "Asia/Shanghai", cron: "0 9 * * *", request: { goal: "missing topic" } },
    { kind: "weekly", timezone: "Asia/Shanghai", cron: "0 9 * * *", request: baseRequest() },
  ];
  for (const input of cases) {
    const response = await harness.request("POST", "/v1/schedules", input);
    assert.equal(response.status, 400, JSON.stringify(input));
    assert.equal(errorOf(response).code, "invalid_request");
  }

  await harness.request("POST", "/v1/schedules", {
    scheduleId: "recurring-update",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest(),
  });
  const atOnRecurring = await harness.request("PATCH", "/v1/schedules/recurring-update", {
    at: "2026-11-05T09:00",
  });
  assert.equal(atOnRecurring.status, 400);
  assert.equal(errorOf(atOnRecurring).code, "invalid_request");
  const cronOnOnce = await harness.request("PATCH", "/v1/schedules/recurring-update", {
    kind: "once",
    at: "2026-11-05T09:00",
    cron: "0 9 * * *",
  });
  assert.equal(cronOnOnce.status, 400);
  assert.equal(errorOf(cronOnOnce).code, "invalid_request");
  const badEnabled = await harness.request("PATCH", "/v1/schedules/recurring-update", { enabled: "yes" });
  assert.equal(badEnabled.status, 400);
  assert.equal(errorOf(badEnabled).code, "invalid_request");
});

test("T1 create returns 201 with Location and no internal/delivery fields", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const harness = await startApiHarness(t, { clock, port: completedPort() });
  const created = await harness.request("POST", "/v1/schedules", {
    scheduleId: "api-t1-daily",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest(),
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("location"), "/v1/schedules/api-t1-daily");
  const schedule = created.body.data.schedule;
  assert.equal(schedule.scheduleId, "api-t1-daily");
  assert.equal(schedule.status, "active");
  assert.equal(schedule.nextRunAt, "2026-11-03T01:00:00.000Z");
  assert.equal(schedule.request.topic, baseRequest().topic);
  assert.ok(!("paths" in schedule));
  assert.ok(!("deliveryTargets" in schedule));
  assert.ok(!("delivery" in schedule));
  assert.ok(!("stateDir" in created.body.data));

  // Direct scheduler state is the truth the API reported.
  assert.deepEqual(harness.scheduler.getSchedule("api-t1-daily").nextRunAt, schedule.nextRunAt);

  const list = await harness.request("GET", "/v1/schedules");
  assert.equal(list.status, 200);
  assert.equal(list.body.data.count, 1);
  assert.equal(list.body.data.schedules[0].scheduleId, "api-t1-daily");

  const detail = await harness.request("GET", "/v1/schedules/api-t1-daily");
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.body.data.schedule.recentTriggers));
});

test("T1 delivery remains a documented conditional closure, never a state endpoint", async (t) => {
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const harness = await startApiHarness(t, { clock, port: completedPort() });
  const delivery = await harness.request("GET", "/v1/runs/r-20261103T000000-abcdef/delivery");
  assert.equal(delivery.status, 404);
  assert.equal(errorOf(delivery).code, "not_found");
  assert.match(errorOf(delivery).message, /AGT-033 delivery contract is not part of the current dev source/);
  assert.equal(delivery.body.data, undefined);
});

test("T1 loopback-only bind policy is enforced before listening", async (t) => {
  assert.equal(normalizeApiHost("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeApiHost("::1"), "::1");
  for (const host of ["0.0.0.0", "::", "localhost", "192.168.1.5", "api.example.com", "", "  "]) {
    assert.throws(
      () => normalizeApiHost(host),
      (error) => error instanceof ApiError && error.code === API_ERROR.INVALID_REQUEST,
      `host ${JSON.stringify(host)} must be refused`,
    );
  }

  const fakeScheduler = { async listSchedules() { return []; } };
  assert.throws(
    () => createManagementApi({ scheduler: fakeScheduler, host: "0.0.0.0", port: 0 }),
    (error) => error instanceof ApiError && error.code === API_ERROR.INVALID_REQUEST,
  );
  assert.throws(
    () => createManagementApi({ scheduler: fakeScheduler, host: "::", port: 0 }),
    (error) => error instanceof ApiError && error.code === API_ERROR.INVALID_REQUEST,
  );

  assert.equal(normalizeApiPort(0), 0);
  assert.equal(normalizeApiPort("8787"), 8787);
  for (const port of [-1, 65536, 1.5, "abc", null]) {
    assert.throws(
      () => normalizeApiPort(port),
      (error) => error instanceof ApiError && error.code === API_ERROR.INVALID_REQUEST,
      `port ${JSON.stringify(port)} must be refused`,
    );
  }
  assert.ok(t);
});

test("T1 IPv6 ::1 loopback is allowed when the host supports it", async (t) => {
  const fakeScheduler = { listSchedules: async () => [] };
  const api = createManagementApi({ scheduler: fakeScheduler, host: "::1", port: 0 });
  try {
    const address = await api.start();
    assert.equal(address.host, "::1");
    assert.match(address.url, /^http:\/\/\[::1\]:\d+\/v1$/);
    assert.equal((await fetch(`${address.url}/health`)).status, 200);
  } catch (error) {
    const code = error?.cause?.code;
    if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
      t.skip(`IPv6 loopback unavailable on this host (${code})`);
      return;
    }
    throw error;
  } finally {
    await api.stop();
  }
});

test("T1 internal errors and logs never echo secrets, paths or stacks", async (t) => {
  const root = await tempRoot(t);
  const secret = "sk-agt034-should-never-appear";
  const feishuSecret = "feishu-secret-should-never-appear";
  const logger = captureLogger();
  const fakeScheduler = {
    async listSchedules() {
      throw new Error(`boom ${secret} at /Users/private/cloud-pi/${feishuSecret}`);
    },
  };
  const api = createManagementApi({
    scheduler: fakeScheduler,
    runsDir: root,
    env: { CLOUD_PI_MODEL_API_KEY: secret, FEISHU_APP_SECRET: feishuSecret },
    host: "127.0.0.1",
    port: 0,
    logger,
    shutdownTimeoutMs: 200,
  });
  const address = await api.start();
  t.after(() => api.stop());

  const response = await fetch(`${address.url}/schedules`);
  const text = await response.text();
  assert.equal(response.status, 500);
  const body = JSON.parse(text);
  assert.equal(body.error.code, "internal_error");
  assert.equal(body.error.message, "internal error");
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(feishuSecret));
  assert.ok(!text.includes("/Users/"));
  assert.ok(!text.includes("boom"));

  assert.ok(logger.lines.length > 0);
  const logs = logger.lines.join("\n");
  assert.ok(!logs.includes(secret));
  assert.ok(!logs.includes(feishuSecret));
  assert.ok(!logs.includes("/Users/"));
  assert.ok(!logs.includes("boom"));
  assert.match(logs, /api: internal error \(Error\)/);
});

test("T1 successful responses never include configured credentials or env values", async (t) => {
  const secret = "sk-agt034-env-secret";
  const harness = await startApiHarness(t, {
    apiOptions: {
      env: {
        CLOUD_PI_MODEL_API_KEY: secret,
        FEISHU_APP_SECRET: "feishu-env-secret",
        CLOUD_PI_RUNS_DIR: "/Users/private/runs",
      },
    },
  });
  const created = await harness.request("POST", "/v1/schedules", {
    scheduleId: "env-check",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: baseRequest(),
  });
  assert.equal(created.status, 201);
  for (const path of ["/v1/health", "/v1/status", "/v1/schedules", "/v1/schedules/env-check"]) {
    const response = await harness.request("GET", path);
    assert.equal(response.status, 200);
    assert.ok(!response.text.includes(secret));
    assert.ok(!response.text.includes("feishu-env-secret"));
    assert.ok(!response.text.includes("/Users/private"));
  }
  const logs = harness.logger.lines.join("\n");
  assert.ok(!logs.includes(secret));
  assert.ok(!logs.includes("/Users/private"));
});
