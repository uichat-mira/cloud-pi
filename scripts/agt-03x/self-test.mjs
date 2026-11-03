#!/usr/bin/env node
/**
 * 离线自测入口：把 A/B/C/D + preflight 的 `--offline` 行为一次性跑完并留证。
 *
 *   node scripts/agt-03x/self-test.mjs            # 默认写 docs/evidence/wecom-v1/offline-selftest.txt
 *   node scripts/agt-03x/self-test.mjs --full     # 追加 C3 全量测试（约 30s）
 *   node scripts/agt-03x/self-test.mjs --no-write # 只打印，不落盘
 *
 * 期望值不是「都退出 0」：离线场景必须返回 blocker（exit 3），真实模式缺凭证
 * 必须 fail-closed（exit 3 且不发送）。自测通过 = 每个脚本都给出了**预期**的
 * 判定与退出码。任何 exit 0 的离线场景都会被判为失败（那意味着伪造了 pass）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT, ROOT, createEvidence, findSecretHits, gitHead, nowIso, parseArgs, writeUsage } from "./lib/harness.mjs";
import { fullSuiteVerdict } from "./lib/judge.mjs";

const USAGE = `usage: node scripts/agt-03x/self-test.mjs [--full] [--no-write] [--out <file>]`;

const CASES = [
  { name: "preflight", argv: ["scripts/agt-03x/preflight.mjs"], expectExit: 3, expect: /结论：blocker/ },
  { name: "preflight/json", argv: ["scripts/agt-03x/preflight.mjs", "--json"], expectExit: 3, expect: /"verdict":\s*"blocker"/ },
  { name: "A/offline", argv: ["scripts/agt-03x/a-wecom-live-reply.mjs", "--offline"], expectExit: 3, expect: /"check":"self-test","status":"pass"/ },
  { name: "A/real-no-creds", argv: ["scripts/agt-03x/a-wecom-live-reply.mjs"], expectExit: 3, expect: /"check":"capability","status":"blocker"/ },
  { name: "B/offline", argv: ["scripts/agt-03x/b-scheduled-research-delivery.mjs", "--offline"], expectExit: 3, expect: /7\/7 bundled cases matched/ },
  { name: "B/real-no-creds", argv: ["scripts/agt-03x/b-scheduled-research-delivery.mjs"], expectExit: 3, expect: /"check":"api","status":"blocker"/ },
  { name: "C/offline", argv: ["scripts/agt-03x/c-feishu-regression.mjs"], expectExit: 3, expect: /"check":"C1","status":"pass"/ },
  { name: "C/all-suites-pass", argv: ["scripts/agt-03x/c-feishu-regression.mjs"], expectExit: 3, expect: /"check":"C5","status":"pass"/ },
  { name: "D/offline", argv: ["scripts/agt-03x/d-failure-modes.mjs"], expectExit: 3, expect: /"check":"D8","status":"pass"/ },
  { name: "D/wecom-absent", argv: ["scripts/agt-03x/d-failure-modes.mjs"], expectExit: 3, expect: /"check":"D1-wecom","status":"blocker"/ },
];

function runCase(testCase) {  const started = Date.now();
  const result = spawnSync(process.execPath, testCase.argv, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const exitOk = result.status === testCase.expectExit;
  const textOk = testCase.expect.test(output);
  const noPass = !/"event":"result"[^\n]*"status":"pass"/.test(output);
  return {
    ...testCase,
    exitCode: result.status,
    durationMs: Date.now() - started,
    pass: exitOk && textOk && noPass,
    output,
  };
}

/**
 * In-process regressions for the judge/writer itself. These exist because the
 * external review found two ways the harness could *look* right and still let
 * an unusable (or leaky) evidence file through:
 *   1. the writer only checked keys/secret shapes, so a WeCom message id or a
 *      chat message pasted into `detail`/`note` was written verbatim;
 *   2. the C3 gate only checked failure *names*, so a new failure whose title
 *      contained a known substring was silently accepted.
 */
