/**
 * Single-instance guard for the WeCom channel process.
 *
 * The platform allows exactly one live long connection per bot: a second
 * subscriber silently kicks the first one off (`disconnected_event`). Starting
 * two local processes therefore does not "scale", it flaps. This lock turns that
 * into an explicit startup failure instead of a reconnect loop.
 *
 * The lock is a file with the owner pid. A lock whose pid is gone is stale and
 * is taken over; a lock whose pid is alive refuses startup. This is a local
 * guard, not a distributed lease.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class WecomInstanceError extends Error {
  constructor(code, detail) {
    super(detail ? `WeCom instance lock error (${code}): ${detail}` : `WeCom instance lock error (${code})`);
    this.name = "WecomInstanceError";
    this.code = code;
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

/**
 * @param {{dir: string, name?: string, pid?: number}} options
 */
export function createInstanceLock({ dir, name = "wecom-channel", pid = process.pid } = {}) {
  if (typeof dir !== "string" || dir.length === 0) throw new TypeError("createInstanceLock requires a dir");
  const file = join(dir, `${name}.lock`);
  let held = false;

  return {
    acquire() {
      if (held) return { acquired: true, file, recoveredStale: false };
      mkdirSync(dir, { recursive: true });
      try {
        writeFileSync(file, JSON.stringify({ pid, startedAt: new Date().toISOString() }), {
          encoding: "utf8",
          flag: "wx",
        });
        held = true;
        return { acquired: true, file, recoveredStale: false };
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw new WecomInstanceError("lock_write_failed", String(error?.message ?? error));
        }
      }

      let owner;
      try {
        owner = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        owner = null;
      }
      if (owner && owner.pid !== pid && isProcessAlive(owner.pid)) {
        throw new WecomInstanceError(
          "already_running",
          `another WeCom channel process holds ${file} (pid ${owner.pid}); the platform allows one connection per bot`,
        );
      }

      // Stale or unreadable lock: take it over.
      try {
        writeFileSync(file, JSON.stringify({ pid, startedAt: new Date().toISOString(), recovered: true }), {
          encoding: "utf8",
        });
      } catch (error) {
        throw new WecomInstanceError("lock_write_failed", String(error?.message ?? error));
      }
      held = true;
      return { acquired: true, file, recoveredStale: true };
    },

    release() {
      if (!held) return false;
      held = false;
      try {
        const owner = JSON.parse(readFileSync(file, "utf8"));
        if (owner?.pid === pid) unlinkSync(file);
      } catch {
        // Already gone or owned by someone else: nothing to release.
      }
      return true;
    },

    get path() {
      return file;
    },

    get isHeld() {
      return held;
    },
  };
}
