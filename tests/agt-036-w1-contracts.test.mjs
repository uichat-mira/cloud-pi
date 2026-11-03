/**
 * W1 (AGT-036): the delivery-target vocabulary carries WeCom destinations and the
 * scheduler contract is version 2 with a compatible v1 read.
 *
 * The matrix below is the acceptance evidence for "合同版本 1→2 兼容读":
 *
 *   stored version | wecom types | readable | written back
 *   ---------------+-------------+----------+--------------
 *   1              | no          | yes      | as-is (no silent rewrite)
 *   1 (hand-edited)| yes         | yes      | normalization is version-free
 *   2              | yes         | yes      | yes
 *   3              | -           | no       | parse_error
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeliveryCoordinator } from "../src/delivery/coordinator.mjs";
import {
  DELIVERY_TARGET_TYPE,
  SCHEDULER_CONTRACT_VERSIONS,
  SCHEDULER_CONTRACT_VERSION,
  SchedulerError,
  isDeliveryTargetType,
  isFeishuDeliveryTargetType,
  isSupportedSchedulerContractVersion,
  isWecomDeliveryTargetType,
  normalizeDeliveryTargets,
} from "../src/scheduler/contracts.mjs";
import { assertScheduleShape } from "../src/scheduler/schedule.mjs";

/** The delivery fixture's run shape, minimal. */
const RUN_ID = "r-20261104T010000-abcdef";
function makeRun() {
  return {
    contractVersion: 1,
    runId: RUN_ID,
    status: "completed",
    createdAt: "2026-11-04T01:00:00.000Z",
    request: { topic: "每周研究" },
    paths: {},
    errors: [],
  };
}

const MINIMAL_SCHEDULE = {
  scheduleId: "delivery-daily",
  name: "weekly digest",
  kind: "recurring",
  timezone: "Asia/Shanghai",
  cron: "0 9 * * 1",
  onceAt: null,
  onceAtUtc: null,
  request: { topic: "每周研究" },
  deliveryTargets: [],
  status: "active",
  missedRunPolicy: "coalesce_one",
  createdAt: "2026-11-04T01:00:00.000Z",
  updatedAt: "2026-11-04T01:00:00.000Z",
  nextRunAt: "2026-11-09T01:00:00.000Z",
  completedAt: null,
  lastRun: null,
  activeTrigger: null,
  triggers: [],
  stats: {
    triggers: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    cancelled: 0,
    timeout: 0,
    interrupted: 0,
    missed: 0,
    duplicatesSkipped: 0,
  },
};

test("W1: the scheduler contract is version 2 and version 1 stays readable", () => {
  assert.equal(SCHEDULER_CONTRACT_VERSION, 2);
  assert.deepEqual([...SCHEDULER_CONTRACT_VERSIONS], [1, 2]);
  assert.equal(isSupportedSchedulerContractVersion(1), true);
  assert.equal(isSupportedSchedulerContractVersion(2), true);
  assert.equal(isSupportedSchedulerContractVersion(3), false);
  assert.equal(isSupportedSchedulerContractVersion("2"), false);

  // A persisted v1 record (Feishu-only, as it must be) is still accepted.
  assert.doesNotThrow(() => assertScheduleShape({ ...MINIMAL_SCHEDULE, contractVersion: 1 }));
  assert.doesNotThrow(() => assertScheduleShape({ ...MINIMAL_SCHEDULE, contractVersion: 2 }));
  assert.throws(() => assertScheduleShape({ ...MINIMAL_SCHEDULE, contractVersion: 3 }), SchedulerError);
});

test("W1: the four target kinds are distinct and platform-namespaced", () => {
  assert.deepEqual(Object.values(DELIVERY_TARGET_TYPE).sort(), [
    "chat_id",
    "open_id",
    "wecom_chat",
    "wecom_user",
  ]);
  for (const type of Object.values(DELIVERY_TARGET_TYPE)) assert.equal(isDeliveryTargetType(type), true);
  assert.equal(isDeliveryTargetType("email"), false);
  assert.equal(isFeishuDeliveryTargetType("wecom_user"), false);
  assert.equal(isWecomDeliveryTargetType("wecom_user"), true);
  assert.equal(isWecomDeliveryTargetType("open_id"), false);
});

