/**
 * Frozen contracts for the Cloud Pi scheduler POC (AGT-030).
 *
 * The scheduler owns *when* a research run starts and *which* persisted trigger
 * caused it. It does not own the Agent runtime, the research executor or the
 * run store: a due trigger calls AGT-028's `startResearch()` (the non-blocking
 * public form of `executeResearch()`) and keeps the returned run id.
 *
 * Persisted shapes and statuses are versioned here. Change them only with a
 * `SCHEDULER_CONTRACT_VERSION` bump; the store writes the version it wrote, and
 * existing schedule files stay readable.
 */
import { randomBytes } from "node:crypto";
import { RUN_STATUS } from "../research/contracts.mjs";

/** Bump when a persisted schedule/trigger shape or enum changes incompatibly. */
export const SCHEDULER_CONTRACT_VERSION = 1;

export const SCHEDULE_KIND = Object.freeze({
  ONCE: "once",
  RECURRING: "recurring",
});

export const SCHEDULE_STATUS = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  /** A one-time schedule whose occurrence has been claimed (or skipped). */
  COMPLETED: "completed",
});

/**
 * Lifecycle of one scheduler trigger. `scheduled` and `started` are not
 * outcomes: a trigger is only `succeeded` when the research run itself
 * completed. `partial` means the research run produced a report with recorded
 * errors (`completed_with_errors`) and must not be counted as a clean success.
 *
 * `interrupted` means the scheduler process ended while the trigger was active;
 * `missed` records an occurrence the frozen policy deliberately did not run
 * (for example a pause), so a skipped occurrence is never silently lost.
 */
export const TRIGGER_STATUS = Object.freeze({
  SCHEDULED: "scheduled",
  STARTED: "started",
  SUCCEEDED: "succeeded",
  PARTIAL: "partial",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  INTERRUPTED: "interrupted",
  MISSED: "missed",
});

const TERMINAL_TRIGGER_STATUSES = new Set([
  TRIGGER_STATUS.SUCCEEDED,
  TRIGGER_STATUS.PARTIAL,
  TRIGGER_STATUS.FAILED,
  TRIGGER_STATUS.CANCELLED,
  TRIGGER_STATUS.TIMEOUT,
  TRIGGER_STATUS.INTERRUPTED,
  TRIGGER_STATUS.MISSED,
]);

export function isScheduleStatus(value) {
  return value === SCHEDULE_STATUS.ACTIVE || value === SCHEDULE_STATUS.PAUSED || value === SCHEDULE_STATUS.COMPLETED;
}

export function isTriggerStatus(value) {
  return typeof value === "string" && Object.values(TRIGGER_STATUS).includes(value);
}

export function isTerminalTriggerStatus(value) {
  return TERMINAL_TRIGGER_STATUSES.has(value);
}

/** A trigger is a clean success only when the research run completed. */
export function isSuccessfulTrigger(status) {
  return status === TRIGGER_STATUS.SUCCEEDED;
}

/**
 * Map the persisted AGT-028 run status onto the scheduler trigger status.
 * Never map `completed_with_errors` onto `succeeded`.
 */
export function mapResearchStatusToTriggerStatus(status) {
  switch (status) {
    case RUN_STATUS.COMPLETED:
      return TRIGGER_STATUS.SUCCEEDED;
    case RUN_STATUS.COMPLETED_WITH_ERRORS:
      return TRIGGER_STATUS.PARTIAL;
    case RUN_STATUS.FAILED:
      return TRIGGER_STATUS.FAILED;
    case RUN_STATUS.CANCELLED:
      return TRIGGER_STATUS.CANCELLED;
    case RUN_STATUS.TIMEOUT:
      return TRIGGER_STATUS.TIMEOUT;
    default:
      return TRIGGER_STATUS.FAILED;
  }
}

/** Frozen POC missed-run semantics; see docs/engineering/agt-030-scheduler-poc.md. */
export const MISSED_RUN_POLICY = Object.freeze({
  /** At most one catch-up run per schedule, then advance past every missed tick. */
  COALESCE_ONE: "coalesce_one",
});

/**
 * Trusted delivery destinations (AGT-033).
 *
 * A schedule may name one or more Feishu destinations. The recipient is fixed
 * by trusted schedule configuration only: neither the model, a web page, a
 * report nor an inbound message may add, replace or rewrite a destination.
 *
 * `type` is the Feishu `receive_id_type` the transport must use, so the stored
 * contract and the platform API agree on the same two values.
 */
export const DELIVERY_TARGET_TYPE = Object.freeze({
  OPEN_ID: "open_id",
  CHAT_ID: "chat_id",
});

export const DELIVERY_TARGET_LIMITS = Object.freeze({
  /** Bounded fan-out per schedule; keeps one run from becoming a broadcast. */
  maxTargets: 10,
  maxLabelChars: 80,
});

const DELIVERY_OPEN_ID = /^ou_[A-Za-z0-9]+$/;
const DELIVERY_CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;
const DELIVERY_TARGET_KEYS = new Set(["type", "id", "label"]);

