#!/usr/bin/env node
/**
 * Scenario B - 定时研究 + 主动投递 验收执行脚本。
 *
 *   node scripts/agt-03x/b-scheduled-research-delivery.mjs --offline
 *   node scripts/agt-03x/b-scheduled-research-delivery.mjs --dry-run
 *   node scripts/agt-03x/b-scheduled-research-delivery.mjs --api http://127.0.0.1:8080/v1 \
 *        --schedule-id <scheduleId> [--run-id <runId>] [--evidence-in <jsonl>]
 *
 * 只读：只用 `GET /v1/...` 与磁盘 `run.json` 做读回，不触发调度、不发送消息、
 * 不重新实现研究或投递逻辑。缺能力/缺读回一律 `blocker`（exit 3）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT,
  ROOT,
  UsageError,
  check,
  createEvidence,
  gitHead,
  nowIso,
  parseArgs,
  readJsonl,
  report,
  runSelfTest,
  writeUsage,
} from "./lib/harness.mjs";
import { unmetFor } from "./lib/preconditions.mjs";
import { mapResearchStatusToTriggerStatus } from "../../src/scheduler/contracts.mjs";

const SCENARIO = "B";
const USAGE = `usage: node scripts/agt-03x/b-scheduled-research-delivery.mjs [--offline|--dry-run]
       --api <baseUrl with /v1> --schedule-id <id> [--run-id <id>]
       [--evidence-in <jsonl>] [--expect-target <type:maskedId> ...]
       [--runs-dir <dir>] [--evidence <out.jsonl>]`;

/**
 * Statuses the research executor can report. The mapping itself is imported
 * from `src/scheduler/contracts.mjs` - a local copy would keep judging against
 * an outdated table after the runtime contract changes.
 */
const KNOWN_RESEARCH_STATUS = Object.freeze(new Set([
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
  "timeout",
]));

function targetKey(destination) {
  if (!destination || typeof destination.type !== "string" || typeof destination.maskedId !== "string") return null;
  return `${destination.type}:${destination.maskedId}`;
}

