/**
 * Schedule validation and next-fire computation for the scheduler POC.
 *
 * `croner` (MIT) is used only as a deterministic cron/time-zone calculator:
 * instances are created paused and stopped immediately after `nextRun()` /
 * `getOnce()`. The scheduler owns its own tick loop, persistence, leases and
 * dedupe; no library timer runs in this process.
 *
 * All persisted instants are UTC ISO strings. The IANA `timezone` and the
 * local `onceAt` / `cron` expression are stored alongside them, so behaviour
 * never depends on the host process time zone.
 */
import { Cron } from "croner";
import { normalizeResearchRequest } from "../research/execute.mjs";
import {
  LIMITS,
  MISSED_RUN_POLICY,
  SCHEDULER_CONTRACT_VERSION,
  SCHEDULER_ERROR,
  SCHEDULE_KIND,
  SCHEDULE_STATUS,
  SchedulerError,
  generateScheduleId,
  isScheduleStatus,
  isValidScheduleId,
  normalizeDeliveryTargets,
} from "./contracts.mjs";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message, code = SCHEDULER_ERROR.INVALID_REQUEST) {
  throw new SchedulerError(code, message);
}

/** Validate an IANA time zone without assuming the process locale. */
export function assertTimezone(timezone) {
  if (typeof timezone !== "string" || !timezone.trim()) {
    fail("timezone is required (IANA name, for example Asia/Shanghai)");
  }
  const value = timezone.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch (error) {
    fail(`invalid IANA timezone ${JSON.stringify(value)}: ${error?.message ?? error}`);
  }
  return value;
}

/** Parse `YYYY-MM-DDTHH:mm[:ss]` local wall time and reject impossible dates. */
export function parseLocalDateTime(value) {
  if (typeof value !== "string") fail("once.at must be a local date-time string");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) {
    fail("once.at must use YYYY-MM-DDTHH:mm[:ss] (local wall time; the schedule timezone applies)");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) fail("once.at has an out-of-range time");
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    fail("once.at is not a real calendar date");
  }
  return { year, month, day, hour, minute, second };
}

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const result = {};
  for (const part of parts) {
    if (part.type !== "literal") result[part.type] = part.value;
  }
  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour: Number(result.hour) % 24,
    minute: Number(result.minute),
    second: Number(result.second),
  };
}

