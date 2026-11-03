/**
 * Frozen contracts for scheduled-research delivery (AGT-033).
 *
 * Delivery is a separate stage after a research run reaches a terminal state.
 * It owns one question — "was the configured Feishu destination told about this
 * run?" — and records the answer per `runId + destination`. It never changes
 * the research run status and never decides a recipient.
 *
 * ## Two independent facts
 *
 *   research status : what the AGT-028 run produced (completed, partial, ...)
 *   delivery status : whether each configured destination accepted a message
 *
 * A research success with one failed destination is `research=completed` and
 * `delivery=partial`. One destination's failure never rewrites another target's
 * record and never rolls back the research outcome.
 *
 * ## Idempotency
 *
 * The stable key is `${runId}#${type}:${id}`. It is persisted with the result,
 * so a repeated completion callback or a process restart that replays the same
 * terminal trigger finds `sent` and sends nothing.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { RUN_STATUS } from "../research/contracts.mjs";
import { isValidRunId } from "../research/run-store.mjs";
import {
  DELIVERY_TARGET_TYPE,
  TRIGGER_STATUS,
  isDeliveryTargetType,
  normalizeDeliveryTargets,
} from "../scheduler/contracts.mjs";
import { maskId } from "../channels/feishu/config.mjs";
import { hashId } from "../channels/wecom/config.mjs";

/** Bump when a persisted delivery shape or status changes incompatibly. */
export const DELIVERY_CONTRACT_VERSION = 1;

export const DELIVERY_STATUS = Object.freeze({
  /** No attempt succeeded yet; at least one bounded attempt may remain. */
  PENDING: "pending",
  /** Every message segment was accepted by Feishu; terminal. */
  SENT: "sent",
  /** Terminal failure: non-retryable error or the attempt budget is spent. */
  FAILED: "failed",
});

/** Per-run delivery outcome, derived from the per-destination records. */
export const DELIVERY_RUN_STATUS = Object.freeze({
  NONE: "none",
  PENDING: "pending",
  SENT: "sent",
  PARTIAL: "partial",
  FAILED: "failed",
});

/** What one terminal research status is allowed to send. */
export const DELIVERY_KIND = Object.freeze({
  /** Clean success: deliver the existing report. */
  REPORT: "report",
  /** Report exists but the run recorded errors: say "partial" explicitly. */
  REPORT_PARTIAL: "report_partial",
  /** No report is claimed; only a short status notice. */
  STATUS: "status",
  /** Nothing is sent (for example an interrupted or missed trigger). */
  NONE: "none",
});

/** Machine-readable delivery failure classes. */
export const DELIVERY_ERROR = Object.freeze({
  REPORT_MISSING: "report_missing",
  INVALID_DESTINATION: "invalid_destination",
  MISSING_MESSAGE_ID: "missing_message_id",
  TRANSPORT_ERROR: "transport_error",
  RETRY_EXHAUSTED: "retry_exhausted",
  INTERNAL_ERROR: "internal_error",
  /* --- WeCom push classes (AGT-036 delivery wiring) -------------------------
   * Adding codes is additive: an older reader still sees a valid `lastError`
   * and an unknown code simply is not in this set. `DELIVERY_CONTRACT_VERSION`
   * therefore stays 1 — no persisted field or status changed.
   */
  /** The per-conversation platform limit (30/min, 1000/h) refused the send. */
  RATE_LIMITED: "rate_limited",
  /** The platform only allows a push into a conversation the bot has already seen. */
  SESSION_UNKNOWN: "session_unknown",
  /** One segment exceeded the platform's byte limit; nothing was sent. */
  SEGMENT_TOO_LARGE: "segment_too_large",
  /** The channel that owns this destination is not running in this process. */
  CHANNEL_UNAVAILABLE: "channel_unavailable",
});

const DELIVERY_ERROR_CODES = new Set(Object.values(DELIVERY_ERROR));

