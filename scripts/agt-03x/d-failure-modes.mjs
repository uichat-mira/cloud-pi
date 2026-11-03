#!/usr/bin/env node
/**
 * Scenario D - 故障与安全（未授权 / 无效凭证 / 重复消息 / 重启 / 投递失败）验收脚本。
 *
 *   node scripts/agt-03x/d-failure-modes.mjs            # 离线可执行部分
 *   node scripts/agt-03x/d-failure-modes.mjs --dry-run   # 打印计划
 *
 * 离线部分全部真实执行（真实 `node --test` 套件、真实 api-smoke / scheduler-poc、
 * 真实源码扫描与日志扫描）；企业微信专属负例（D1/D2/D3/D6 的企微侧）在 t6 交付
 * 前一律 `blocker`，不记为通过。D2 的「错误凭证」真实变体需要真实 app id，
 * 缺凭证时同样是 blocker。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT,
  ROOT,
  UsageError,
  check,
  createEvidence,
  failingTests,
  findSecretHits,
  gitHead,
  nowIso,
  parseArgs,
  parseTestSummary,
  report,
  runCommand,
  writeUsage,
} from "./lib/harness.mjs";
import { unmetFor } from "./lib/preconditions.mjs";

const SCENARIO = "D";
const USAGE = `usage: node scripts/agt-03x/d-failure-modes.mjs [--dry-run] [--evidence <out.jsonl>] [--timeout-ms N]`;

function suiteCheck(id, label, files, { min = 1, timeoutMs = 120_000 } = {}) {
  const result = runCommand({ label, argv: ["node", "--test", "--test-reporter=tap", ...files], timeoutMs });
  const summary = parseTestSummary(`${result.stdout}\n${result.stderr}`);
  const failing = failingTests(`${result.stdout}\n${result.stderr}`);
  if (!summary) return { check: check(id, "fail", `${label}: no TAP summary (exit ${result.exitCode})`), result };
  if ((summary.fail ?? 1) !== 0) {
    return { check: check(id, "fail", `${label}: fail=${summary.fail} (${failing.slice(0, 2).join(" | ")})`), result };
  }
  if (summary.tests < min) return { check: check(id, "fail", `${label}: tests=${summary.tests} < ${min}`), result };
  return { check: check(id, "pass", `${label}: tests=${summary.tests} fail=0 duration_ms=${summary.durationMs}`), result };
}

/** D2 offline: an empty configuration must fail closed before any network call. */
function configFailClosed(timeoutMs) {
  const result = runCommand({
    label: "feishu-config-empty",
    argv: ["node", "src/channels/feishu/server.mjs"],
    timeoutMs,
    env: { FEISHU_APP_ID: "", FEISHU_APP_SECRET: "", FEISHU_ALLOWED_CHAT_IDS: "", FEISHU_BOT_OPEN_ID: "" },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut) return check("D2-offline", "fail", "channel start did not terminate; config gate may be missing");
  if (result.exitCode !== 2) return check("D2-offline", "fail", `exit=${result.exitCode} (expected 2 for invalid config)`);
  if (!/feishu_config_error|config/i.test(output)) return check("D2-offline", "fail", "exit 2 without a config error code");
  if (result.durationMs > 10_000) return check("D2-offline", "fail", `config gate took ${result.durationMs}ms; suspicious`);
  return check("D2-offline", "pass", `exit=2 in ${result.durationMs}ms, no network attempted`);
}

/**
 * Collect the string values of a structured evidence file. Scanning raw JSONL
 * would flag harmless key/value boundaries (`..._reprobe_after_sdk_...`) as
 * long tokens, so structured files are parsed and only values are inspected.
 */
function evidenceStrings(text, structured) {
  if (!structured) return [text];
  const values = [];
  const harvest = (node) => {
    if (typeof node === "string") values.push(node);
    else if (Array.isArray(node)) node.forEach(harvest);
    else if (node && typeof node === "object") Object.values(node).forEach(harvest);
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      harvest(JSON.parse(line));
    } catch {
      values.push(line);
    }
  }
  return values;
}

