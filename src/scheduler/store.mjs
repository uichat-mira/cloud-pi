/**
 * File-backed schedule store for the scheduler POC.
 *
 * Layout:
 *
 *   <stateDir>/schedules/<scheduleId>.json
 *
 * One JSON document per schedule contains the definition, the next fire time,
 * the active trigger lease and a bounded trigger audit history. Writes use the
 * shared same-directory atomic replacement. There is intentionally no database,
 * no cross-process lock and no server: the POC contract is one scheduler
 * process per state directory.
 *
 * Reads fail closed: a corrupt schedule file raises `parse_error` instead of
 * being skipped, because silently dropping a schedule would violate the
 * "know what it did" requirement.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "../fs/atomic.mjs";
import {
  DEFAULT_STATE_DIR,
  ENV,
  SCHEDULER_ERROR,
  SchedulerError,
  isValidScheduleId,
} from "./contracts.mjs";
import { assertScheduleShape } from "./schedule.mjs";

/** Resolve the state root: explicit argument > SCHEDULER_STATE_DIR > default. */
export function resolveStateDir({ stateDir, env = process.env } = {}) {
  if (typeof stateDir === "string" && stateDir.trim()) return resolve(stateDir.trim());
  const fromEnv = env?.[ENV.STATE_DIR];
  if (typeof fromEnv === "string" && fromEnv.trim()) return resolve(fromEnv.trim());
  return resolve(DEFAULT_STATE_DIR);
}

/**
 * Create a schedule store bound to one state directory.
 *
 * @param {{ stateDir?: string, env?: Record<string,string> }} [options]
 */
export function createScheduleStore({ stateDir, env = process.env } = {}) {
  const rootDir = resolveStateDir({ stateDir, env });
  const schedulesDir = join(rootDir, "schedules");

  function fileFor(scheduleId) {
    if (!isValidScheduleId(scheduleId)) {
      throw new SchedulerError(
        SCHEDULER_ERROR.INVALID_REQUEST,
        `invalid schedule id: ${String(scheduleId)}`,
      );
    }
    return join(schedulesDir, `${scheduleId}.json`);
  }

  async function read(scheduleId) {
    const file = fileFor(scheduleId);
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw new SchedulerError(SCHEDULER_ERROR.NOT_FOUND, `schedule not found: ${scheduleId}`);
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SchedulerError(
        SCHEDULER_ERROR.PARSE_ERROR,
        `schedule ${scheduleId} is not valid JSON`,
      );
    }
    return assertScheduleShape(parsed, { expectScheduleId: scheduleId });
  }

  async function list() {
    let entries;
    try {
      entries = await readdir(schedulesDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const scheduleId = entry.name.slice(0, -".json".length);
      if (!isValidScheduleId(scheduleId)) {
        throw new SchedulerError(
          SCHEDULER_ERROR.PARSE_ERROR,
          `unexpected schedule file name: ${entry.name}`,
        );
      }
      records.push(await read(scheduleId));
    }
    records.sort((a, b) => {
      const delta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      return delta !== 0 ? delta : a.scheduleId.localeCompare(b.scheduleId);
    });
    return records;
  }

  async function write(record) {
    assertScheduleShape(record);
    await atomicWriteFile(fileFor(record.scheduleId), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  return {
    rootDir,
    schedulesDir,
    fileFor,
    read,
    list,
    write,
  };
}
