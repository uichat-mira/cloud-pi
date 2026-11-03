/**
 * AGT-033 T1: destination schema, idempotency key, research-status → delivery
 * policy and bounded long-text formatting.
 *
 * These are contract tests: they fail if a recipient can be smuggled into a
 * schedule, if a delivery key is not stable, if a failed run is described as a
 * successful report, or if a long report can produce an unbounded number of
 * messages.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELIVERY_KIND,
  DELIVERY_LIMITS,
  buildDeliveryKey,
  planDelivery,
  splitBounded,
  buildDeliveryMessage,
} from "../src/delivery/index.mjs";
import {
  DELIVERY_TARGET_TYPE,
  SchedulerError,
  normalizeDeliveryTargets,
} from "../src/scheduler/contracts.mjs";
import { assertScheduleShape, normalizeScheduleInput } from "../src/scheduler/schedule.mjs";
import { createScheduleStore } from "../src/scheduler/store.mjs";

const RUN_ID = "r-20261103T010000-abcdef";
const NOW = new Date("2026-11-03T00:00:00Z");

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "cloud-pi-agt-033-contracts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function scheduleInput(extra = {}) {
  return {
    scheduleId: "delivery-daily",
    kind: "recurring",
    timezone: "Asia/Shanghai",
    cron: "0 9 * * *",
    request: { topic: "研究 AI Agent 工程进展", timeRange: "24h" },
    ...extra,
  };
}

describe("AGT-033 T1: trusted deliveryTargets schema", () => {
  test("accepts one open_id and one chat_id target and preserves order", () => {
    const targets = normalizeDeliveryTargets([
      { type: DELIVERY_TARGET_TYPE.OPEN_ID, id: "ou_person1", label: " 维护者 " },
      { type: DELIVERY_TARGET_TYPE.CHAT_ID, id: "oc_group_1" },
    ]);
    assert.deepEqual(
      targets.map((target) => ({ ...target })),
      [
        { type: "open_id", id: "ou_person1", label: "维护者" },
        { type: "chat_id", id: "oc_group_1" },
      ],
    );
    assert.ok(Object.isFrozen(targets));
    assert.ok(Object.isFrozen(targets[0]));
  });

  test("absent targets mean no delivery; duplicates are collapsed", () => {
    assert.deepEqual(normalizeDeliveryTargets(undefined), []);
    assert.deepEqual(normalizeDeliveryTargets(null), []);
    const deduped = normalizeDeliveryTargets([
      { type: "open_id", id: "ou_same" },
      { type: "open_id", id: "ou_same" },
      { type: "chat_id", id: "oc_same" },
    ]);
    assert.equal(deduped.length, 2);
  });

  test("a report/model-ish extra field cannot become a recipient", () => {
    assert.throws(
      () => normalizeDeliveryTargets([{ type: "open_id", id: "ou_person1", receive_id: "ou_evil" }]),
      (error) => error instanceof SchedulerError && /unsupported field/.test(error.message),
    );
    assert.throws(
      () => normalizeDeliveryTargets([{ open_id: "ou_evil" }]),
      (error) => error instanceof SchedulerError,
    );
  });

  test("type and id must agree, and the fan-out is bounded", () => {
    assert.throws(() => normalizeDeliveryTargets([{ type: "chat_id", id: "ou_wrong_prefix" }]), SchedulerError);
    assert.throws(() => normalizeDeliveryTargets([{ type: "open_id", id: "oc_wrong_prefix" }]), SchedulerError);
    assert.throws(() => normalizeDeliveryTargets([{ type: "email", id: "a@b.c" }]), SchedulerError);
    assert.throws(() => normalizeDeliveryTargets([{ type: "open_id", id: "ou_ok", nested: {} }]), SchedulerError);
    const tooMany = Array.from({ length: DELIVERY_LIMITS.maxAttempts + 8 }, (_, index) => ({
      type: "open_id",
      id: `ou_many${index}`,
    }));
    assert.throws(() => normalizeDeliveryTargets(tooMany), /at most 10 targets/);
  });
});

describe("AGT-033 T1: deliveryTargets are persisted schedule configuration", () => {
  test("create input stores targets next to (not inside) the research request", () => {
    const record = normalizeScheduleInput(
      scheduleInput({ deliveryTargets: [{ type: "open_id", id: "ou_person1" }] }),
      { now: NOW },
    );
    assert.deepEqual(record.deliveryTargets, [{ type: "open_id", id: "ou_person1" }]);
    assert.equal(Object.hasOwn(record.request, "deliveryTargets"), false);
    assert.equal(Object.hasOwn(record.request, "receive_id"), false);
  });

  test("the store round-trips targets and rejects a tampered record", async (t) => {
    const dir = await tempDir(t);
    const store = createScheduleStore({ stateDir: dir, env: {} });
    const record = normalizeScheduleInput(
      scheduleInput({
        deliveryTargets: [
          { type: "open_id", id: "ou_person1" },
          { type: "chat_id", id: "oc_group_1" },
        ],
      }),
      { now: NOW },
    );
    await store.write(record);
    const loaded = await store.read("delivery-daily");
    assert.deepEqual(loaded.deliveryTargets, record.deliveryTargets);

    const file = store.fileFor("delivery-daily");
    const tampered = JSON.parse(await readFile(file, "utf8"));
    tampered.deliveryTargets = [{ type: "open_id", id: "ou_injected", receive_id: "ou_other" }];
    await writeFile(file, JSON.stringify(tampered));
    await assert.rejects(store.read("delivery-daily"), (error) => error.code === "parse_error");
  });

  test("a pre-AGT-033 record without deliveryTargets stays readable", async (t) => {
    const dir = await tempDir(t);
    const schedulesDir = join(dir, "schedules");
    await mkdir(schedulesDir, { recursive: true });
    const legacy = normalizeScheduleInput(scheduleInput(), { now: NOW });
    delete legacy.deliveryTargets;
    await writeFile(join(schedulesDir, "delivery-daily.json"), JSON.stringify(legacy));
    const store = createScheduleStore({ stateDir: dir, env: {} });
    const loaded = await store.read("delivery-daily");
    assert.equal(loaded.deliveryTargets, undefined);
    assert.equal(assertScheduleShape(legacy).scheduleId, "delivery-daily");
  });
});

describe("AGT-033 T1: stable runId + destination idempotency key", () => {
  test("same run and destination always yield the same key", () => {
    const first = buildDeliveryKey(RUN_ID, { type: "open_id", id: "ou_person1" });
    const second = buildDeliveryKey(RUN_ID, { type: "open_id", id: "ou_person1" });
    assert.equal(first, second);
    assert.equal(first, `${RUN_ID}#open_id:ou_person1`);
  });

  test("different destinations and different runs yield different keys", () => {
    const keys = new Set([
      buildDeliveryKey(RUN_ID, { type: "open_id", id: "ou_person1" }),
      buildDeliveryKey(RUN_ID, { type: "chat_id", id: "oc_group_1" }),
      buildDeliveryKey("r-20261103T020000-abcdef", { type: "open_id", id: "ou_person1" }),
    ]);
    assert.equal(keys.size, 3);
  });

  test("an invalid run id or destination is refused instead of keyed", () => {
    assert.throws(() => buildDeliveryKey("../escape", { type: "open_id", id: "ou_person1" }));
    assert.throws(() => buildDeliveryKey(RUN_ID, { type: "open_id", id: "oc_group_1" }));
  });
});

describe("AGT-033 T1: terminal research status → delivery policy", () => {
  test("completed delivers the report", () => {
    assert.equal(planDelivery({ researchStatus: "completed", triggerStatus: "succeeded" }).kind, DELIVERY_KIND.REPORT);
  });

  test("completed_with_errors delivers the existing report marked partial", () => {
    const plan = planDelivery({ researchStatus: "completed_with_errors", triggerStatus: "partial" });
    assert.equal(plan.kind, DELIVERY_KIND.REPORT_PARTIAL);
    const message = buildDeliveryMessage({
      kind: plan.kind,
      runId: RUN_ID,
      researchStatus: "completed_with_errors",
      triggerStatus: "partial",
      run: { request: { topic: "topic" }, errors: [{ code: "http_error" }, { code: "model_error" }] },
      report: "## 报告\n正文",
    });
    assert.match(message.segments[0], /部分完成/);
    assert.match(message.segments[0], /2 项错误/);
    assert.match(message.segments[0], /## 报告/);
  });

  test("failed / cancelled / timeout only get a status notice, never a successful report", () => {
    for (const [researchStatus, triggerStatus] of [
      ["failed", "failed"],
      ["cancelled", "cancelled"],
      ["timeout", "timeout"],
    ]) {
      const plan = planDelivery({ researchStatus, triggerStatus });
      assert.equal(plan.kind, DELIVERY_KIND.STATUS, researchStatus);
      const message = buildDeliveryMessage({
        kind: plan.kind,
        runId: RUN_ID,
        researchStatus,
        triggerStatus,
        run: { request: { topic: "topic" }, errors: [{ code: "model_error" }] },
        report: "SHOULD-NOT-BE-SENT",
      });
      assert.equal(message.segments.length, 1);
      assert.match(message.segments[0], /未生成可投递的成功报告/);
      assert.doesNotMatch(message.segments[0], /SHOULD-NOT-BE-SENT/);
    }
  });

  test("interrupted / missed / unknown triggers send nothing", () => {
    assert.equal(planDelivery({ triggerStatus: "interrupted" }).kind, DELIVERY_KIND.NONE);
    assert.equal(planDelivery({ triggerStatus: "missed" }).kind, DELIVERY_KIND.NONE);
    assert.equal(planDelivery({ triggerStatus: "scheduled" }).kind, DELIVERY_KIND.NONE);
    assert.equal(planDelivery({}).kind, DELIVERY_KIND.NONE);
  });

  test("a failed trigger without a research record still gets a status notice", () => {
    const plan = planDelivery({ researchStatus: null, triggerStatus: "failed" });
    assert.equal(plan.kind, DELIVERY_KIND.STATUS);
  });
});

describe("AGT-033 T1: bounded long-text strategy", () => {
  const runId = RUN_ID;

  test("a short report is one message", () => {
    const split = splitBounded("short report", { runId });
    assert.deepEqual(split.segments, ["short report"]);
    assert.equal(split.truncated, false);
  });

  test("an oversized report is at most maxSegments bounded messages", () => {
    const text = "段落内容。".repeat(6000); // 30,000 code points
    const split = splitBounded(text, { runId });
    assert.equal(split.truncated, true);
    assert.ok(split.segments.length <= DELIVERY_LIMITS.maxSegments);
    for (const segment of split.segments) {
      assert.ok(
        Array.from(segment).length <= DELIVERY_LIMITS.maxCharsPerSegment,
        `segment has ${Array.from(segment).length} code points`,
      );
    }
    const last = split.segments.at(-1);
    assert.match(last, /已截断/);
    assert.match(last, new RegExp(runId));
    assert.match(split.segments[0], /^（1\/3）\n/);
  });

  test("splitting is deterministic and never splits a surrogate pair", () => {
    const text = "😀".repeat(20000); // one code point, two UTF-16 units each
    const first = splitBounded(text, { runId });
    const second = splitBounded(text, { runId });
    assert.deepEqual(first, second);
    const hasLoneSurrogate = (value) => {
      for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = value.charCodeAt(index + 1);
          if (next < 0xdc00 || next > 0xdfff) return true;
          index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          return true;
        }
      }
      return false;
    };
    for (const segment of first.segments) {
      assert.ok(Array.from(segment).length <= DELIVERY_LIMITS.maxCharsPerSegment);
      assert.equal(hasLoneSurrogate(segment), false);
      assert.equal(segment.includes("\uFFFD"), false);
    }
    assert.equal(first.truncated, true);
  });

  test("a huge report cannot produce more than the fixed segment count", () => {
    const split = splitBounded("x".repeat(1_000_000), { runId });
    assert.equal(split.segments.length, DELIVERY_LIMITS.maxSegments);
  });

  test("a report exactly at the limit stays a single untruncated message", () => {
    const text = "a".repeat(DELIVERY_LIMITS.maxCharsPerSegment);
    const split = splitBounded(text, { runId });
    assert.equal(split.segments.length, 1);
    assert.equal(split.truncated, false);
  });
});
