/**
 * Public API of the Cloud Pi scheduler POC (AGT-030).
 *
 * The scheduler is an internal module for the POC: there is no HTTP API. It
 * persists schedule definitions under `SCHEDULER_STATE_DIR` (default
 * `.work/scheduler`) and triggers the existing AGT-028 research executor.
 *
 * Minimal usage:
 *
 * ```js
 * import { createScheduler, TRIGGER_STATUS } from "./src/scheduler/index.mjs";
 *
 * const scheduler = await createScheduler({
 *   stateDir: ".work/scheduler",
 *   researchDeps: { runtimePort, toolLayer, rootDir: ".work/research-runs" },
 * });
 *
 * const schedule = await scheduler.createSchedule({
 *   kind: "recurring",
 *   timezone: "Asia/Shanghai",
 *   cron: "0 9 * * *",
 *   request: { topic: "研究最近 48 小时 AI Agent 工程进展", timeRange: "48h" },
 * });
 *
 * await scheduler.start();
 * // ... later
 * await scheduler.stop();
 * const runs = await import("./src/research/index.mjs").then((m) =>
 *   m.listResearchRuns({ rootDir: ".work/research-runs" }),
 * );
 * ```
 *
 * Operations: create/load, enable, pause, run-now, start, stop, tick, cancel.
 * `startResearch` (the non-blocking public form of `executeResearch`) is called
 * for every trigger; the scheduler never assembles a runtime or calls a model.
 */
export {
  DEFAULT_STATE_DIR,
  ENV,
  LIMITS,
  MISSED_RUN_POLICY,
  SCHEDULE_ID_PATTERN,
  SCHEDULE_KIND,
  SCHEDULE_STATUS,
  SCHEDULER_CONTRACT_VERSION,
  SCHEDULER_ERROR,
  SchedulerError,
  TRIGGER_STATUS,
  generateScheduleId,
  isScheduleStatus,
  isSuccessfulTrigger,
  isTerminalTriggerStatus,
  isTriggerStatus,
  isValidScheduleId,
  mapResearchStatusToTriggerStatus,
} from "./contracts.mjs";
export {
  assertScheduleShape,
  assertTimezone,
  cloneSchedule,
  collectDueOccurrences,
  computeNextRunAt,
  enumerateMissedOccurrences,
  makeDedupeKey,
  makeManualDedupeKey,
  nextCronOccurrence,
  normalizeScheduleInput,
  parseLocalDateTime,
  resolveOnceInstant,
} from "./schedule.mjs";
export { createScheduleStore, resolveStateDir } from "./store.mjs";
export { createScheduler } from "./scheduler.mjs";
