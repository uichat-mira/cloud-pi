/** AGT-036: a live delivery probe must never leave an armed or orphaned schedule. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "agt-036", "delivery-live.mjs");

async function runProbe(root, extra = []) {
  const stateDir = join(root, "probe-state");
  const evidence = join(root, "evidence.jsonl");
  const args = [
    SCRIPT,
    "--self-test",
    `--state-dir=${stateDir}`,
    `--evidence=${evidence}`,
    `--secrets=${join(root, "no-secrets.env")}`,
    `--env-file=${join(root, "no-model.env")}`,
    ...extra,
  ];
  const { exitCode, stdout, stderr } = await new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => { clearTimeout(timer); fail(error); });
    child.on("close", (code) => { clearTimeout(timer); done({ exitCode: code, stdout, stderr }); });
  });

  const contents = await readFile(evidence, "utf8").catch((error) => {
    throw new Error(`probe did not write evidence (exit=${exitCode}): stdout=${stdout} stderr=${stderr}`, { cause: error });
  });
  const lines = contents.trim().split("\n").map((line) => JSON.parse(line));
  const report = lines.at(-1);
  const scheduleFiles = await readdir(join(stateDir, "scheduler", "schedules")).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return { exitCode, stdout, stderr, report, scheduleFiles };
}

for (const mode of [
  { name: "successful self-test", options: [], expectedExit: 0 },
  { name: "failure after manual trigger", options: ["--delivery-timeout-ms=0"], expectedExit: 1 },
]) {
  test(`delivery:live cleans up its disabled one-off schedule after ${mode.name}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cloud-pi-delivery-cleanup-"));
    t.after(async () => rm(root, { recursive: true, force: true }));
    const result = await runProbe(root, mode.options);
    assert.equal(result.exitCode, mode.expectedExit, result.stderr + "\n" + result.stdout);
    assert.equal(result.report.scheduleMode, "paused_once");
    assert.equal(result.report.cleanup?.scheduleDeleted, true);
    assert.equal(result.scheduleFiles.length, 0, "no persisted schedules may be left by the probe");
  });
}