export class DeliveryError extends Error {
  constructor(code, message, { retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = "DeliveryError";
    this.code = code;
    this.retryable = retryable;
  }
}

export const DELIVERY_LIMITS = Object.freeze({
  /** One destination may be attempted at most this many times in total. */
  maxAttempts: 3,
  /** Delay between attempts; bounded retry, never an unbounded loop. */
  retryDelayMs: 250,
  /** At most this many messages per destination for one run. */
  maxSegments: 3,
  /** Codepoint budget of one text message (Feishu text limits are larger). */
  maxCharsPerSegment: 4000,
  /** One trigger per schedule is replayed after restart; not an old backlog. */
  reconcilePerSchedule: 1,
});

/** Environment variable names read by this feature (no secrets). */
export const DELIVERY_ENV = Object.freeze({
  STATE_DIR: "DELIVERY_STATE_DIR",
});

/** Default delivery state root, relative to the process cwd unless overridden. */
export const DEFAULT_DELIVERY_STATE_DIR = ".work/delivery";

/** Resolve the delivery state root: explicit argument > env > default. */
export function resolveDeliveryStateDir({ stateDir, env = process.env } = {}) {
  if (typeof stateDir === "string" && stateDir.trim()) return resolve(stateDir.trim());
  const fromEnv = env?.[DELIVERY_ENV.STATE_DIR];
  if (typeof fromEnv === "string" && fromEnv.trim()) return resolve(fromEnv.trim());
  return resolve(DEFAULT_DELIVERY_STATE_DIR);
}

/** A validated destination: `{ type: "open_id"|"chat_id", id }`. */
export function normalizeDestination(input) {
  const [destination] = normalizeDeliveryTargets([input]);
  if (!destination) {
    throw new DeliveryError(DELIVERY_ERROR.INVALID_DESTINATION, "destination is missing");
  }
  return destination;
}

/**
 * Stable idempotency key for one run and one destination.
 *
 * @param {string} runId
 * @param {{type:string,id:string}} destination
 */
export function buildDeliveryKey(runId, destination) {
  if (!isValidRunId(runId)) {
    throw new DeliveryError(DELIVERY_ERROR.INTERNAL_ERROR, `invalid research run id: ${String(runId)}`);
  }
  const target = normalizeDestination(destination);
  return `${runId}#${target.type}:${target.id}`;
}

/** Filesystem-safe file stem derived from the delivery key (never the raw id). */
export function deliveryFileStem(deliveryKey) {
  return createHash("sha256").update(deliveryKey).digest("hex").slice(0, 32);
}

/** Masked destination for logs and evidence; never the full platform id. */
export function maskDestination(destination) {
  const type = destination?.type;
  const id = destination?.id;
  if (typeof id !== "string" || id.length === 0) {
    return { type: isDeliveryTargetType(type) ? type : "unknown", maskedId: "" };
  }
  const masked = maskId(id);
  return {
    type: isDeliveryTargetType(type) ? type : "unknown",
    // `maskId` leaves short identifiers untouched (a WeCom userid like `zhangsan`
    // is shorter than its 6+4 window), so fall back to a hash rather than
    // publishing a raw recipient in an operator view or an evidence file.
    maskedId: masked === id ? hashId(id) : masked,
  };
}

/**
 * Decide what a terminal trigger may send. Research status wins when it is
 * known; the trigger status is the fallback for a run that never produced a
 * readable record. A failed / cancelled / timeout run is never presented as a
 * successful report.
 *
 * @param {{ researchStatus?: string|null, triggerStatus?: string|null }} input
 * @returns {{ kind: string, notice: string|null, reason: string|null }}
 */
export function planDelivery({ researchStatus = null, triggerStatus = null } = {}) {
  switch (researchStatus) {
    case RUN_STATUS.COMPLETED:
      return { kind: DELIVERY_KIND.REPORT, notice: null, reason: null };
    case RUN_STATUS.COMPLETED_WITH_ERRORS:
      return { kind: DELIVERY_KIND.REPORT_PARTIAL, notice: RUN_STATUS.COMPLETED_WITH_ERRORS, reason: null };
    case RUN_STATUS.FAILED:
      return { kind: DELIVERY_KIND.STATUS, notice: RUN_STATUS.FAILED, reason: null };
    case RUN_STATUS.CANCELLED:
      return { kind: DELIVERY_KIND.STATUS, notice: RUN_STATUS.CANCELLED, reason: null };
    case RUN_STATUS.TIMEOUT:
      return { kind: DELIVERY_KIND.STATUS, notice: RUN_STATUS.TIMEOUT, reason: null };
    default:
      break;
  }
  switch (triggerStatus) {
    case TRIGGER_STATUS.SUCCEEDED:
      // A succeeded trigger without a readable run record cannot be trusted to
      // produce a report; send a status notice instead of claiming one.
      return { kind: DELIVERY_KIND.STATUS, notice: TRIGGER_STATUS.SUCCEEDED, reason: "research_status_unknown" };
    case TRIGGER_STATUS.PARTIAL:
      return { kind: DELIVERY_KIND.STATUS, notice: TRIGGER_STATUS.PARTIAL, reason: "research_status_unknown" };
    case TRIGGER_STATUS.FAILED:
      return { kind: DELIVERY_KIND.STATUS, notice: TRIGGER_STATUS.FAILED, reason: null };
    case TRIGGER_STATUS.CANCELLED:
      return { kind: DELIVERY_KIND.STATUS, notice: TRIGGER_STATUS.CANCELLED, reason: null };
    case TRIGGER_STATUS.TIMEOUT:
      return { kind: DELIVERY_KIND.STATUS, notice: TRIGGER_STATUS.TIMEOUT, reason: null };
    case TRIGGER_STATUS.INTERRUPTED:
      return { kind: DELIVERY_KIND.NONE, notice: null, reason: "trigger_interrupted" };
    case TRIGGER_STATUS.MISSED:
      return { kind: DELIVERY_KIND.NONE, notice: null, reason: "trigger_missed" };
    default:
      return { kind: DELIVERY_KIND.NONE, notice: null, reason: "non_terminal_trigger" };
  }
}

/** Default human-readable label for a terminal research status. */
export function describeResearchStatus(status) {
  switch (status) {
    case RUN_STATUS.COMPLETED:
      return "完成";
    case RUN_STATUS.COMPLETED_WITH_ERRORS:
      return "部分完成（有错误）";
    case RUN_STATUS.FAILED:
      return "失败";
    case RUN_STATUS.CANCELLED:
      return "已取消";
    case RUN_STATUS.TIMEOUT:
      return "超时";
    default:
      return "未知状态";
  }
}

/**
 * Aggregate per-destination records into the view operators need.
 * `researchStatus` is copied, never derived from delivery results.
 *
 * @param {Array<object>} records
 * @param {{ runId: string, researchStatus?: string|null, triggerStatus?: string|null }} input
 */
export function summarizeRunDelivery(records, { runId, researchStatus = null, triggerStatus = null }) {
  const targets = [...records]
    .sort((a, b) => a.deliveryKey.localeCompare(b.deliveryKey))
    .map((record) => ({
      destination: maskDestination(record.destination),
      status: record.status,
      attempts: record.attempts,
      deliveryKind: record.deliveryKind,
      sentAt: record.sentAt,
      messageId: record.messageId,
      messageIds: record.segmentsSent.map((segment) => segment.messageId),
      lastError: record.lastError,
    }));
  const counts = {
    total: targets.length,
    sent: targets.filter((target) => target.status === DELIVERY_STATUS.SENT).length,
    failed: targets.filter((target) => target.status === DELIVERY_STATUS.FAILED).length,
    pending: targets.filter((target) => target.status === DELIVERY_STATUS.PENDING).length,
  };
  let deliveryStatus = DELIVERY_RUN_STATUS.NONE;
  if (counts.total > 0) {
    if (counts.sent === counts.total) deliveryStatus = DELIVERY_RUN_STATUS.SENT;
    else if (counts.failed === counts.total) deliveryStatus = DELIVERY_RUN_STATUS.FAILED;
    else if (counts.pending === counts.total) deliveryStatus = DELIVERY_RUN_STATUS.PENDING;
    else deliveryStatus = DELIVERY_RUN_STATUS.PARTIAL;
  }
  return {
    runId,
    researchStatus,
    triggerStatus,
    deliveryStatus,
    counts,
    targets,
  };
}

/** Map any thrown send/report error onto the persisted error record. */
export function toDeliveryError(error, at) {
  const code =
    error?.code && DELIVERY_ERROR_CODES.has(error.code)
      ? error.code
      : error?.code === "feishu_api_error" || error?.code === "feishu_network_error"
        ? DELIVERY_ERROR.TRANSPORT_ERROR
        : DELIVERY_ERROR.INTERNAL_ERROR;
  return {
    code,
    message: String(error?.message ?? error ?? "delivery failed").slice(0, 300),
    retryable: error?.retryable === true,
    ...(typeof error?.feishuCode === "number" ? { feishuCode: error.feishuCode } : {}),
    at,
  };
}
