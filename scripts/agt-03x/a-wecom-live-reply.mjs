#!/usr/bin/env node
/**
 * Scenario A — 企业微信主动提问（单轮真实往返）验收执行脚本。
 *
 *   node scripts/agt-03x/a-wecom-live-reply.mjs --offline        # 自测判定逻辑
 *   node scripts/agt-03x/a-wecom-live-reply.mjs --dry-run        # 打印真实执行计划
 *   node scripts/agt-03x/a-wecom-live-reply.mjs --api http://127.0.0.1:8080/v1 \
 *        --evidence-in poc/evidence/agt-036-live.jsonl --run-id <runId>
 *
 * 真实模式分两步，脚本不代替通道驱动、也不发送任何消息：
 *   1. 由 t6 交付的驱动脚本产生真实 JSONL（`npm run wecom:live`，当前不存在）
 *   2. 本脚本读取该 JSONL 与 `GET /v1/runs/:runId`（及 `/delivery`），逐条判定 A1–A5
 *
 * 缺凭证 / 缺能力一律返回 `blocker`（exit 3），绝不返回 pass；`--offline`
 * 只自测判定逻辑，最终结论同样是 blocker。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  EXIT,
  ROOT,
  UsageError,
  check,
  createEvidence,
  gitHead,
  parseArgs,
  readJsonl,
  report,
  runSelfTest,
  writeUsage,
} from "./lib/harness.mjs";
import { unmetFor } from "./lib/preconditions.mjs";

const SCENARIO = "A";
const USAGE = `usage: node scripts/agt-03x/a-wecom-live-reply.mjs [--offline|--dry-run]
       [--api <baseUrl with /v1>] [--evidence-in <jsonl>] [--run-id <id>]
       [--allowed-tool <name> ...] [--evidence <out.jsonl>] [--timeout-ms N]`;

/*
 * 真实运行所需的凭证定义在 lib/preconditions.mjs（P1: WECOM_BOT_ID/SECRET、
 * P3: 设备绑定的 Cloud Session、P6: 模型网关）。这里只检查「存在性」，
 * 从不读取、打印或转发任何值。
 */

function ingressEvents(events) {
  return events.filter((event) => event.kind === "channel.ingress" || event.event === "channel.ingress");
}

function byKind(events, ...kinds) {
  return events.filter((event) => kinds.includes(event.kind) || kinds.includes(event.event));
}

function readProviderId(event) {
  return event.providerId ?? event.provider?.id ?? null;
}

function readUsage(event) {
  return event.usage ?? event.result?.usage ?? null;
}

/**
 * Pure judgement over already-collected evidence. The shape is fixed so
 * `--offline` can exercise it with synthetic input.
 */
export function judgeA({ events, runId, apiRun, apiDelivery, allowedTools }) {
  const checks = [];
  const ingress = ingressEvents(events);
  const chosenRunId = runId ?? ingress.at(-1)?.runId ?? null;

  // A1 - 入站事件被接收，字段已脱敏，且带 runId
  if (ingress.length === 0) {
    checks.push(check("A1", "blocker", "no channel.ingress event in evidence"));
  } else {
    const event = ingress.at(-1);
    const masked = typeof event.senderMasked === "string" && typeof event.chatMasked === "string";
    if (!event.runId) checks.push(check("A1", "fail", "channel.ingress has no runId"));
    else if (!masked) checks.push(check("A1", "fail", "channel.ingress lacks masked sender/chat fields"));
    else if (event.channel !== "wecom") checks.push(check("A1", "fail", `channel=${event.channel} (expected wecom)`));
    else checks.push(check("A1", "pass", `ingress=${ingress.length} channel=wecom`));
  }

  // A2 - 真实模型推理：usage 来自 provider，非 fixture
  const runs = byKind(events, "agent.run");
  const run = runs.filter((event) => (chosenRunId ? event.runId === chosenRunId : true)).at(-1);
  if (!run) {
    checks.push(check("A2", "blocker", "no agent.run event in evidence"));
  } else {
    const usage = readUsage(run);
    const providerId = readProviderId(run);
    if (providerId === "fixture" || run.modelSource === "fixture") {
      checks.push(check("A2", "fail", "agent.run used the fixture model boundary, not a real provider"));
    } else if (run.status !== "completed") {
      checks.push(check("A2", "fail", `agent.run status=${run.status}`));
    } else if (!providerId || !run.modelId) {
      checks.push(check("A2", "fail", "agent.run missing providerId/modelId"));
    } else if (!(usage?.input > 0) || !(usage?.output > 0)) {
      checks.push(check("A2", "fail", "agent.run usage is zero; provider usage not observed"));
    } else {
      checks.push(check("A2", "pass", `provider/model present usage.in=${usage.input} usage.out=${usage.output}`));
    }
  }

  // A3 - 回复真实回到企业微信且被平台接受
  const replies = byKind(events, "reply.sent", "delivery.attempt");
  const reply = replies.filter((event) => (chosenRunId ? event.runId === chosenRunId : true)).at(-1);
  if (!reply) {
    checks.push(check("A3", "blocker", "no reply.sent/delivery.attempt event in evidence"));
  } else if (!["sent", "delivered"].includes(reply.status)) {
    checks.push(check("A3", "fail", `reply status=${reply.status}`));
  } else if (reply.attempts !== 1) {
    checks.push(check("A3", "fail", `reply attempts=${reply.attempts} (expected exactly 1)`));
  } else {
    checks.push(check("A3", "pass", "reply accepted on first attempt"));
  }

  // A4 - 该轮暴露的工具集合与白名单一致（模型输入不能扩大工具面）
  const tools = run?.tools?.exposed ?? ingress.at(-1)?.tools?.exposed ?? null;
  if (!Array.isArray(tools)) {
    checks.push(check("A4", "blocker", "tools.exposed not recorded; cannot judge tool surface"));
  } else if (allowedTools.length > 0 && tools.some((tool) => !allowedTools.includes(tool))) {
    checks.push(check("A4", "fail", "tools.exposed contains an entry outside the declared whitelist"));
  } else if (allowedTools.length === 0 && tools.length > 0) {
    checks.push(check("A4", "fail", "tools.exposed is non-empty but no whitelist was declared"));
  } else {
    checks.push(check("A4", "pass", `tools.exposed=${tools.length} entry/entries within the declared whitelist`));
  }

  // A5 - 同一 runId 可由 Management API 读回
  if (!chosenRunId) {
    checks.push(check("A5", "blocker", "no runId available for API readback"));
  } else if (!apiRun) {
    checks.push(check("A5", "blocker", "management API not queried (no --api)"));
  } else if (apiRun.runId !== chosenRunId) {
    checks.push(check("A5", "fail", "GET /v1/runs returned a different runId"));
  } else if (apiDelivery === undefined) {
    checks.push(check("A5", "blocker", "GET /v1/runs/:id/delivery not queried"));
  } else if (apiDelivery === null) {
    checks.push(check("A5", "blocker", "delivery reader not configured (404)"));
  } else if (apiDelivery.runId !== chosenRunId) {
    checks.push(check("A5", "fail", "delivery readback returned a different runId"));
  } else {
    checks.push(check("A5", "pass", "runId readable from /v1/runs and /v1/runs/:id/delivery"));
  }

  return checks;
}