/** Pure judgement over readback objects; exercised verbatim by `--offline`. */
export function judgeB({ schedule, runs, run, delivery, runJson, toolEvents, expectedTargets }) {
  const checks = [];

  // B1 - 到点触发恰好一次，不产生重复 runId
  if (!schedule) {
    checks.push(check("B1", "blocker", "schedule not readable via GET /v1/schedules/:id"));
  } else if (!(schedule.stats?.triggers >= 1)) {
    checks.push(check("B1", "fail", `stats.triggers=${schedule.stats?.triggers} (expected >= 1)`));
  } else if (!Array.isArray(runs) || runs.length === 0) {
    checks.push(check("B1", "blocker", "no runs listed for this schedule"));
  } else {
    const ids = runs.map((item) => item.runId);
    const unique = new Set(ids);
    if (unique.size !== ids.length) checks.push(check("B1", "fail", "duplicate runId in run list (trigger fired twice)"));
    else if (ids.length !== 1) checks.push(check("B1", "fail", `${ids.length} runs for a single trigger window`));
    else checks.push(check("B1", "pass", `triggers=${schedule.stats.triggers} runs=1 duplicates=0`));
  }

  // B2 - 研究走真实链路：真实 Guanlan MCP 工具调用
  if (!Array.isArray(toolEvents)) {
    checks.push(check("B2", "blocker", "no tool-event JSONL supplied (--evidence-in)"));
  } else {
    const calls = toolEvents.filter(
      (event) => (event.kind === "tool.end" || event.event === "tool.end") && typeof event.toolName === "string",
    );
    const guanlan = calls.filter((event) => event.toolName.startsWith("mcp__guanlan__"));
    const ok = guanlan.filter((event) => event.status === "ok" && event.durationMs > 0);
    if (calls.length === 0) checks.push(check("B2", "blocker", "no tool.end events recorded"));
    else if (guanlan.length === 0) checks.push(check("B2", "fail", "research used no mcp__guanlan__ tool"));
    else if (ok.length === 0) checks.push(check("B2", "fail", "mcp__guanlan__ calls recorded without status=ok"));
    else checks.push(check("B2", "pass", `mcp__guanlan__ calls=${ok.length} all ok`));
  }

  // B3 - trigger 终态与研究终态一致（partial 不得显示为成功）
  if (!schedule || !run) {
    checks.push(check("B3", "blocker", "schedule or run missing for status comparison"));
  } else {
    const trigger = (schedule.triggers ?? []).find((item) => item.runId === run.runId);
    const expected = KNOWN_RESEARCH_STATUS.has(run.status) ? mapResearchStatusToTriggerStatus(run.status) : null;
    if (!trigger) checks.push(check("B3", "blocker", "trigger for this runId not present in schedule readback"));
    else if (!expected) checks.push(check("B3", "fail", `unknown run status ${run.status}`));
    else if (trigger.status !== expected) {
      checks.push(check("B3", "fail", `trigger.status=${trigger.status} vs run.status=${run.status} (expected ${expected})`));
    } else if (run.status === "completed_with_errors" && trigger.status === "succeeded") {
      checks.push(check("B3", "fail", "partial research reported as succeeded"));
    } else {
      checks.push(check("B3", "pass", `trigger.status=${trigger.status} derived from run.status=${run.status}`));
    }
  }

  // B4 - 每个配置目标各投递一次，幂等
  if (delivery === null) {
    checks.push(check("B4", "blocker", "delivery reader not configured (404)"));
  } else if (!delivery) {
    checks.push(check("B4", "blocker", "delivery record not found for this run"));
  } else {
    const targets = Array.isArray(delivery.targets) ? delivery.targets : [];
    const sent = targets.filter((target) => target.status === "sent" && target.attempts === 1);
    const expected = expectedTargets ?? [];
    const keys = targets.map((target) => targetKey(target.destination));
    const expectedKeys = expected.map((entry) => entry);
    const sameSet =
      expectedKeys.length === 0 ||
      (keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key)));
    if (targets.length === 0) checks.push(check("B4", "fail", "delivery has no targets"));
    else if (!sameSet) checks.push(check("B4", "fail", "delivered target set differs from the configured set"));
    else if (sent.length !== targets.length) checks.push(check("B4", "fail", `${sent.length}/${targets.length} targets sent on first attempt`));
    else if (delivery.counts?.failed !== 0 || delivery.counts?.pending !== 0) {
      checks.push(check("B4", "fail", `counts failed=${delivery.counts?.failed} pending=${delivery.counts?.pending}`));
    } else checks.push(check("B4", "pass", `targets=${targets.length} sent=${sent.length} failed=0 pending=0`));
  }

  // B6 - 分段/重试有界
  if (!delivery) {
    checks.push(check("B6", "blocker", "no delivery record for retry-bound judgement"));
  } else {
    const attempts = (delivery.targets ?? []).map((target) => target.attempts ?? 0);
    const worst = attempts.length > 0 ? Math.max(...attempts) : 0;
    if (worst > 3) checks.push(check("B6", "fail", `attempts=${worst} exceeds the bounded-retry limit of 3`));
    else checks.push(check("B6", "pass", `maxAttempts=${worst} <= 3`));
  }

  // B7 - API 读回与磁盘 run store 一致
  if (!runJson) {
    checks.push(check("B7", "blocker", "run.json not read (no --runs-dir / RESEARCH_RUNS_DIR)"));
  } else if (!run) {
    checks.push(check("B7", "blocker", "API run not readable for comparison"));
  } else {
    const fields = ["runId", "status", "createdAt", "finishedAt"];
    const mismatch = fields.filter((field) => (run[field] ?? null) !== (runJson[field] ?? null));
    if (mismatch.length > 0) checks.push(check("B7", "fail", `API and run.json differ on: ${mismatch.join(", ")}`));
    else checks.push(check("B7", "pass", `runId/status/createdAt/finishedAt equal on API and disk`));
  }

  return checks;
}

