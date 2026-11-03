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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT, ROOT, gitHead, nowIso, parseArgs, writeUsage } from "./lib/harness.mjs";

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

function runCase(testCase) {
  const started = Date.now();
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
  const report = `${lines.join("\n")}\n`;

  const failures = results.filter((row) => !row.pass);
  const out = options.out ?? join(ROOT, "docs", "evidence", "wecom-v1", "offline-selftest.txt");
  if (!options.noWrite) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, report, "utf8");
    process.stdout.write(`offline self-test: ${results.length - failures.length}/${results.length} cases behaved as expected\n`);
    process.stdout.write(`transcript: ${out}\n`);
  } else {
    process.stdout.write(report);
  }
  for (const row of failures) {
    process.stderr.write(`FAIL ${row.name}: exit=${row.exitCode} (expected ${row.expectExit})\n`);
  }
  return failures.length === 0 ? EXIT.PASS : EXIT.FAIL;
}

process.exitCode = await main();
