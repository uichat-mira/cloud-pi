#!/usr/bin/env node
/**
 * 前置清单检查器（scenario A/B 的开跑闸门）。
 *
 *   node scripts/agt-03x/preflight.mjs                 # 人类可读清单
 *   node scripts/agt-03x/preflight.mjs --json          # 机器可读
 *   node scripts/agt-03x/preflight.mjs --check-network # 额外 GET 探测 P2/P4 端点
 *   node scripts/agt-03x/preflight.mjs --scenario A    # 只看 A 需要的项
 *
 * 只检查环境变量的**存在性**与端点可达性，从不读取、打印或转发任何密钥值。
 * 任一项未满足 → exit 3（blocker）。全部满足 → exit 0，且这只代表「可以开始
 * 跑场景」，不代表任何判据通过。
 */
import {
  EXIT,
  UsageError,
  check,
  createEvidence,
  gitHead,
  nowIso,
  parseArgs,
  report,
  writeUsage,
} from "./lib/harness.mjs";
import { evaluatePreconditions, SCENARIO_REQUIREMENTS } from "./lib/preconditions.mjs";

const USAGE = `usage: node scripts/agt-03x/preflight.mjs [--json] [--check-network] [--scenario A|B|C|D]
       [--evidence <out.jsonl>]`;

async function probe(url) {
  if (!url) return { status: "skipped", detail: "no url" };
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(8_000) });
    return { status: response.status < 500 ? "reachable" : "unreachable", detail: `HTTP ${response.status}` };
  } catch (error) {
    return { status: "unreachable", detail: String(error?.cause?.code ?? error?.name ?? "error").slice(0, 60) };
  }
}

async function main() {
  const options = parseArgs(
    process.argv.slice(2),
    {
      values: { "--scenario": "scenario", "--evidence": "evidence" },
      flags: { "--json": "json", "--check-network": "checkNetwork" },
    },
    { usage: USAGE },
  );
  if (options.help) {
    writeUsage(USAGE);
    return EXIT.PASS;
  }
  const scenario = (options.scenario ?? "").toUpperCase();
  if (scenario && !Object.prototype.hasOwnProperty.call(SCENARIO_REQUIREMENTS, scenario)) {
    throw new UsageError("--scenario must be one of A, B, C, D");
  }

  let rows = evaluatePreconditions();
  const required = scenario ? SCENARIO_REQUIREMENTS[scenario] : rows.map((item) => item.id);
  rows = rows.map((item) => ({ ...item, requiredByScenario: required.includes(item.id) }));

  const network = {};
  if (options.checkNetwork) {
    network.P2 = await probe(process.env.CLOUD_AUTH_JWKS_URL);
    network.P4 = await probe(process.env.GUANLAN_MCP_URL);
  }

  if (options.json) {
    const unmetRequired = rows.filter((item) => item.requiredByScenario && item.status !== "met");
    const verdict = unmetRequired.length === 0 ? "ready" : "blocker";
    process.stdout.write(
      `${JSON.stringify(
        {
          at: nowIso(),
          head: gitHead(),
          scenario: scenario || null,
          verdict,
          unmet: unmetRequired.map((item) => item.id),
          rows,
          network,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const lines = [
      `前置清单（${nowIso()}，head ${gitHead() ?? "unknown"}${scenario ? `，场景 ${scenario}` : ""}）`,
      "",
    ];
    for (const item of rows) {
      const mark = item.status === "met" ? "[x]" : "[ ]";
      const scope = item.requiredByScenario ? "" : "（本场景不需要）";
      lines.push(`${mark} ${item.id} ${item.title}${scope}`);
      if (item.reason) lines.push(`      原因：${item.reason}`);
      if (item.note) lines.push(`      说明：${item.note}`);
      if (network[item.id]) lines.push(`      端点：${network[item.id].status} (${network[item.id].detail})`);
      lines.push(`      责任：${item.owner}`);
    }
    const unmetRequired = rows.filter((item) => item.requiredByScenario && item.status !== "met");
    lines.push("");
    lines.push(unmetRequired.length === 0 ? "结论：可以开始跑（未证明任何判据通过）" : `结论：blocker — ${unmetRequired.map((item) => item.id).join(", ")} 未满足`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  const evidence = options.evidence ? createEvidence(options.evidence, { scenario: "preflight" }) : null;
  const checks = rows
    .filter((item) => item.requiredByScenario)
    .map((item) => check(item.id, item.status === "met" ? "pass" : "blocker", item.status === "met" ? "ready" : item.reason));
  for (const item of rows) {
    evidence?.emit({
      event: "precondition",
      check: item.id,
      status: item.status === "met" ? "pass" : "blocker",
      detail: item.status === "met" ? (item.note ?? "ready") : item.reason,
    });
  }
  if (evidence) return report(evidence, { scenario: "preflight", mode: "real", checks }).exitCode;
  return checks.some((item) => item.status !== "pass") ? EXIT.BLOCKER : EXIT.PASS;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof UsageError) {
    writeUsage(`${error.message}\n${USAGE}`);
    process.exitCode = EXIT.USAGE;
  } else {
    process.stderr.write(`preflight failed: ${error?.message ?? error}\n`);
    process.exitCode = EXIT.FAIL;
  }
}
