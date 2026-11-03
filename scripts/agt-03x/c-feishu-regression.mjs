#!/usr/bin/env node
/**
 * Scenario C — 飞书回归（不得退化）验收执行脚本。
 *
 *   node scripts/agt-03x/c-feishu-regression.mjs            # 离线套件 + 代码检查
 *   node scripts/agt-03x/c-feishu-regression.mjs --full     # 追加全量测试
 *   node scripts/agt-03x/c-feishu-regression.mjs --live     # 真实飞书往返（需凭证）
 *
 * C1/C2/C5/C6 离线即可执行，跑的是真实的 `node --test` 套件与真实的源码扫描，
 * 不是 fixture 结论；C4 需要 `FEISHU_APP_ID`/`FEISHU_APP_SECRET` 与真人发消息，
 * 缺凭证时返回 `blocker`，绝不返回 pass。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  EXIT,
  ROOT,
  UsageError,
  check,
  createEvidence,
  failingTests,
  gitHead,
  nowIso,
  parseArgs,
  parseTestSummary,
  report,
  runCommand,
  writeUsage,
} from "./lib/harness.mjs";
import { fullSuiteVerdict } from "./lib/judge.mjs";

const SCENARIO = "C";
const USAGE = `usage: node scripts/agt-03x/c-feishu-regression.mjs [--offline] [--full] [--live]
       [--evidence <out.jsonl>] [--timeout-ms N]`;

/**
 * Baseline §4 counts. They are minimums, not targets: adding tests is fine,
 * silently losing them is a regression.
 */
const SUITES = Object.freeze([
  {
    id: "C1",
    label: "feishu",
    files: ["tests/agt-029-*.test.mjs"],
    min: 48,
    timeoutMs: 180_000,
  },
  { id: "C2-api", label: "api", files: ["tests/agt-034-*.test.mjs"], min: 26, timeoutMs: 180_000 },
  { id: "C2-scheduler", label: "scheduler", files: ["tests/scheduler-t*.test.mjs"], min: 31, timeoutMs: 180_000 },
  { id: "C2-targets", label: "targets", files: ["tests/agt-035-*.test.mjs"], min: 29, timeoutMs: 120_000 },
  {
    id: "C5",
    label: "policy+dedupe",
    files: ["tests/agt-029-policy.test.mjs", "tests/agt-029-dedupe.test.mjs"],
    min: 11,
    timeoutMs: 120_000,
  },
]);

/**
 * The two Windows-only test defects recorded in baseline §4; cleared by t7.
 * TAP reports the enclosing describe name for the second one, so both the
 * parent and the inner title are accepted. The patterns and the expected failure
 * count live in `lib/judge.mjs`, which is unit-tested by `self-test.mjs`.
 */
function tap(file, timeoutMs) {
  const result = runCommand({ label: file, argv: ["node", "--test", "--test-reporter=tap", file], timeoutMs });
  const text = `${result.stdout}\n${result.stderr}`;
  return { result, text, summary: parseTestSummary(text), failing: failingTests(text) };
}

function suiteCheck(suite, evidence) {
  const results = suite.files.map((file) => tap(file, suite.timeoutMs ?? 180_000));
  const missing = results.filter((entry) => entry.summary === null);
  const totals = results.reduce(
    (acc, entry) => ({
      tests: acc.tests + (entry.summary?.tests ?? 0),
      pass: acc.pass + (entry.summary?.pass ?? 0),
      fail: acc.fail + (entry.summary?.fail ?? 0),
      durationMs: acc.durationMs + (entry.summary?.durationMs ?? 0),
    }),
    { tests: 0, pass: 0, fail: 0, durationMs: 0 },
  );
  const failing = results.flatMap((entry) => entry.failing);
  let verdict;
  if (missing.length > 0) {
    verdict = check(suite.id, "fail", `${suite.label}: no TAP summary for ${missing.length} file(s); suite did not run`);
  } else if (totals.fail > 0) {
    verdict = check(suite.id, "fail", `${suite.label}: fail=${totals.fail} (${failing.slice(0, 2).join(" | ")})`);
  } else if (totals.tests < suite.min) {
    verdict = check(suite.id, "fail", `${suite.label}: tests=${totals.tests} < baseline ${suite.min}`);
  } else {
    verdict = check(suite.id, "pass", `${suite.label}: tests=${totals.tests} fail=0 duration_ms=${Math.round(totals.durationMs)}`);
  }
  evidence.emit({
    event: "suite",
    check: suite.id,
    status: verdict.status,
    durationMs: Math.round(totals.durationMs),
    detail: `${suite.label}: tests=${totals.tests} fail=${totals.fail} exit=${results.map((entry) => entry.result.exitCode).join("/")}`,
  });
  return verdict;
}

/** C6 — `createAgentSession` must stay confined to the existing runtime surface. */
const ALLOWED_SESSION_FILES = new Set(["src/runtime.mjs", "src/research/port.mjs"]);

function scanAgentSession() {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.mjs$/.test(entry.name)) continue;
      const relativePath = relative(ROOT, full).split("\\").join("/");
      const text = readFileSync(full, "utf8");
      if (/\bcreateAgentSession\s*\(/.test(text) && !ALLOWED_SESSION_FILES.has(relativePath)) hits.push(relativePath);
    }
  };
  walk(join(ROOT, "src"));
  return hits;
}

