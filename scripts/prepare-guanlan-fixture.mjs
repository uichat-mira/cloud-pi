#!/usr/bin/env node
/**
 * Prepare the isolated Guanlan MCP fixture used by the Cloud Pi P0.
 *
 * Clones the pinned Guanlan commit into the OS temp directory
 * (`cloud-pi-guanlan`, or `GUANLAN_DIR`), installs its locked dependencies and
 * builds the workerd test worker. The P0 harness imports Miniflare and the
 * built worker from that checkout, so the fixture runs under exactly the
 * runtime and server code Guanlan's own tests pin. The script is idempotent: a
 * matching checkout is left untouched.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPOSITORY = "https://github.com/uichat-mira/cloud-mcp-guanlan.git";
const COMMIT = "3362ef9254be154694cb786fc35921884c62b792";
const REQUIRED_ARTIFACTS = ["dist/mcp-test-worker.mjs", "dist/mcp-fixtures.mjs"];
const force = process.argv.includes("--force");
const target = resolve(process.env.GUANLAN_DIR ?? join(tmpdir(), "cloud-pi-guanlan"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function git(args, options = {}) {
  return execFileSync("git", ["-C", target, ...args], { encoding: "utf8", ...options }).trim();
}

function run(command, args, options = {}) {
  process.stderr.write(`$ ${command} ${args.join(" ")}\n`);
  const [file, fileArgs] =
    process.platform === "win32" && command.endsWith(".cmd")
      ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args]]
      : [command, args];
  execFileSync(file, fileArgs, { stdio: "inherit", cwd: target, ...options });
}

function artifactsReady() {
  return REQUIRED_ARTIFACTS.every((artifact) => existsSync(join(target, artifact)));
}

function currentCommit() {
  try {
    return git(["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

if (!force && artifactsReady() && currentCommit() === COMMIT) {
  process.stderr.write(`Guanlan fixture already prepared at ${target} (${COMMIT}).\n`);
  process.exit(0);
}

if (!existsSync(join(target, ".git"))) {
  mkdirSync(dirname(target), { recursive: true });
  process.stderr.write(`Cloning ${REPOSITORY} into ${target}...\n`);
  run("git", ["clone", REPOSITORY, target], { cwd: process.cwd() });
}

if (currentCommit() !== COMMIT) {
  run("git", ["fetch", "origin"]);
}

// `--force` also restores a worktree left empty by a previous interrupted run.
if (currentCommit() !== COMMIT || !artifactsReady()) {
  process.stderr.write(`Checking out pinned Guanlan commit ${COMMIT}...\n`);
  run("git", ["checkout", "--force", COMMIT]);
}

if (!existsSync(join(target, "package.json"))) {
  throw new Error(`The Guanlan checkout at ${target} has no package.json after checkout`);
}

run(npm, ["ci", "--no-audit", "--no-fund"]);
run(npm, ["run", "build"]);

for (const artifact of REQUIRED_ARTIFACTS) {
  if (!existsSync(join(target, artifact))) {
    throw new Error(`Guanlan build did not produce ${artifact} in ${target}`);
  }
}

process.stderr.write(`Guanlan fixture ready at ${target} (${currentCommit()}).\n`);
