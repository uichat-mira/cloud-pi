#!/usr/bin/env node
/**
 * Prepare the isolated Guanlan MCP fixture used by the Cloud Pi P0.
 *
 * Default: clone/build the pinned Guanlan commit into the OS temp directory
 * (`cloud-pi-guanlan`). That directory is owned by this script and may be
 * rebuilt.
 *
 * `GUANLAN_DIR`: an existing checkout supplied by the caller is only ever
 * read. It is reused when it is a clean checkout of the pinned commit with the
 * built fixture already present; otherwise preparation fails and the caller
 * must fix it. The script never runs `git checkout --force`, `git reset`,
 * `npm ci` or a build inside a directory it did not create.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  GUANLAN_COMMIT,
  GUANLAN_REPOSITORY,
  planPreparation,
} from "./guanlan-fixture-plan.mjs";

const REQUIRED_ARTIFACTS = ["dist/mcp-test-worker.mjs", "dist/mcp-fixtures.mjs"];
const MANAGED_DEPENDENCY = "node_modules/miniflare/package.json";
const force = process.argv.includes("--force");
const explicit = Boolean(process.env.GUANLAN_DIR);
const target = resolve(process.env.GUANLAN_DIR ?? join(tmpdir(), "cloud-pi-guanlan"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function git(args, options = {}) {
  return execFileSync("git", ["-C", target, ...args], { encoding: "utf8", ...options }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
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

function dependenciesReady() {
  return existsSync(join(target, MANAGED_DEPENDENCY));
}

function describeState() {
  const exists = existsSync(target);
  const hasGit = exists && existsSync(join(target, ".git"));
  const originUrl = hasGit ? tryGit(["remote", "get-url", "origin"]) : null;
  const head = hasGit ? tryGit(["rev-parse", "HEAD"]) : null;
  const dirty = hasGit ? (tryGit(["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "" : false;
  return { exists, hasGit, originUrl, head, dirty, ready: artifactsReady() && dependenciesReady() };
}

function fail(reason) {
  process.stderr.write(`prepare-guanlan-fixture: ${reason}\n`);
  process.exit(1);
}

const state = describeState();
const plan = planPreparation({ explicit, force, ...state, target });

if (plan.action === "error") {
  fail(plan.reason);
}

if (plan.action === "reuse") {
  process.stderr.write(`Guanlan fixture already prepared at ${target} (${GUANLAN_COMMIT}).\n`);
  process.exit(0);
}

if (plan.action === "clone") {
  mkdirSync(dirname(target), { recursive: true });
  process.stderr.write(`Cloning ${GUANLAN_REPOSITORY} into ${target}...\n`);
  execFileSync("git", ["clone", GUANLAN_REPOSITORY, target], { stdio: "inherit", cwd: process.cwd() });
  git(["checkout", "--force", GUANLAN_COMMIT]);
} else {
  process.stderr.write(`Rebuilding the script-owned fixture at ${target}...\n`);
  git(["fetch", "origin"]);
  git(["checkout", "--force", GUANLAN_COMMIT]);
}

run(npm, ["ci", "--no-audit", "--no-fund"]);
run(npm, ["run", "build"]);

for (const artifact of REQUIRED_ARTIFACTS) {
  if (!existsSync(join(target, artifact))) {
    fail(`Guanlan build did not produce ${artifact} in ${target}`);
  }
}
if (!dependenciesReady()) {
  fail(`Guanlan build did not produce ${MANAGED_DEPENDENCY} in ${target}`);
}

process.stderr.write(`Guanlan fixture ready at ${target} (${GUANLAN_COMMIT}).\n`);