function fullSuiteCheck(evidence, timeoutMs) {
  const result = runCommand({ label: "full", argv: ["node", "--test", "--test-reporter=tap", "tests/**/*.test.mjs"], timeoutMs });
  const text = `${result.stdout}\n${result.stderr}`;
  const summary = parseTestSummary(text);
  const failing = failingTests(text);
  // Both the failure count and the failure names are asserted: a name-only
  // check would accept a new failure whose title contains a known substring.
  const verdict = summary
    ? fullSuiteVerdict({ tests: summary.tests, fail: summary.fail, failing })
    : check("C3", "fail", "full suite produced no TAP summary");
  // The suite record carries the judged status (not the raw non-zero failure
  // count), so an audited JSONL never shows "fail" next to a passing gate.
  evidence.emit({
    event: "suite",
    check: "C3",
    status: verdict.status,
    durationMs: summary?.durationMs ? Math.round(summary.durationMs) : 0,
    detail: `tests=${summary?.tests ?? 0} fail=${summary?.fail ?? "?"} exit=${result.exitCode}`,
  });
  return verdict;
}

async function liveCheck(evidence, timeoutMs) {
  const missing = ["FEISHU_APP_ID", "FEISHU_APP_SECRET"].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return check("C4", "blocker", `missing env: ${missing.join(", ")}; live Feishu roundtrip not executed`);
  }
  const result = runCommand({
    label: "feishu-live",
    argv: ["node", "scripts/feishu-live-poc.mjs", "--expect", "reply", "--timeout-ms", String(timeoutMs)],
    timeoutMs: timeoutMs + 30_000,
  });
  const output = join(ROOT, "poc", "evidence", "agt-029-live.jsonl");
  const events = existsSync(output)
    ? readFileSync(output, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        })
    : [];
  const sent = events.some((event) => event.kind === "reply.sent" && event.status === "sent");
  const received = events.some((event) => event.kind === "message.received");
  evidence.emit({
    event: "runner",
    check: "C4",
    status: sent && received ? "pass" : "fail",
    durationMs: result.durationMs,
    detail: `exit=${result.exitCode} sent=${sent} received=${received}`,
  });
  if (result.exitCode !== 0) return check("C4", "fail", `feishu-live-poc exit=${result.exitCode}: ${result.tail}`);
  if (!received || !sent) return check("C4", "fail", "live evidence missing a received message or an accepted reply");
  return check("C4", "pass", "real Feishu roundtrip recorded in poc/evidence/agt-029-live.jsonl");
}

async function main() {
  const options = parseArgs(
    process.argv.slice(2),
    { values: { "--evidence": "evidence", "--timeout-ms": "timeoutMs" }, flags: { "--offline": "offline", "--full": "full", "--live": "live" } },
    { usage: USAGE },
  );
  if (options.help) {
    writeUsage(USAGE);
    return EXIT.PASS;
  }
  if (options.offline && (options.full || options.live)) {
    throw new UsageError("--offline cannot be combined with --full or --live");
  }
  const timeoutMs = Number(options.timeoutMs ?? 180_000);
  const evidence = createEvidence(options.evidence ?? join(ROOT, "poc", "evidence", "agt-03x-scenario-c.jsonl"), {
    scenario: SCENARIO,
  });
  evidence.emit({
    event: "start",
    mode: options.live ? "live" : options.full ? "full" : "offline",
    detail: `head=${gitHead() ?? "unknown"} at=${nowIso()}`,
  });

  const checks = [];

  // C1/C2/C5 - real offline suites, executed now.
  for (const suite of SUITES) checks.push(suiteCheck(suite, evidence));

  // C6 - shared runtime surface.
  const hits = scanAgentSession();
  checks.push(
    hits.length === 0
      ? check("C6", "pass", `createAgentSession confined to ${[...ALLOWED_SESSION_FILES].join(", ")}`)
      : check("C6", "fail", `createAgentSession appeared in: ${hits.slice(0, 3).join(", ")}`),
  );

  // C3 - full suite, only when asked (slow and known to have 2 Windows defects).
  if (options.full) checks.push(fullSuiteCheck(evidence, 600_000));
  else {
    evidence.emit({ event: "skip", check: "C3", status: "blocker", detail: "--full not requested" });
    checks.push(check("C3", "blocker", "not executed (pass --full; ~30s, needs the Guanlan fixture)"));
  }

  // C4 - real Feishu roundtrip, needs credentials + a human sending a message.
  if (options.live) checks.push(await liveCheck(evidence, timeoutMs));
  else {
    evidence.emit({ event: "skip", check: "C4", status: "blocker", detail: "--live not requested" });
    checks.push(check("C4", "blocker", "not executed (pass --live with Feishu credentials and send one message)"));
  }

  return report(evidence, {
    scenario: SCENARIO,
    mode: options.live ? "live" : options.full ? "full" : "offline",
    checks,
    extra: { channel: "feishu" },
  }).exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof UsageError) {
    writeUsage(`${error.message}\n${USAGE}`);
    process.exitCode = EXIT.USAGE;
  } else {
    process.stderr.write(`scenario C failed: ${error?.message ?? error}\n`);
    process.exitCode = EXIT.FAIL;
  }
}