function synthetic() {
  const runId = "run-selftest-0100";
  const schedule = {
    scheduleId: "sch-selftest",
    stats: { triggers: 1, succeeded: 1, partial: 0, failed: 0 },
    triggers: [{ runId, status: "succeeded", researchStatus: "completed", finishedAt: "2026-11-04T00:05:00.000Z" }],
  };
  return {
    runId,
    schedule,
    runs: [{ runId, status: "completed" }],
    run: { runId, status: "completed", createdAt: "2026-11-04T00:00:00.000Z", finishedAt: "2026-11-04T00:05:00.000Z" },
    delivery: {
      runId,
      counts: { total: 1, sent: 1, failed: 0, pending: 0 },
      targets: [
        {
          destination: { type: "wecom", maskedId: "sha256:cccccccccccc" },
          status: "sent",
          attempts: 1,
          deliveryKind: "report",
        },
      ],
    },
    runJson: { runId, status: "completed", createdAt: "2026-11-04T00:00:00.000Z", finishedAt: "2026-11-04T00:05:00.000Z" },
    toolEvents: [
      { kind: "tool.end", toolName: "mcp__guanlan__guanlan_news_recent", status: "ok", durationMs: 840 },
    ],
    expectedTargets: ["wecom:sha256:cccccccccccc"],
  };
}