test("W1: WeCom targets are accepted, normalized and deduplicated", () => {
  const targets = normalizeDeliveryTargets([
    { type: "wecom_user", id: "ZhangSan", label: " 张三 " },
    { type: "wecom_chat", id: "wrABC123+def/ghi=" },
    { type: "wecom_user", id: "ZhangSan" },
    { type: "wecom_user", id: "li.si_01-x@corp" },
  ]);
  assert.equal(targets.length, 3);
  assert.equal(targets[0].label, "张三");
  assert.equal(targets[1].id, "wrABC123+def/ghi=");
  assert.equal(targets[2].id, "li.si_01-x@corp");
  assert.ok(Object.isFrozen(targets[0]));
});

test("W1: an id from one platform is never accepted as another platform's target", () => {
  // A Feishu id cannot be smuggled into a WeCom target…
  assert.throws(() => normalizeDeliveryTargets([{ type: "wecom_user", id: "ou_abc123" }]), SchedulerError);
  assert.throws(() => normalizeDeliveryTargets([{ type: "wecom_chat", id: "oc_group1" }]), SchedulerError);
  // …and vice versa; the two ^ou_/^oc_ branches are untouched.
  assert.throws(() => normalizeDeliveryTargets([{ type: "open_id", id: "ZhangSan" }]), SchedulerError);
  assert.throws(() => normalizeDeliveryTargets([{ type: "chat_id", id: "wrABC" }]), SchedulerError);
  // Opaque open_userid has no trusted userid mapping and must not be guessed at;
  // an empty or over-long id is refused too.
  assert.throws(() => normalizeDeliveryTargets([{ type: "wecom_user", id: "" }]), SchedulerError);
  assert.throws(() => normalizeDeliveryTargets([{ type: "wecom_user", id: "a".repeat(65) }]), SchedulerError);
});

test("W1: unknown fields still fail closed", () => {
  assert.throws(
    () => normalizeDeliveryTargets([{ type: "wecom_user", id: "ZhangSan", receive_id: "ou_evil" }]),
    SchedulerError,
  );
  assert.throws(() => normalizeDeliveryTargets([{ wecom_user: "ZhangSan" }]), SchedulerError);
});

test("W1: the Feishu-only delivery coordinator refuses a WeCom target instead of sending it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-pi-w1-delivery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [];
  const coordinator = createDeliveryCoordinator({
    stateDir: join(dir, "delivery"),
    env: {},
    now: () => new Date("2026-11-04T01:10:00.000Z"),
    sendMessage: async (payload) => {
      sent.push(payload);
      return { messageId: "om_x" };
    },
    researchRunsDir: join(dir, "runs"),
    readRun: async () => makeRun(),
    limits: { retryDelayMs: 0 },
  });

  const summary = await coordinator.deliverRun({
    runId: RUN_ID,
    deliveryTargets: [{ type: "wecom_user", id: "ZhangSan" }],
    researchStatus: "completed",
    triggerStatus: "succeeded",
  });
  assert.equal(summary.reason, "unsupported_target_type");
  // The guard fires before any platform call: no Feishu send with a WeCom id.
  assert.equal(sent.length, 0);
});

test("W1: a schedule with no targets keeps its existing reason", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-pi-w1-delivery-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const coordinator = createDeliveryCoordinator({
    stateDir: join(dir, "delivery"),
    env: {},
    now: () => new Date("2026-11-04T01:10:00.000Z"),
    sendMessage: async () => ({ messageId: "om_x" }),
    researchRunsDir: join(dir, "runs"),
    readRun: async () => makeRun(),
    limits: { retryDelayMs: 0 },
  });
  const summary = await coordinator.deliverRun({
    runId: RUN_ID,
    deliveryTargets: [],
    researchStatus: "completed",
    triggerStatus: "succeeded",
  });
  assert.equal(summary.reason, "no_delivery_targets");
});
