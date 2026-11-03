/**
 * Controller for the Cloud Pi local management API.
 *
 * Every method delegates to the owning module:
 *
 *   schedules  → the existing Scheduler public methods (`createScheduler()`);
 *   runs       → the existing Research `listResearchRuns()` / `readResearchRun()`.
 *
 * There is no local cache, index or copy of task/run state. Responses are
 * projections from `views.mjs`, so the HTTP layer cannot return an internal
 * record (paths, transcript, environment) verbatim.
 */
import { listResearchRuns, readResearchRun } from "../research/index.mjs";
import { API_ERROR, ApiError } from "./contracts.mjs";
import { toReportView, toRunView, toScheduleView, toTriggerView } from "./views.mjs";

export const DELIVERY_UNAVAILABLE_MESSAGE =
  "delivery status is not available in this baseline: the AGT-033 delivery contract is not part of the current dev source";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRunLimit(raw) {
  if (raw === undefined) return 50;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new ApiError(API_ERROR.INVALID_REQUEST, "limit must be a positive integer");
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(API_ERROR.INVALID_REQUEST, "limit must be between 1 and 100");
  }
  return limit;
}

/**
 * @param {object} options
 * @param {object} options.scheduler a `createScheduler()` instance (or a test double)
 * @param {string} [options.runsDir] research run root; resolved by AGT-028 when omitted
 * @param {Record<string,string>} [options.env]
 * @param {() => Date} [options.now]
 * @param {object} [options.logger]
 */
export function createApiController({ scheduler, runsDir, env = process.env, now = () => new Date(), logger = {} } = {}) {
  if (!scheduler || typeof scheduler.listSchedules !== "function") {
    throw new TypeError("createApiController requires a scheduler instance");
  }
  const clock = typeof now === "function" ? now : () => new Date(now);
  const researchReadOptions = { rootDir: runsDir, env };

  return {
    health() {
      return {
        status: "ok",
        service: "cloud-pi-management-api",
        apiVersion: "v1",
        checkedAt: clock().toISOString(),
      };
    },

    async status() {
      const schedules = await scheduler.listSchedules();
      const byStatus = { active: 0, paused: 0, completed: 0 };
      let activeRuns = 0;
      for (const schedule of schedules) {
        if (Object.prototype.hasOwnProperty.call(byStatus, schedule.status)) byStatus[schedule.status] += 1;
        if (schedule.activeTrigger) activeRuns += 1;
      }
      const runs = await listResearchRuns(researchReadOptions);
      const latest = runs[0] ?? null;
      return {
        apiVersion: "v1",
        checkedAt: clock().toISOString(),
        scheduler: {
          scheduleCount: schedules.length,
          byStatus,
          activeRuns,
          running: activeRuns > 0,
        },
        research: {
          runCount: runs.length,
          latestRun: latest
            ? { runId: latest.runId, status: latest.status, finishedAt: latest.finishedAt ?? null }
            : null,
        },
        capabilities: {
          // Conditional closure: the AGT-033 delivery contract is not in this
          // baseline, so no delivery endpoint or stored delivery state exists.
          deliveryStatus: false,
          deliveryReason: DELIVERY_UNAVAILABLE_MESSAGE,
          publicListener: false,
          authentication: "none (loopback-only local API; Cloud Auth delegation is a later card)",
        },
      };
    },

    async listSchedules() {
      const items = (await scheduler.listSchedules()).map((schedule) => toScheduleView(schedule));
      return { schedules: items, count: items.length };
    },

    async getSchedule(scheduleId) {
      const schedule = await scheduler.getSchedule(scheduleId);
      return { schedule: toScheduleView(schedule, { includeTriggers: true }) };
    },

    async createSchedule(body) {
      if (!isObject(body)) {
        throw new ApiError(API_ERROR.INVALID_REQUEST, "request body must be a JSON object");
      }
      const schedule = await scheduler.createSchedule(body);
      return { schedule: toScheduleView(schedule, { includeTriggers: true }) };
    },

    async updateSchedule(scheduleId, body) {
      if (!isObject(body)) {
        throw new ApiError(API_ERROR.INVALID_REQUEST, "request body must be a JSON object");
      }
      const schedule = await scheduler.updateSchedule(scheduleId, body);
      return { schedule: toScheduleView(schedule, { includeTriggers: true }) };
    },

    async deleteSchedule(scheduleId) {
      const result = await scheduler.deleteSchedule(scheduleId);
      return { scheduleId: result.scheduleId, deleted: result.deleted === true };
    },

    async pause(scheduleId) {
      const schedule = await scheduler.pause(scheduleId);
      return { schedule: toScheduleView(schedule, { includeTriggers: true }) };
    },

    async enable(scheduleId) {
      const schedule = await scheduler.enable(scheduleId);
      return { schedule: toScheduleView(schedule, { includeTriggers: true }) };
    },

    async runNow(scheduleId) {
      // The Scheduler owns the trigger/lease. Its promise resolves when the
      // triggered run reaches a terminal state, so the console receives the
      // real outcome (runId/status) instead of an optimistic "accepted".
      const trigger = await scheduler.runNow(scheduleId);
      const schedule = await scheduler.getSchedule(scheduleId);
      return {
        scheduleId,
        trigger: toTriggerView(trigger),
        schedule: toScheduleView(schedule),
      };
    },

    async cancel(scheduleId) {
      // Existence first: `cancel` only knows about live controllers.
      await scheduler.getSchedule(scheduleId);
      const cancelled = scheduler.cancel(scheduleId, "cancelled via local management API");
      if (!cancelled) {
        throw new ApiError(API_ERROR.CONFLICT, `schedule ${scheduleId} has no active run to cancel`);
      }
      return { scheduleId, cancelled: true };
    },

    async listRuns({ limit: rawLimit, scheduleId } = {}) {
      const limit = parseRunLimit(rawLimit);
      let matched;
      if (scheduleId !== undefined) {
        // Existence check + run linkage from the schedule's own audit trail;
        // the run store stays the single source of run records.
        const schedule = await scheduler.getSchedule(scheduleId);
        const allowed = new Set();
        if (typeof schedule.lastRun?.runId === "string") allowed.add(schedule.lastRun.runId);
        if (typeof schedule.activeTrigger?.runId === "string") allowed.add(schedule.activeTrigger.runId);
        for (const trigger of Array.isArray(schedule.triggers) ? schedule.triggers : []) {
          if (typeof trigger.runId === "string") allowed.add(trigger.runId);
        }
        const all = await listResearchRuns(researchReadOptions);
        matched = all.filter((run) => allowed.has(run.runId));
      } else {
        matched = await listResearchRuns(researchReadOptions);
      }
      const runs = matched.slice(0, limit).map(toRunView);
      return {
        runs,
        count: runs.length,
        total: matched.length,
        limit,
        scheduleId: scheduleId ?? null,
      };
    },

    async getRun(runId) {
      const { run } = await readResearchRun(runId, researchReadOptions);
      return { run: toRunView(run) };
    },

    async getRunReport(runId) {
      const { run, report, sources } = await readResearchRun(runId, researchReadOptions);
      return { report: toReportView(run, report, sources) };
    },

    deliveryNotAvailable() {
      throw new ApiError(API_ERROR.NOT_FOUND, DELIVERY_UNAVAILABLE_MESSAGE);
    },

    logger,
  };
}
