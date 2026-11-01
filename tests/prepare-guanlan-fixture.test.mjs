/**
 * Safety regression for `scripts/prepare-guanlan-fixture.mjs`.
 *
 * The P0 `pretest` hook runs the preparation script automatically. A
 * `GUANLAN_DIR` supplied by a developer may point at a real Guanlan worktree,
 * so preparation must only read it: it may not reset, rebuild or otherwise
 * modify an external checkout. These tests use a throwaway repository and the
 * real script; they never touch a real development worktree.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GUANLAN_COMMIT, GUANLAN_REPOSITORY, planPreparation } from "../scripts/guanlan-fixture-plan.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/prepare-guanlan-fixture.mjs", import.meta.url));
const TARGET = "/tmp/cloud-pi-guanlan";

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

const external = {
  explicit: true,
  force: false,
  exists: true,
  hasGit: true,
  originUrl: GUANLAN_REPOSITORY,
  head: GUANLAN_COMMIT,
  dirty: false,
  ready: true,
  target: TARGET,
};

describe("prepare-guanlan-fixture: external GUANLAN_DIR is read-only", () => {
  test("reuses a clean checkout at the pinned commit with the built fixture", () => {
    assert.deepEqual(planPreparation(external), { action: "reuse", dir: TARGET });
  });

  test("refuses a checkout at another commit", () => {
    const plan = planPreparation({ ...external, head: "0000000000000000000000000000000000000000" });
    assert.equal(plan.action, "error");
    assert.match(plan.reason, /pinned/);
    assert.match(plan.reason, /refusing/);
  });

  test("refuses a checkout with uncommitted tracked changes", () => {
    const plan = planPreparation({ ...external, dirty: true });
    assert.equal(plan.action, "error");
    assert.match(plan.reason, /uncommitted/);
  });

  test("refuses to build inside a checkout without the built fixture", () => {
    const plan = planPreparation({ ...external, ready: false });
    assert.equal(plan.action, "error");
    assert.match(plan.reason, /npm ci/);
  });

  test("refuses --force against an external checkout", () => {
    const plan = planPreparation({ ...external, force: true });
    assert.equal(plan.action, "error");
    assert.match(plan.reason, /--force/);
  });

  test("refuses a missing GUANLAN_DIR instead of creating it", () => {
    const plan = planPreparation({ ...external, exists: false });
    assert.equal(plan.action, "error");
    assert.match(plan.reason, /does not exist/);
  });

  test("refuses a directory that is not a git checkout", () => {
    const plan = planPreparation({ ...external, hasGit: false });
    assert.equal(plan.action, "error");
    assert.match(plan.reason, /not a git checkout/);
  });

  test("refuses a checkout of a different repository", () => {
    const plan = planPreparation({ ...external, originUrl: "https://github.com/example/other.git" });
    assert.equal(plan.action, "error");
    assert.match(plan.reason, /not a checkout/);
  });
});

describe("prepare-guanlan-fixture: only the script-owned cache is rebuilt", () => {
  test("clones when the managed cache is missing", () => {
    assert.deepEqual(planPreparation({ ...external, explicit: false, exists: false }), {
      action: "clone",
      dir: TARGET,
    });
  });

  test("rebuilds the managed cache at another commit", () => {
    assert.deepEqual(planPreparation({ ...external, explicit: false, head: "deadbeef" }), {
      action: "rebuild",
      dir: TARGET,
    });
  });

  test("rebuilds the managed cache on --force", () => {
    assert.deepEqual(planPreparation({ ...external, explicit: false, force: true }), {
      action: "rebuild",
      dir: TARGET,
    });
  });

  test("reuses the managed cache when it is ready", () => {
    assert.deepEqual(planPreparation({ ...external, explicit: false }), { action: "reuse", dir: TARGET });
  });
});

describe("prepare-guanlan-fixture: real script guard", () => {
  test("a dirty external worktree at another commit is refused and left byte-identical", () => {
    const repo = mkdtempSync(join(tmpdir(), "cloud-pi-guanlan-guard-"));
    try {
      execFileSync("git", ["init", repo], { encoding: "utf8" });
      git(repo, ["config", "user.email", "p0-guard@example.test"]);
      git(repo, ["config", "user.name", "P0 Guard"]);
      writeFileSync(join(repo, "tracked.txt"), "original\n");
      git(repo, ["add", "tracked.txt"]);
      git(repo, ["commit", "-m", "guard fixture"]);
      git(repo, ["remote", "add", "origin", GUANLAN_REPOSITORY]);
      writeFileSync(join(repo, "tracked.txt"), "uncommitted work\n");

      const headBefore = git(repo, ["rev-parse", "HEAD"]);
      const statusBefore = git(repo, ["status", "--porcelain"]);

      const result = spawnSync(process.execPath, [SCRIPT], {
        env: { ...process.env, GUANLAN_DIR: repo },
        encoding: "utf8",
      });

      assert.notEqual(result.status, 0, "the script must refuse, not repair");
      assert.match(result.stderr, /GUANLAN_DIR|pinned|refusing/);
      assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "uncommitted work\n");
      assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);
      assert.equal(git(repo, ["status", "--porcelain"]), statusBefore);
      assert.equal(existsSync(join(repo, "node_modules")), false, "no dependency install in the external worktree");
      assert.equal(existsSync(join(repo, "dist")), false, "no build output in the external worktree");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
