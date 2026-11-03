/**
 * Local restart/recovery evidence for the AGT-030 scheduler POC.
 *
 * Runs real child processes against real on-disk schedule and research-run
 * stores. The AGT-027 runtime port is a deterministic fixture, so no model,
 * network or credential is involved; the AGT-028 executor and run store are the
 * production modules.
 *
 *   npm run scheduler:poc
 *   npm run scheduler:poc > docs/evidence/agt-030/restart-recovery.txt
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, "scheduler-poc-child.mjs");
const root = await mkdtemp(join(tmpdir(), "cloud-pi-agt-030-evidence-"));
const clean = join(root, "clean-restart");
const crash = join(root, "crash-recovery");

function run(args, expectedCodes = [0]) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [child, ...args], {
      cwd: join(here, ".."),
      env: { ...process.env, TZ: "UTC" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (!expectedCodes.includes(code)) {
        reject(new Error(`child exited ${code}; stderr=${stderr}\nstdout=${stdout}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function heading(title) {
  console.log("=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

try {
  heading("AGT-030 scheduler POC local restart/recovery evidence");
  console.log(`node: ${process.version}`);
  console.log(`TZ: UTC (child processes); schedule timezone: Asia/Shanghai`);
  console.log(`evidence root: ${root}`);
  console.log("");

  heading("Scenario A: definitions survive a clean process restart");
  console.log("$ node scripts/scheduler-poc-child.mjs --phase seed --created-at 2026-11-03T00:55:00Z --now 2026-11-03T01:00:00Z");
  const seed = await run([
    "--phase",
    "seed",
    "--state",
    join(clean, "scheduler"),
    "--runs",
    join(clean, "runs"),
    "--created-at",
    "2026-11-03T00:55:00Z",
    "--now",
    "2026-11-03T01:00:00Z",
  ]);
  console.log(seed.stdout.trim());
  if (seed.stderr.trim()) console.log(`stderr: ${seed.stderr.trim()}`);
  console.log("");

  console.log("$ node scripts/scheduler-poc-child.mjs --phase resume --now 2026-11-04T01:00:00Z");
  const resume = await run([
    "--phase",
    "resume",
    "--state",
    join(clean, "scheduler"),
    "--runs",
    join(clean, "runs"),
    "--now",
    "2026-11-04T01:00:00Z",
  ]);
  console.log(resume.stdout.trim());
  if (resume.stderr.trim()) console.log(`stderr: ${resume.stderr.trim()}`);
  console.log("");

  heading("Scenario B: a hard exit mid-run is recovered as interrupted, then the next fire runs");
  console.log("$ node scripts/scheduler-poc-child.mjs --phase crash --created-at 2026-11-03T00:55:00Z --now 2026-11-03T01:00:00Z");
  const crashed = await run(
    [
      "--phase",
      "crash",
      "--state",
      join(crash, "scheduler"),
      "--runs",
      join(crash, "runs"),
      "--created-at",
      "2026-11-03T00:55:00Z",
      "--now",
      "2026-11-03T01:00:00Z",
    ],
    [42],
  );
  console.log(`child exit code: ${crashed.code} (expected hard exit)`);
  console.log(crashed.stdout.trim());
  if (crashed.stderr.trim()) console.log(`stderr: ${crashed.stderr.trim()}`);
  console.log("");

  console.log("$ node scripts/scheduler-poc-child.mjs --phase resume --now 2026-11-04T01:00:00Z");
  const recovered = await run([
    "--phase",
    "resume",
    "--state",
    join(crash, "scheduler"),
    "--runs",
    join(crash, "runs"),
    "--now",
    "2026-11-04T01:00:00Z",
  ]);
  console.log(recovered.stdout.trim());
  if (recovered.stderr.trim()) console.log(`stderr: ${recovered.stderr.trim()}`);
  console.log("");
  console.log("POC evidence complete: no real model or network call was made.");
} finally {
  await rm(root, { recursive: true, force: true });
}