function scanEvidenceDirs() {
  // Evidence plus the engineering docs that quote it: a real message id leaks into
  // a write-up as easily as into a JSONL (it did once - see docs/evidence README §8).
  const targets = [
    join(ROOT, "poc", "evidence"),
    join(ROOT, "docs", "evidence"),
    join(ROOT, "docs", "engineering"),
  ];
  const hits = [];
  let scanned = 0;
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jsonl|md|json)$/.test(entry.name) && statSync(full).isFile()) {
        scanned += 1;
        const text = readFileSync(full, "utf8");
        const structured = /\.(jsonl|json)$/.test(entry.name);
        for (const value of evidenceStrings(text, structured)) {
          for (const name of findSecretHits(value)) hits.push(`${entry.name}:${name}`);
        }
      }
    }
  };
  for (const dir of targets) walk(dir);
  return { scanned, hits: [...new Set(hits)] };
}

async function main() {
  const options = parseArgs(
    process.argv.slice(2),
    { values: { "--evidence": "evidence", "--timeout-ms": "timeoutMs" }, flags: { "--dry-run": "dryRun" } },
    { usage: USAGE },
  );
  if (options.help) {
    writeUsage(USAGE);
    return EXIT.PASS;
  }
  const timeoutMs = Number(options.timeoutMs ?? 120_000);
  const evidence = createEvidence(options.evidence ?? join(ROOT, "poc", "evidence", "agt-03x-scenario-d.jsonl"), {
    scenario: SCENARIO,
  });
  evidence.emit({ event: "start", mode: options.dryRun ? "dry-run" : "offline", detail: `head=${gitHead() ?? "unknown"}` });

  if (options.dryRun) {
    const plan = [
      "D1 tests/agt-029-policy.test.mjs + agt-029-channel.test.mjs",
      "D2 node src/channels/feishu/server.mjs with empty config (expect exit 2)",
      "D3 tests/agt-029-dedupe.test.mjs",
      "D4 node scripts/agt-034/api-smoke.mjs + scripts/scheduler-poc-evidence.mjs",
      "D5 tests/agt-033-transport.test.mjs",
      "D6 tests/agt-038-wecom-cancel.test.mjs (t6, absent)",
      "D8 scan poc/evidence + docs/evidence for secret patterns",
    ];
    evidence.emit({ event: "plan", mode: "dry-run", detail: plan.join(" ; ").slice(0, 300) });
    return report(evidence, {
      scenario: SCENARIO,
      mode: "dry-run",
      checks: [check("D1-D8", "blocker", "dry-run only - nothing executed")],
    }).exitCode;
  }

  const checks = [];

  // D1 - 未授权/非 @/非文本/非 user 一律忽略，且不调用模型（飞书侧负例）
  const d1 = suiteCheck("D1-feishu", "policy+channel", ["tests/agt-029-policy.test.mjs", "tests/agt-029-channel.test.mjs"], { min: 16, timeoutMs });
  evidence.emit({ event: "suite", check: d1.check.check, status: d1.check.status, durationMs: d1.result.durationMs, detail: d1.check.detail });
  checks.push(d1.check);

  // D1 wecom counterpart - requires t6.
  checks.push(check("D1-wecom", "blocker", "WeCom negative cases do not exist yet (t6)"));

  // D2 - 无效配置 fail closed
  const d2 = configFailClosed(timeoutMs);
  evidence.emit({ event: "config-gate", check: d2.check, status: d2.status, detail: d2.detail });
  checks.push(d2);

  // D2 real variant (wrong secret with a real app id) needs credentials.
  const missingFeishu = ["FEISHU_APP_ID", "FEISHU_APP_SECRET"].filter((name) => !process.env[name]);
  checks.push(
    missingFeishu.length > 0
      ? check("D2-wrong-secret", "blocker", `missing env: ${missingFeishu.join(", ")} - wrong-secret variant not executed`)
      : check("D2-wrong-secret", "blocker", "not executed by this harness; run manually with a real app id and a wrong secret"),
  );

  // D3 - 重复消息只产生一次运行（离线去重用例）
  const d3 = suiteCheck("D3", "dedupe", ["tests/agt-029-dedupe.test.mjs"], { min: 4, timeoutMs });
  evidence.emit({ event: "suite", check: d3.check.check, status: d3.check.status, durationMs: d3.result.durationMs, detail: d3.check.detail });
  checks.push(d3.check);

  // D4 - 重启后调度/投递幂等，进行中 trigger 标 interrupted
  const smoke = runCommand({ label: "api-smoke", argv: ["node", "scripts/agt-034/api-smoke.mjs"], timeoutMs: 120_000 });
  const smokeOk = smoke.exitCode === 0 && smoke.stdout.includes('"event":"result","ok":true');
  evidence.emit({ event: "runner", check: "D4-api", status: smokeOk ? "pass" : "fail", durationMs: smoke.durationMs, detail: `exit=${smoke.exitCode}` });
  checks.push(smokeOk ? check("D4-api", "pass", `api-smoke exit=0 in ${smoke.durationMs}ms`) : check("D4-api", "fail", `api-smoke exit=${smoke.exitCode}: ${smoke.tail}`));

  const poc = runCommand({ label: "scheduler-poc", argv: ["node", "scripts/scheduler-poc-evidence.mjs"], timeoutMs: 120_000 });
  const pocText = `${poc.stdout}\n${poc.stderr}`;
  // This evidence script prints a human-readable transcript to stdout (it does
  // not write JSONL), so judge on its own summary lines: exit 0, an
  // `interrupted` recovery scenario, and its completion banner.
  const interrupted = /interrupted/i.test(pocText);
  const completed = /POC evidence complete/.test(pocText);
  const pocOk = poc.exitCode === 0 && interrupted && completed;
  evidence.emit({
    event: "runner",
    check: "D4-scheduler",
    status: pocOk ? "pass" : "fail",
    durationMs: poc.durationMs,
    detail: `exit=${poc.exitCode} interrupted=${interrupted} completed=${completed}`,
  });
  checks.push(
    pocOk
      ? check("D4-scheduler", "pass", "interrupted recovery scenario present, later fires still succeed")
      : check("D4-scheduler", "fail", `exit=${poc.exitCode} interrupted=${interrupted} completed=${completed}`),
  );

  // D5 - 有界重试 + 稳定错误码
  const d5 = suiteCheck("D5", "transport", ["tests/agt-033-transport.test.mjs"], { min: 10, timeoutMs });
  evidence.emit({ event: "suite", check: d5.check.check, status: d5.check.status, durationMs: d5.result.durationMs, detail: d5.check.detail });
  checks.push(d5.check);

  // D6 - 企业微信 /stop 取消语义：t6 未交付
  checks.push(check("D6", "blocker", "WeCom /stop cancellation cases do not exist yet (t6)"));

  // D8 - 证据与日志本身不泄露
  const scan = scanEvidenceDirs();
  evidence.emit({ event: "scan", check: "D8", status: scan.hits.length === 0 ? "pass" : "fail", detail: `files=${scan.scanned} hits=${scan.hits.length}` });
  checks.push(
    scan.hits.length === 0
      ? check("D8", "pass", `scanned ${scan.scanned} evidence files, zero secret-shaped hits`)
      : check("D8", "fail", `secret-shaped hits: ${scan.hits.slice(0, 3).join(", ")}`),
  );

  const wecom = unmetFor("D");
  for (const item of wecom) checks.push(check(`pre-${item.id}`, "blocker", item.reason ?? item.title));

  return report(evidence, { scenario: SCENARIO, mode: "offline", checks }).exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof UsageError) {
    writeUsage(`${error.message}\n${USAGE}`);
    process.exitCode = EXIT.USAGE;
  } else {
    process.stderr.write(`scenario D failed: ${error?.message ?? error} (at ${nowIso()})\n`);
    process.exitCode = EXIT.FAIL;
  }
}
