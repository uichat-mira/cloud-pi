/**
 * Pure decision logic for `scripts/prepare-guanlan-fixture.mjs`.
 *
 * The script must never reset or build inside a worktree it did not create.
 * An explicit `GUANLAN_DIR` is only ever *read*; if it does not already hold
 * the pinned commit, a clean tracked tree and the built fixture, preparation
 * fails instead of repairing it. Only the script's own temporary clone may be
 * rebuilt with `git checkout --force`.
 */
export const GUANLAN_REPOSITORY = "https://github.com/uichat-mira/cloud-mcp-guanlan.git";
export const GUANLAN_COMMIT = "3362ef9254be154694cb786fc35921884c62b792";

/** Normalize HTTPS and SSH GitHub remotes so the origin check is stable. */
export function normalizeRemote(url) {
  return String(url ?? "")
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/**
 * @returns {{action: "reuse"|"clone"|"rebuild"|"error", dir?: string, reason?: string}}
 */
export function planPreparation({
  explicit,
  force,
  exists,
  hasGit,
  originUrl,
  head,
  dirty,
  ready,
  target,
  pinnedCommit = GUANLAN_COMMIT,
  repository = GUANLAN_REPOSITORY,
}) {
  if (!exists) {
    if (explicit) {
      return {
        action: "error",
        reason: `GUANLAN_DIR points to ${target}, which does not exist. Unset GUANLAN_DIR to let this script create its own temporary clone.`,
      };
    }
    return { action: "clone", dir: target };
  }

  if (!hasGit) {
    return { action: "error", reason: `${target} is not a git checkout; refusing to modify it.` };
  }

  if (normalizeRemote(originUrl) !== normalizeRemote(repository)) {
    return {
      action: "error",
      reason: `${target} is not a checkout of ${repository} (origin: ${originUrl || "missing"}); refusing to modify it.`,
    };
  }

  if (explicit) {
    if (force) {
      return {
        action: "error",
        reason: "--force is only allowed for the script's own temporary clone, not for GUANLAN_DIR.",
      };
    }
    if (head !== pinnedCommit) {
      return {
        action: "error",
        reason: `${target} is at ${head}, not the pinned ${pinnedCommit}; refusing to reset or rebuild an external worktree.`,
      };
    }
    if (dirty) {
      return {
        action: "error",
        reason: `${target} has uncommitted tracked changes; refusing to reset or rebuild an external worktree.`,
      };
    }
    if (!ready) {
      return {
        action: "error",
        reason: `${target} is missing the built fixture; run npm ci && npm run build there yourself, or unset GUANLAN_DIR.`,
      };
    }
    return { action: "reuse", dir: target };
  }

  if (force || head !== pinnedCommit || !ready) {
    return { action: "rebuild", dir: target };
  }
  return { action: "reuse", dir: target };
}