export function isDeliveryTargetType(value) {
  return value === DELIVERY_TARGET_TYPE.OPEN_ID || value === DELIVERY_TARGET_TYPE.CHAT_ID;
}

/**
 * Validate and normalise `deliveryTargets` from trusted schedule input.
 *
 * Unknown keys are rejected rather than ignored: a field such as `receive_id`
 * or `open_id` must not silently become a recipient, and a typo must fail the
 * schedule instead of producing a run that cannot deliver.
 *
 * @param {unknown} input
 * @returns {ReadonlyArray<{type:string,id:string,label?:string}>}
 */
export function normalizeDeliveryTargets(input) {
  const invalid = (reason) => {
    throw new SchedulerError(SCHEDULER_ERROR.INVALID_REQUEST, `invalid deliveryTargets: ${reason}`);
  };
  if (input === undefined || input === null) return Object.freeze([]);
  if (!Array.isArray(input)) invalid("must be an array");
  if (input.length > DELIVERY_TARGET_LIMITS.maxTargets) {
    invalid(`at most ${DELIVERY_TARGET_LIMITS.maxTargets} targets are supported`);
  }

  const targets = [];
  const seen = new Set();
  for (const [index, entry] of input.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalid(`[${index}] must be an object`);
    }
    const unknown = Object.keys(entry).filter((key) => !DELIVERY_TARGET_KEYS.has(key));
    if (unknown.length > 0) {
      invalid(`[${index}] has unsupported field(s): ${unknown.join(", ")}`);
    }
    if (!isDeliveryTargetType(entry.type)) {
      invalid(`[${index}].type must be "${DELIVERY_TARGET_TYPE.OPEN_ID}" or "${DELIVERY_TARGET_TYPE.CHAT_ID}"`);
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const pattern = entry.type === DELIVERY_TARGET_TYPE.OPEN_ID ? DELIVERY_OPEN_ID : DELIVERY_CHAT_ID;
    if (!pattern.test(id)) {
      invalid(
        `[${index}].id must be a Feishu ${entry.type} id starting with "${
          entry.type === DELIVERY_TARGET_TYPE.OPEN_ID ? "ou_" : "oc_"
        }"`,
      );
    }
    let label;
    if (entry.label !== undefined) {
      if (typeof entry.label !== "string") invalid(`[${index}].label must be a string`);
      const trimmed = entry.label.trim();
      if (trimmed) label = trimmed.slice(0, DELIVERY_TARGET_LIMITS.maxLabelChars);
    }
    const key = `${entry.type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(Object.freeze(label ? { type: entry.type, id, label } : { type: entry.type, id }));
  }
  return Object.freeze(targets);
}

/** Default state root, relative to the process cwd unless overridden. */
export const DEFAULT_STATE_DIR = ".work/scheduler";

/** Environment variable names read by this feature (no secrets). */
export const ENV = Object.freeze({
  STATE_DIR: "SCHEDULER_STATE_DIR",
});

export const LIMITS = Object.freeze({
  maxSchedules: 100,
  /** Bounded audit history per schedule; dedupe also relies on nextRunAt. */
  maxTriggerHistory: 100,
  /** Upper bound when counting downtime misses; the count is marked capped. */
  maxMissedScan: 1000,
  minTickIntervalMs: 10,
});

/** Machine-readable scheduler failure classes. */
export const SCHEDULER_ERROR = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  NOT_FOUND: "not_found",
  PARSE_ERROR: "parse_error",
  CONFLICT: "conflict",
  BUSY: "scheduler_busy",
  EXECUTOR_ERROR: "executor_error",
  INTERRUPTED: "interrupted",
});

const SCHEDULER_ERROR_CODES = new Set(Object.values(SCHEDULER_ERROR));

export class SchedulerError extends Error {
  /**
   * @param {string} code one of SCHEDULER_ERROR
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "SchedulerError";
    this.code = code;
  }
}

export function schedulerErrorRecord(code, message, at = new Date().toISOString()) {
  return {
    code: SCHEDULER_ERROR_CODES.has(code) ? code : SCHEDULER_ERROR.EXECUTOR_ERROR,
    message: String(message ?? "").slice(0, 500),
    at,
  };
}

/** `sch-<UTC yyyymmddthhmmss>-<6 hex>`; stable and sortable by time. */
export const SCHEDULE_ID_PATTERN = /^sch-\d{8}t\d{6}-[0-9a-f]{6}$/;
const CUSTOM_SCHEDULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

/**
 * Accept the generated form or a caller-supplied lower-case slug. The slug may
 * not contain path separators, dots or whitespace, so it is safe as a file name.
 *
 * @param {unknown} scheduleId
 */
export function isValidScheduleId(scheduleId) {
  return (
    typeof scheduleId === "string" &&
    (SCHEDULE_ID_PATTERN.test(scheduleId) || CUSTOM_SCHEDULE_ID_PATTERN.test(scheduleId))
  );
}

export function generateScheduleId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "t",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
  return `sch-${stamp}-${randomBytes(3).toString("hex")}`;
}