function runUnitCases() {
  const dir = mkdtempSync(join(tmpdir(), "agt-03x-unit-"));
  const evidence = createEvidence(join(dir, "probe.jsonl"), { scenario: "unit" });
  const rows = [];
  const reject = (name, record, needle) => {
    try {
      evidence.emit(record);
      rows.push({ name, pass: false, detail: "accepted (must be rejected)" });
    } catch (error) {
      rows.push({ name, pass: needle.test(error.message), detail: error.message });
    }
  };
  const accept = (name, record) => {
    try {
      evidence.emit(record);
      rows.push({ name, pass: true, detail: "accepted" });
    } catch (error) {
      rows.push({ name, pass: false, detail: error.message });
    }
  };
  const c3 = (name, input, expected) => {
    const verdict = fullSuiteVerdict(input);
    rows.push({ name, pass: verdict.status === expected, detail: `${verdict.status}: ${verdict.detail}` });
  };

  // --- F-28-1: value shapes, not just key names ---------------------------
  reject("writer/wecom-message-id", { event: "x", detail: "reply to wmAbCdEf123456 ok" }, /wecom_message_id/);
  reject("writer/chinese-body", { event: "x", detail: "帮我查一下今天的新闻" }, /non-ASCII/);
  reject("writer/feishu-message-id", { event: "x", detail: "om_1a2b3c4d5e6f" }, /feishu_message_id/);
  reject("writer/union-id", { event: "x", detail: "on_9f8e7d6c5b4a" }, /feishu_union_id/);
  reject("writer/long-mixed-token", { event: "x", detail: "AbCdEf0123456789GhIjKlMnOpQrStUvWx" }, /long_token/);
  reject("writer/absolute-path", { event: "x", detail: "D:\\Users\\someone\\secret.txt" }, /absolute_path/);
  // A truncated projection is the sanctioned form; an untruncated id is not. The
  // mask rule lives in the scanner (D8 reads docs, which may use `…`); generated
  // evidence must stay ASCII, so the writer only ever sees the `...` variant.
  accept("writer/ascii-mask", { event: "x", detail: "chat_id=0f3b9e...a9b6 attempts=1" });
  reject("writer/full-chat-id", { event: "x", detail: "chat_id=0f3b9e12ab34cd56ef78a9b6" }, /wecom_chat_id/);
  const scanCase = (name, text, expected) => {
    const hits = findSecretHits(text);
    const ok = expected === 0 ? hits.length === 0 : hits.includes(expected);
    rows.push({ name, pass: ok, detail: hits.length === 0 ? "no hits" : hits.join(",") });
  };
  scanCase("scan/ellipsis-mask-allowed", "chat_id=0f3b9e…a9b6", 0);
  scanCase("scan/ascii-mask-allowed", "chat_id=0f3b9e...a9b6", 0);
  scanCase("scan/full-chat-id-detected", "chat_id=0f3b9e12ab34cd56ef78a9b6", "wecom_chat_id");
  reject("writer/oversized-text", { event: "x", detail: "a".repeat(200) }, /longer than 160/);
  reject("writer/forbidden-key", { event: "x", messageId: "wm123" }, /not on the whitelist/);
  accept("writer/seed-label", { event: "x", note: "seed 数据，非 A2 注册链能力（证据必须原样标注）" });
  accept("writer/ascii-summary", { event: "x", detail: "tests=555 fail=2 exit=1 head=8efc250" });

  // --- F-28-2: the C3 gate asserts the failure *count* -------------------
  const known = [
    "resolveRunsRoot: explicit > env > default",
    "adapter: system prompt and cwd isolation through Pi",
    "research policy reaches the model-visible system prompt",
  ];
  c3("judge/c3-baseline-pass", { tests: 555, fail: 2, failing: known }, "pass");
  c3(
    "judge/c3-third-failure-with-known-title",
    { tests: 555, fail: 3, failing: [...known, "research policy reaches the model-visible system prompt for wecom"] },
    "fail",
  );
  c3("judge/c3-known-defect-fixed", { tests: 555, fail: 1, failing: [known[0]] }, "fail");
  c3("judge/c3-tests-dropped", { tests: 553, fail: 2, failing: known }, "fail");
  c3("judge/c3-unknown-name", { tests: 555, fail: 2, failing: [known[0], "brand new failure"] }, "fail");
  c3("judge/c3-no-summary", { tests: undefined, fail: undefined, failing: [] }, "fail");

  rmSync(dir, { recursive: true, force: true });
  return rows;
}

