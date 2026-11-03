#!/usr/bin/env node
/**
 * Read-only file:line claim checker used by the agt-03x external review.
 *
 * Usage:
 *   node scripts/review/file-line-check.mjs <repoRoot> <checks.json>
 *
 * Each check asserts that lines [from, to] (1-based, inclusive) of
 * <repoRoot>/<file> match the regular expression `re`. It never writes to the
 * repository and is not referenced by any product code or test script; it only
 * makes the review document's `path:line` sampling reproducible.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [root, checksPath] = process.argv.slice(2);
if (!root || !checksPath) {
  console.error("usage: node scripts/review/file-line-check.mjs <repoRoot> <checks.json>");
  process.exit(2);
}

const checks = JSON.parse(readFileSync(checksPath, "utf8"));
let pass = 0;
let fail = 0;

for (const check of checks) {
  const full = join(root, check.file);
  const range = `${check.file}:${check.from}-${check.to}`;
  if (!existsSync(full)) {
    fail += 1;
    console.log(JSON.stringify({ id: check.id, status: "FAIL", range, reason: "file missing" }));
    continue;
  }
  const lines = readFileSync(full, "utf8").split(/\r?\n/);
  const from = Math.max(1, check.from);
  const to = Math.min(lines.length, check.to ?? check.from);
  const slice = lines.slice(from - 1, to).join("\n");
  if (new RegExp(check.re, "i").test(slice)) {
    pass += 1;
    console.log(JSON.stringify({ id: check.id, status: "PASS", range }));
  } else {
    fail += 1;
    console.log(
      JSON.stringify({
        id: check.id,
        status: "FAIL",
        range,
        expected: check.re,
        actual: lines.slice(from - 1, Math.min(to, from + 2)).join(" | ").slice(0, 200),
      }),
    );
  }
}

console.log(JSON.stringify({ summary: { total: checks.length, pass, fail } }));
process.exitCode = fail === 0 ? 0 : 1;
