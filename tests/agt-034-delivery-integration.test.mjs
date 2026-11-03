/** AGT-034 integration: real HTTP, Scheduler, Research and Delivery.
 * Only model/tool and outbound Feishu networking are deterministic fakes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementApi } from "../src/api/index.mjs";
import { createDeliveringScheduler } from "../src/delivery/index.mjs";
import { completedPort, createFakeClock, researchDeps } from "./helpers/scheduler-fixture.mjs";

const personal = { type: "open_id", id: "ou_testperson0001", label: "个人" };
const group = { type: "chat_id", id: "oc_test_group_0001", label: "测试群" };

test("AGT-034 T3: reads delivery and protects historical recipients", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-pi-agt-034-delivery-"));
  const clock = createFakeClock("2026-11-03T00:00:00Z");
  const stateDir = join(root, "scheduler");
  const runsDir = join(root, "research");
  const deliveryDir = join(root, "delivery");
  const sendCalls = [];
  const makeDelivering = () => createDeliveringScheduler({
    schedulerOptions: {
      stateDir,
      now: clock,
      researchDeps: researchDeps({ rootDir: runsDir, port: completedPort() }),
    },
    delivery: {
      stateDir: deliveryDir,
      env: {},
      now: clock,
      researchRunsDir: runsDir,
      sendMessage: async (input) => {
        sendCalls.push({ receiveIdType: input.receiveIdType, receiveId: input.receiveId });
        return { messageId: "om_test_" + sendCalls.length };
      },
    },
  });
  let delivering;
  let api;
  const open = async () => {
    delivering = await makeDelivering();
    api = createManagementApi({
      deliveringScheduler: delivering, runsDir, env: {}, host: "127.0.0.1", port: 0, now: clock,
    });
    const address = await api.start();
    return async (method, path, body) => {
      const init = { method, signal: AbortSignal.timeout(10000) };
      if (body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(new URL(path, address.url), init);
      return { status: res.status, data: await res.json() };
    };
  };
  const stop = async () => {
    await api?.stop();
    await delivering?.scheduler.stop({ abortActive: true });
    api = null;
    delivering = null;
  };
  try {
    let call = await open();
    const status = await call("GET", "/v1/status");
    assert.equal(status.status, 200);
    assert.equal(status.data.data.capabilities.deliveryStatus, true);

    const created = await call("POST", "/v1/schedules", {
      scheduleId: "daily-delivery-api",
      name: "管理 API 投递研究",
      kind: "recurring",
      timezone: "Asia/Shanghai",
      cron: "0 9 * * *",
      request: { topic: "Agent news", goal: "Local T3", timeRange: "48h" },
      deliveryTargets: [personal],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.data.data.schedule.deliveryTargets, [personal]);

    const updated = await call("PATCH", "/v1/schedules/daily-delivery-api", {
      deliveryTargets: [personal, group],
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.data.data.schedule.deliveryTargets, [personal, group]);

    const run = await call("POST", "/v1/schedules/daily-delivery-api/run-now");
    assert.equal(run.status, 200);
    assert.equal(run.data.data.trigger.status, "succeeded");
    const runId = run.data.data.trigger.runId;
    assert.equal(sendCalls.length, 2);
    const delivered = await call("GET", "/v1/runs/" + runId + "/delivery");
    assert.equal(delivered.status, 200);
    assert.equal(delivered.data.data.delivery.researchStatus, "completed");
    assert.equal(delivered.data.data.delivery.deliveryStatus, "sent");
    assert.deepEqual(delivered.data.data.delivery.counts, {
      total: 2, sent: 2, failed: 0, pending: 0,
    });
    assert.equal(JSON.stringify(delivered).includes(personal.id), false);
    assert.equal(JSON.stringify(delivered).includes(group.id), false);

    const changed = await call("PATCH", "/v1/schedules/daily-delivery-api", {
      deliveryTargets: [{ type: "open_id", id: "ou_newperson0009" }],
    });
    assert.equal(changed.status, 409);
    assert.equal(changed.data.error.code, "conflict");

    const same = await call("PATCH", "/v1/schedules/daily-delivery-api", {
      deliveryTargets: [group, personal],
    });
    assert.equal(same.status, 200);
    assert.equal((await call("GET", "/v1/runs/r-20000101T000000-000000/delivery")).status, 404);
    await stop();

    call = await open();
    const again = await call("GET", "/v1/runs/" + runId + "/delivery");
    assert.equal(again.status, 200);
    assert.equal(again.data.data.delivery.deliveryStatus, "sent");
    assert.equal(sendCalls.length, 2, "restart must not send again");
  } finally {
    await stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