function selfTestCases() {
  const good = () => judgeB(synthetic());
  return [
    { name: "happy path -> pass", expect: "pass", run: good },
    {
      name: "partial research shown as succeeded -> fail",
      expect: "fail",
      run: () => {
        const input = synthetic();
        input.run.status = "completed_with_errors";
        input.runJson.status = "completed_with_errors";
        input.runs = [{ runId: input.runId, status: "completed_with_errors" }];
        return judgeB(input);
      },
    },
    {
      name: "duplicate runId (double trigger) -> fail",
      expect: "fail",
      run: () => {
        const input = synthetic();
        input.runs = [{ runId: input.runId }, { runId: input.runId }];
        return judgeB(input);
      },
    },
    {
      name: "no Guanlan tool call -> fail",
      expect: "fail",
      run: () => {
        const input = synthetic();
        input.toolEvents = [{ kind: "tool.end", toolName: "read_file", status: "ok", durationMs: 12 }];
        return judgeB(input);
      },
    },
    {
      name: "delivery reader unavailable -> blocker",
      expect: "blocker",
      run: () => {
        const input = synthetic();
        input.delivery = null;
        return judgeB(input);
      },
    },
    {
      name: "API/disk mismatch -> fail",
      expect: "fail",
      run: () => {
        const input = synthetic();
        input.runJson = { ...input.runJson, finishedAt: "2026-11-04T00:06:00.000Z" };
        return judgeB(input);
      },
    },
    {
      name: "unbounded retries -> fail",
      expect: "fail",
      run: () => {
        const input = synthetic();
        input.delivery.targets[0].attempts = 5;
        return judgeB(input);
      },
    },
  ];
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function resolveRunsRoot() {
  try {
    const module = await import("../../src/research/execute.mjs");
    return module.resolveRunsRoot(process.env) ?? null;
  } catch {
    return process.env.RESEARCH_RUNS_DIR ?? null;
  }
}

async function main() {
  const options = parseArgs(
    process.argv.slice(2),
    {
      values: {
        "--api": "api",
        "--schedule-id": "scheduleId",
        "--run-id": "runId",
        "--evidence-in": "evidenceIn",
        "--expect-target": "expectTargets[]",
        "--runs-dir": "runsDir",
        "--evidence": "evidence",
      },
      flags: { "--offline": "offline", "--dry-run": "dryRun" },
    },
    { usage: USAGE },
  );
  if (options.help) {
    writeUsage(USAGE);
    return EXIT.PASS;
  }
  if (options.offline && options.dryRun) throw new UsageError("--offline and --dry-run are mutually exclusive");

  const evidenceOut = options.evidence ?? join(ROOT, "poc", "evidence", "agt-03x-scenario-b.jsonl");
  const evidence = createEvidence(evidenceOut, { scenario: SCENARIO });
  evidence.emit({ event: "start", mode: options.offline ? "offline" : options.dryRun ? "dry-run" : "real", detail: `head=${gitHead() ?? "unknown"}` });

  if (options.offline) {
    const { ok, rows } = runSelfTest(selfTestCases());
    for (const row of rows) {
      evidence.emit({ event: "self-test", status: row.pass ? "pass" : "fail", detail: `${row.name} expect=${row.expect} actual=${row.actual}` });
    }
    return report(evidence, {
      scenario: SCENARIO,
      mode: "offline",
      checks: [
        check("self-test", ok ? "pass" : "fail", `${rows.filter((row) => row.pass).length}/${rows.length} bundled cases matched`),
        check("B1-B7", "blocker", "offline self-test only - no live run was read back"),
      ],
    }).exitCode;
  }

  const gates = [];
  if (!options.api) gates.push(check("api", "blocker", "--api is required for readback (loopback /v1 base URL)"));
  if (!options.scheduleId && !options.runId) {
    gates.push(check("target", "blocker", "--schedule-id or --run-id is required"));
  }
  for (const item of unmetFor("B")) {
    gates.push(check(`pre-${item.id}`, "blocker", item.reason ?? item.title));
  }
  if (gates.length > 0) {
    for (const gate of gates) evidence.emit(gate);
    process.stderr.write(`Scenario B cannot run yet (fail-closed, nothing triggered):\n${gates.map((gate) => `  - ${gate.check}: ${gate.detail}`).join("\n")}\n`);
    return report(evidence, { scenario: SCENARIO, mode: options.dryRun ? "dry-run" : "real", checks: gates }).exitCode;
  }

  if (options.dryRun) {
    evidence.emit({
      event: "plan",
      mode: "dry-run",
      detail: `GET ${options.api}/schedules/${options.scheduleId ?? "-"} ; /runs?scheduleId= ; /runs/:id ; /runs/:id/delivery ; read run.json`,
    });
    return report(evidence, {
      scenario: SCENARIO,
      mode: "dry-run",
      checks: [check("B1-B7", "blocker", "dry-run only - nothing executed")],
    }).exitCode;
  }

  const base = options.api.replace(/\/$/, "");
  let schedule = null;
  let runs = [];
  let run = null;
  let delivery;
  let runJson = null;

  if (options.scheduleId) {
    const response = await fetchJson(`${base}/schedules/${encodeURIComponent(options.scheduleId)}`);
    schedule = response.status === 200 ? (response.body?.data?.schedule ?? null) : null;
    evidence.emit({ event: "readback", check: "schedule", status: schedule ? "ok" : "missing", detail: `status=${response.status}` });
  }
  const runsQuery = options.scheduleId
    ? `${base}/runs?scheduleId=${encodeURIComponent(options.scheduleId)}&limit=50`
    : `${base}/runs?limit=50`;
  const runsResponse = await fetchJson(runsQuery);
  runs = runsResponse.status === 200 ? (runsResponse.body?.data?.runs ?? []) : [];
  const runId = options.runId ?? runs[0]?.runId ?? null;
  if (runId) {
    const runResponse = await fetchJson(`${base}/runs/${encodeURIComponent(runId)}`);
    run = runResponse.status === 200 ? (runResponse.body?.data?.run ?? null) : null;
    const deliveryResponse = await fetchJson(`${base}/runs/${encodeURIComponent(runId)}/delivery`);
    delivery = deliveryResponse.status === 200 ? (deliveryResponse.body?.data?.delivery ?? null) : deliveryResponse.status === 404 ? null : undefined;
    evidence.emit({
      event: "readback",
      check: "run",
      status: run ? "ok" : "missing",
      runId,
      detail: `runs=${runResponse.status} delivery=${deliveryResponse.status}`,
    });
    const runsDir = options.runsDir ?? (await resolveRunsRoot());
    if (runsDir && existsSync(join(runsDir, runId, "run.json"))) {
      try {
        runJson = JSON.parse(readFileSync(join(runsDir, runId, "run.json"), "utf8"));
      } catch {
        runJson = null;
      }
    }
  }

  const toolEvents = options.evidenceIn && existsSync(options.evidenceIn) ? readJsonl(options.evidenceIn) : undefined;
  const checks = judgeB({ schedule, runs, run, delivery, runJson, toolEvents, expectedTargets: options.expectTargets ?? [] });
  return report(evidence, { scenario: SCENARIO, mode: "real", checks }).exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof UsageError) {
    writeUsage(`${error.message}\n${USAGE}`);
    process.exitCode = EXIT.USAGE;
  } else {
    process.stderr.write(`scenario B failed: ${error?.message ?? error} (at ${nowIso()})\n`);
    process.exitCode = EXIT.FAIL;
  }
}