/** Bundled synthetic evidence used by `--offline`; never written as real proof. */
function baseEvents() {
  const runId = "run-selftest-0001";
  const usage = { input: 812, output: 96, total: 908 };
  return {
    runId,
    events: [
      {
        kind: "channel.ingress",
        channel: "wecom",
        runId,
        senderMasked: "sha256:aaaaaaaaaaaa",
        chatMasked: "sha256:bbbbbbbbbbbb",
        tools: { exposed: [] },
        at: "2026-11-04T00:00:00.000Z",
      },
      {
        kind: "agent.run",
        runId,
        status: "completed",
        providerId: "deepseek",
        modelId: "deepseek-chat",
        usage,
        durationMs: 6400,
        tools: { exposed: [] },
        at: "2026-11-04T00:00:06.400Z",
      },
      {
        kind: "reply.sent",
        runId,
        status: "sent",
        attempts: 1,
        durationMs: 210,
        at: "2026-11-04T00:00:06.610Z",
      },
    ],
    apiRun: { runId, status: "completed" },
    apiDelivery: { runId, deliveryStatus: "sent", counts: { total: 1, sent: 1, failed: 0, pending: 0 } },
  };
}

function selfTestCases() {
  const allowedTools = [];
  const good = () => {
    const { events, runId, apiRun, apiDelivery } = baseEvents();
    return judgeA({ events, runId, apiRun, apiDelivery, allowedTools });
  };
  return [
    { name: "happy path -> pass", expect: "pass", run: good },
    {
      name: "fixture provider -> fail",
      expect: "fail",
      run: () => {
        const { events, runId, apiRun, apiDelivery } = baseEvents();
        events[1].providerId = "fixture";
        return judgeA({ events, runId, apiRun, apiDelivery, allowedTools });
      },
    },
    {
      name: "missing ingress -> blocker",
      expect: "blocker",
      run: () => {
        const { events, runId, apiRun, apiDelivery } = baseEvents();
        return judgeA({ events: events.slice(1), runId, apiRun, apiDelivery, allowedTools });
      },
    },
    {
      name: "reply not accepted -> fail",
      expect: "fail",
      run: () => {
        const { events, runId, apiRun, apiDelivery } = baseEvents();
        events[2].status = "failed";
        return judgeA({ events, runId, apiRun, apiDelivery, allowedTools });
      },
    },
    {
      name: "tool outside whitelist -> fail",
      expect: "fail",
      run: () => {
        const { events, runId, apiRun, apiDelivery } = baseEvents();
        events[1].tools = { exposed: ["mcp__guanlan__guanlan_news_decide"] };
        return judgeA({
          events,
          runId,
          apiRun,
          apiDelivery,
          allowedTools: ["mcp__guanlan__guanlan_news_recent"],
        });
      },
    },
    {
      name: "no API readback -> blocker",
      expect: "blocker",
      run: () => {
        const { events, runId, apiRun, apiDelivery } = baseEvents();
        return judgeA({ events, runId, apiRun: null, apiDelivery, allowedTools });
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

function hasScript(name) {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return Boolean(pkg.scripts && pkg.scripts[name]);
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(
    process.argv.slice(2),
    {
      values: {
        "--api": "api",
        "--evidence-in": "evidenceIn",
        "--run-id": "runId",
        "--evidence": "evidence",
        "--timeout-ms": "timeoutMs",
        "--allowed-tool": "allowedTools[]",
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

  const evidenceIn = options.evidenceIn ?? join(ROOT, "poc", "evidence", "agt-036-live.jsonl");
  const evidenceOut = options.evidence ?? join(ROOT, "poc", "evidence", "agt-03x-scenario-a.jsonl");
  const evidence = createEvidence(evidenceOut, { scenario: SCENARIO });
  const allowedTools = options.allowedTools ?? [];
  evidence.emit({
    event: "start",
    mode: options.offline ? "offline" : options.dryRun ? "dry-run" : "real",
    detail: `head=${gitHead() ?? "unknown"}`,
    tools: { exposed: allowedTools },
  });

  if (options.offline) {
    const { ok, rows } = runSelfTest(selfTestCases());
    for (const row of rows) {
      evidence.emit({
        event: "self-test",
        status: row.pass ? "pass" : "fail",
        detail: `${row.name} expect=${row.expect} actual=${row.actual}`,
      });
    }
    return report(evidence, {
      scenario: SCENARIO,
      mode: "offline",
      checks: [
        check("self-test", ok ? "pass" : "fail", `${rows.filter((row) => row.pass).length}/${rows.length} bundled cases matched`),
        check("A1-A5", "blocker", "offline self-test only; no real WeCom evidence was collected"),
      ],
      extra: { channel: "wecom" },
    }).exitCode;
  }

  // Real-mode gates. Order matters: capability first (it explains why the
  // credential names may change), then the precondition checklist, then inputs.
  const gates = [];
  const driverPresent = hasScript("wecom:live");
  if (!driverPresent) {
    gates.push(check("capability", "blocker", "npm run wecom:live absent; t6 must deliver the WeCom driver first"));
  }
  for (const item of unmetFor("A")) {
    gates.push(check(`pre-${item.id}`, "blocker", item.reason ?? item.title));
  }
  if (!existsSync(evidenceIn)) {
    gates.push(check("evidence-in", "blocker", `evidence file not found: ${relative(ROOT, evidenceIn)}`));
  }
  if (gates.length > 0) {
    for (const gate of gates) evidence.emit(gate);
    process.stderr.write(
      [
        "Scenario A cannot run yet (fail-closed, nothing was sent):",
        ...gates.map((gate) => `  - ${gate.check}: ${gate.detail}`),
        "",
      ].join("\n"),
    );
    return report(evidence, {
      scenario: SCENARIO,
      mode: options.dryRun ? "dry-run" : "real",
      checks: gates,
      extra: { channel: "wecom" },
    }).exitCode;
  }

  if (options.dryRun) {
    const plan = [
      `driver: npm run wecom:live (produces ${relative(ROOT, evidenceIn)})`,
      `readback: ${options.api ?? "<no --api>"}`,
      `judge: A1-A5 over ${relative(ROOT, evidenceIn)}`,
    ];
    evidence.emit({ event: "plan", mode: "dry-run", detail: plan.join(" ; ") });
    return report(evidence, {
      scenario: SCENARIO,
      mode: "dry-run",
      checks: [check("A1-A5", "blocker", "dry-run only; nothing executed")],
      extra: { channel: "wecom" },
    }).exitCode;
  }

  const events = readJsonl(evidenceIn);
  const runId = options.runId ?? ingressEvents(events).at(-1)?.runId ?? null;
  let apiRun = null;
  let apiDelivery;
  if (options.api && runId) {
    const base = options.api.replace(/\/$/, "");
    const runResponse = await fetchJson(`${base}/runs/${encodeURIComponent(runId)}`);
    apiRun = runResponse.status === 200 ? (runResponse.body?.data?.run ?? null) : null;
    const deliveryResponse = await fetchJson(`${base}/runs/${encodeURIComponent(runId)}/delivery`);
    apiDelivery = deliveryResponse.status === 200 ? (deliveryResponse.body?.data?.delivery ?? null) : null;
    evidence.emit({
      event: "readback",
      status: apiRun ? "ok" : "missing",
      detail: `runs=${runResponse.status} delivery=${deliveryResponse.status}`,
    });
  }

  const checks = judgeA({ events, runId, apiRun, apiDelivery, allowedTools });
  return report(evidence, { scenario: SCENARIO, mode: "real", checks, extra: { channel: "wecom" } }).exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof UsageError) {
    writeUsage(`${error.message}\n${USAGE}`);
    process.exitCode = EXIT.USAGE;
  } else {
    process.stderr.write(`scenario A failed: ${error?.message ?? error}\n`);
    process.exitCode = EXIT.FAIL;
  }
}