function sameLocalParts(a, b) {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * Resolve a local once time in an IANA zone. Ambiguous wall times (DST fall
 * back) resolve to the earlier instant; a non-existent wall time (DST spring
 * forward) is rejected instead of silently running an hour later.
 */
export function resolveOnceInstant({ at, timezone }) {
  assertTimezone(timezone);
  const parts = parseLocalDateTime(at);
  let cron;
  try {
    cron = new Cron(at.trim(), { timezone, paused: true });
    const instant = cron.getOnce();
    if (!instant || Number.isNaN(instant.getTime())) {
      fail(`once.at ${JSON.stringify(at)} has no resolvable instant in ${timezone}`);
    }
    if (!sameLocalParts(localParts(instant, timezone), parts)) {
      fail(`once.at ${JSON.stringify(at)} does not exist in ${timezone} (daylight-saving gap)`);
    }
    return new Date(instant.getTime());
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    fail(`cannot resolve once.at ${JSON.stringify(at)} in ${timezone}: ${error?.message ?? error}`);
  } finally {
    cron?.stop();
  }
}

function createCron(expression, timezone) {
  try {
    return new Cron(expression, { timezone, paused: true });
  } catch (error) {
    fail(`invalid cron expression ${JSON.stringify(expression)}: ${error?.message ?? error}`);
  }
}

/** Next occurrence strictly after `afterDate`, or null when none exists. */
export function nextCronOccurrence(expression, timezone, afterDate) {
  assertTimezone(timezone);
  const cron = createCron(expression, timezone);
  try {
    const next = cron.nextRun(afterDate);
    return next ? new Date(next.getTime()) : null;
  } finally {
    cron.stop();
  }
}

/**
 * Compute `nextRunAt` for a schedule, strictly after `afterDate`.
 * A once schedule whose instant has passed has no next run.
 *
 * @param {object} schedule
 * @param {Date} afterDate
 * @returns {Date|null}
 */
export function computeNextRunAt(schedule, afterDate) {
  if (schedule.kind === SCHEDULE_KIND.ONCE) {
    const at = Date.parse(schedule.onceAtUtc);
    if (!Number.isFinite(at)) return null;
    return at > afterDate.getTime() ? new Date(at) : null;
  }
  if (schedule.kind === SCHEDULE_KIND.RECURRING) {
    return nextCronOccurrence(schedule.cron, schedule.timezone, afterDate);
  }
  throw new SchedulerError(SCHEDULER_ERROR.PARSE_ERROR, `unknown schedule kind ${schedule.kind}`);
}

/**
 * Enumerate the occurrences that are due at `now`, starting from the persisted
 * `nextRunAt`. `missedCount` counts occurrences *after* the one that will be
 * fired; a normal late tick is 0, three days of downtime for a daily schedule
 * is 2. The scan is bounded and marks `capped` when the bound was hit.
 *
 * @param {object} schedule
 * @param {Date} now
 */
export function collectDueOccurrences(schedule, now) {
  const nextMs = Date.parse(schedule.nextRunAt ?? "");
  if (!Number.isFinite(nextMs) || nextMs > now.getTime()) return null;
  const first = new Date(nextMs);
  if (schedule.kind === SCHEDULE_KIND.ONCE) {
    return {
      first,
      latest: first,
      missedCount: 0,
      missedThrough: null,
      capped: false,
      lateByMs: Math.max(0, now.getTime() - first.getTime()),
    };
  }
  const runs = enumerateOccurrences(schedule, first, now);
  if (!runs.count) return null;
  return {
    first,
    latest: runs.latest,
    missedCount: Math.max(0, runs.count - 1),
    missedThrough: runs.count > 1 ? runs.latest.toISOString() : null,
    capped: runs.capped,
    lateByMs: Math.max(0, now.getTime() - first.getTime()),
  };
}

/**
 * Count occurrences in `[fromDate, toDate]` without firing them (pause audit).
 * For a once schedule this is 0 or 1.
 *
 * @param {object} schedule
 * @param {Date} fromDate
 * @param {Date} toDate
 */
export function enumerateMissedOccurrences(schedule, fromDate, toDate) {
  if (!fromDate || !toDate || fromDate.getTime() > toDate.getTime()) {
    return { count: 0, latest: null, capped: false };
  }
  if (schedule.kind === SCHEDULE_KIND.ONCE) {
    return { count: 1, latest: fromDate, capped: false };
  }
  const runs = enumerateOccurrences(schedule, fromDate, toDate);
  return runs;
}

function enumerateOccurrences(schedule, fromDate, toDate) {
  const cron = createCron(schedule.cron, schedule.timezone);
  try {
    const start = new Date(fromDate.getTime() - 1000);
    const dates = cron.nextRuns(LIMITS.maxMissedScan, start);
    const within = dates.filter((date) => date.getTime() <= toDate.getTime());
    if (!within.length) return { count: 0, latest: null, capped: false };
    return {
      count: within.length,
      latest: new Date(within[within.length - 1].getTime()),
      capped: within.length === LIMITS.maxMissedScan,
    };
  } finally {
    cron.stop();
  }
}

/**
 * Validate and normalise a create-schedule input into a complete persisted
 * record. The caller is responsible for duplicate-id and schedule-count checks.
 *
 * @param {object} input
 * @param {{ now: Date }} options
 */
export function normalizeScheduleInput(input, { now }) {
  if (!isPlainObject(input)) fail("schedule input must be an object");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("now must be a valid date");

  const scheduleId = input.scheduleId === undefined ? generateScheduleId(now) : input.scheduleId;
  if (!isValidScheduleId(scheduleId)) {
    fail(
      "scheduleId must be a lower-case slug (3-64 chars: a-z, 0-9, '-') or the generated sch-… form",
    );
  }

  const timezone = assertTimezone(input.timezone);
  const kind = input.kind;
  if (kind !== SCHEDULE_KIND.ONCE && kind !== SCHEDULE_KIND.RECURRING) {
    fail(`kind must be "${SCHEDULE_KIND.ONCE}" or "${SCHEDULE_KIND.RECURRING}"`);
  }
  if (input.missedRunPolicy !== undefined && input.missedRunPolicy !== MISSED_RUN_POLICY.COALESCE_ONE) {
    fail(`unsupported missedRunPolicy; the POC freezes "${MISSED_RUN_POLICY.COALESCE_ONE}"`);
  }

  let name = "";
  if (input.name !== undefined) {
    if (typeof input.name !== "string") fail("name must be a string");
    name = input.name.trim().slice(0, 200);
  }

  let normalizedRequest;
  try {
    normalizedRequest = normalizeResearchRequest(input.request, { now }).request;
  } catch (error) {
    fail(`invalid research request: ${error?.message ?? error}`);
  }

  // Delivery recipients are trusted task configuration (AGT-033), never part of
  // the research request or anything the model can influence.
  const deliveryTargets = normalizeDeliveryTargets(input.deliveryTargets);

  const nowIso = now.toISOString();
  let cron = null;
  let onceAt = null;
  let onceAtUtc = null;
  let nextRunAt = null;

  if (kind === SCHEDULE_KIND.ONCE) {
    if (input.cron !== undefined) fail("once schedules must not include cron");
    if (input.at === undefined) fail("once schedules require at");
    const instant = resolveOnceInstant({ at: input.at, timezone });
    if (instant.getTime() <= now.getTime()) {
      fail("once.at must be in the future; a missed one-time occurrence is recovered only after it is stored");
    }
    onceAt = String(input.at).trim();
    onceAtUtc = instant.toISOString();
    nextRunAt = onceAtUtc;
  } else {
    if (input.at !== undefined) fail("recurring schedules must not include at");
    if (typeof input.cron !== "string" || !input.cron.trim()) fail("recurring schedules require cron");
    cron = input.cron.trim();
    const next = nextCronOccurrence(cron, timezone, now);
    if (!next) fail("cron expression has no future occurrence");
    nextRunAt = next.toISOString();
  }

  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
  return {
    contractVersion: SCHEDULER_CONTRACT_VERSION,
    scheduleId,
    name,
    kind,
    timezone,
    cron,
    onceAt,
    onceAtUtc,
    request: normalizedRequest,
    // Additive, optional field: records written before AGT-033 remain readable.
    deliveryTargets: [...deliveryTargets],
    status: enabled ? SCHEDULE_STATUS.ACTIVE : SCHEDULE_STATUS.PAUSED,
    missedRunPolicy: MISSED_RUN_POLICY.COALESCE_ONE,
    createdAt: nowIso,
    updatedAt: nowIso,
    nextRunAt,
    completedAt: null,
    lastRun: null,
    activeTrigger: null,
    triggers: [],
    stats: {
      triggers: 0,
      succeeded: 0,
      partial: 0,
      failed: 0,
      cancelled: 0,
      timeout: 0,
      interrupted: 0,
      missed: 0,
      duplicatesSkipped: 0,
    },
  };
}

/**
 * Validate a persisted schedule record. Corrupt or forged records are refused
 * with `parse_error` rather than being silently skipped: losing a schedule is
 * worse than failing the scheduler start loudly.
 *
 * @param {unknown} record
 * @param {{ expectScheduleId?: string }} [options]
 */
export function assertScheduleShape(record, { expectScheduleId } = {}) {
  const invalid = (reason) => {
    throw new SchedulerError(SCHEDULER_ERROR.PARSE_ERROR, `invalid schedule record: ${reason}`);
  };
  if (!isPlainObject(record)) invalid("not a JSON object");
  if (record.contractVersion !== SCHEDULER_CONTRACT_VERSION) {
    invalid(`unsupported contractVersion ${JSON.stringify(record.contractVersion)}`);
  }
  if (!isValidScheduleId(record.scheduleId)) invalid("missing or malformed scheduleId");
  if (expectScheduleId && record.scheduleId !== expectScheduleId) {
    invalid(`scheduleId ${record.scheduleId} does not match file ${expectScheduleId}`);
  }
  if (record.kind !== SCHEDULE_KIND.ONCE && record.kind !== SCHEDULE_KIND.RECURRING) {
    invalid(`unknown kind ${JSON.stringify(record.kind)}`);
  }
  if (typeof record.timezone !== "string" || !record.timezone) invalid("missing timezone");
  if (!isScheduleStatus(record.status)) invalid(`unknown schedule status ${JSON.stringify(record.status)}`);
  if (!isPlainObject(record.request) || typeof record.request.topic !== "string") {
    invalid("missing request.topic");
  }
  // `deliveryTargets` was added by AGT-033; a persisted record without it is a
  // valid pre-AGT-033 schedule and simply delivers nothing.
  if (record.deliveryTargets !== undefined) {
    try {
      normalizeDeliveryTargets(record.deliveryTargets);
    } catch (error) {
      invalid(`invalid deliveryTargets: ${error?.message ?? error}`);
    }
  }
  for (const key of ["createdAt", "updatedAt"]) {
    if (typeof record[key] !== "string" || Number.isNaN(Date.parse(record[key]))) {
      invalid(`missing or invalid ${key}`);
    }
  }
  if (record.nextRunAt !== null && (typeof record.nextRunAt !== "string" || Number.isNaN(Date.parse(record.nextRunAt)))) {
    invalid("nextRunAt must be null or an ISO date-time");
  }
  if (!Array.isArray(record.triggers)) invalid("missing triggers array");
  if (record.activeTrigger !== null && !isPlainObject(record.activeTrigger)) {
    invalid("activeTrigger must be null or an object");
  }
  if (!isPlainObject(record.stats)) invalid("missing stats");
  if (record.missedRunPolicy !== MISSED_RUN_POLICY.COALESCE_ONE) {
    invalid(`unknown missedRunPolicy ${JSON.stringify(record.missedRunPolicy)}`);
  }
  if (record.kind === SCHEDULE_KIND.ONCE) {
    if (typeof record.onceAtUtc !== "string" || Number.isNaN(Date.parse(record.onceAtUtc))) {
      invalid("once schedule is missing onceAtUtc");
    }
  } else if (typeof record.cron !== "string" || !record.cron) {
    invalid("recurring schedule is missing cron");
  }
  return record;
}

/** Deep-clone a schedule so callers cannot mutate engine state through a result. */
export function cloneSchedule(schedule) {
  return structuredClone(schedule);
}

/**
 * Build the stable dedupe key for one logical occurrence. The key is consumed
 * before a research run starts, so a duplicate tick, callback re-entry or a
 * process restart cannot start the same occurrence twice.
 */
export function makeDedupeKey(scheduleId, scheduledForIso) {
  return `${scheduleId}@${scheduledForIso}`;
}

export function makeManualDedupeKey(scheduleId, atIso, nonce) {
  return `${scheduleId}@manual:${atIso}:${nonce}`;
}

export { SCHEDULE_KIND, SCHEDULE_STATUS };