async function main() {
  const options = parseArgs(
    process.argv.slice(2),
    { values: { "--out": "out" }, flags: { "--full": "full", "--no-write": "noWrite" } },
    { usage: USAGE },
  );
  if (options.help) {
    writeUsage(USAGE);
    return EXIT.PASS;
  }

  const cases = [...CASES];
  if (options.full) {
    cases.push({
      name: "C/full",
      argv: ["scripts/agt-03x/c-feishu-regression.mjs", "--full"],
      expectExit: 3,
      expect: /"check":"C3","status":"pass"/,
    });
  }

  const results = [];
  for (const testCase of cases) {
    process.stderr.write(`running ${testCase.name} ...\n`);
    results.push(runCase(testCase));
  }

  const unitRows = runUnitCases();

  const lines = [
    "# AGT-03x 验收执行包离线自测（真实执行输出，非手写）",
    "",
    `生成时间：${nowIso()}`,
    `HEAD：${gitHead() ?? "unknown"}`,
    `Node：${process.version} / ${process.platform}`,
    "",
    "说明：离线场景的预期退出码是 3（blocker），因为缺凭证时脚本必须 fail-closed；",
    "任何离线场景返回 0 都会被本自测判为失败（那意味着伪造了 pass）。",
    "",
    "| 用例 | 期望退出码 | 实际退出码 | 结果 | 耗时(ms) |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of results) {
    lines.push(`| ${row.name} | ${row.expectExit} | ${row.exitCode} | ${row.pass ? "pass" : "FAIL"} | ${row.durationMs} |`);
  }
  lines.push("");
  for (const row of results) {
    lines.push(`## ${row.name}`, "", `命令：\`node ${row.argv.join(" ")}\``, "", "```", row.output.trim(), "```", "");
  }
  lines.push(
    "## 判定器本身的内建回归（进程内，不 spawn）",
    "",
    "覆盖外审 F-28-1（写入器只校验键 → 现在同时校验值形态）与 F-28-2（C3 只看失败名 → 现在断言失败数量）。",
    "",
    "| 用例 | 结果 | 说明 |",
    "| --- | --- | --- |",
  );
  for (const row of unitRows) {
    lines.push(`| ${row.name} | ${row.pass ? "pass" : "FAIL"} | ${String(row.detail).replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  const report = `${lines.join("\n")}\n`;

  const subprocessFailures = results.filter((row) => !row.pass);
  const unitFailures = unitRows.filter((row) => !row.pass);
  const out = options.out ?? join(ROOT, "docs", "evidence", "wecom-v1", "offline-selftest.txt");
  if (!options.noWrite) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, report, "utf8");
    process.stdout.write(
      `offline self-test: ${results.length - subprocessFailures.length}/${results.length} cases + ` +
        `${unitRows.length - unitFailures.length}/${unitRows.length} judge regressions behaved as expected\n`,
    );
    process.stdout.write(`transcript: ${out}\n`);
  } else {
    process.stdout.write(report);
  }
  for (const row of subprocessFailures) {
    process.stderr.write(`FAIL ${row.name}: exit=${row.exitCode} (expected ${row.expectExit})\n`);
  }
  for (const row of unitFailures) {
    process.stderr.write(`FAIL ${row.name}: ${row.detail}\n`);
  }
  return subprocessFailures.length === 0 && unitFailures.length === 0 ? EXIT.PASS : EXIT.FAIL;
}

process.exitCode = await main();
