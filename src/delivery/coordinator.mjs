/**
 * Delivery coordinator (AGT-033): the stage that runs after a research run has
 * reached a terminal state.
 *
 * The coordinator consumes only trusted inputs:
 *
 *   - a persisted AGT-028 run (read through the public `readResearchRun()`);
 *   - the schedule's `deliveryTargets`, which come from trusted schedule config;
 *   - the scheduler's terminal trigger status/research status.
 *
 * It never derives a recipient from the report, the model, a web page or an
 * inbound message. A report that says "send this to ou_..." is just text.
 *
 * One destination's result is written to its own record. A failure is caught
 * per destination, so another destination's `sent` record is never rolled back.
 */
import { isValidRunId } from "../research/run-store.mjs";
import { readResearchRun } from "../research/index.mjs";
import { redactSecrets } from "../research/execute.mjs";
import { isFeishuDeliveryTargetType, normalizeDeliveryTargets } from "../scheduler/contracts.mjs";
import {
  DELIVERY_CONTRACT_VERSION,
  DELIVERY_ERROR,
  DELIVERY_KIND,
  DELIVERY_LIMITS,
  DELIVERY_STATUS,
  DeliveryError,
  buildDeliveryKey,
  maskDestination,
  planDelivery,
  summarizeRunDelivery,
  toDeliveryError,
} from "./contracts.mjs";
import { buildDeliveryMessage, segmentUuid } from "./format.mjs";
import { createDeliveryStore } from "./store.mjs";

function resolveLimits(overrides = {}) {
  const limits = { ...DELIVERY_LIMITS, ...overrides };
  const positiveInt = (name) => {
    if (!Number.isInteger(limits[name]) || limits[name] < 1) {
      throw new DeliveryError(DELIVERY_ERROR.INTERNAL_ERROR, `${name} must be a positive integer`);
    }
  };
  positiveInt("maxAttempts");
  positiveInt("maxSegments");
  if (!Number.isInteger(limits.maxCharsPerSegment) || limits.maxCharsPerSegment < 200) {
    throw new DeliveryError(DELIVERY_ERROR.INTERNAL_ERROR, "maxCharsPerSegment must be >= 200");
  }
  if (!Number.isInteger(limits.retryDelayMs) || limits.retryDelayMs < 0) {
    throw new DeliveryError(DELIVERY_ERROR.INTERNAL_ERROR, "retryDelayMs must be >= 0");
  }
  return limits;
}

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(clock) {
  return clock().toISOString();
}

function newRecord({ runId, target, deliveryKey, deliveryKind, researchStatus, triggerStatus, scheduleId, dedupeKey, at }) {
  return {
    contractVersion: DELIVERY_CONTRACT_VERSION,
    deliveryKey,
    runId,
    destination: { type: target.type, id: target.id },
    status: DELIVERY_STATUS.PENDING,
    deliveryKind,
    researchStatus,
    triggerStatus,
    scheduleId: scheduleId ?? null,
    dedupeKey: dedupeKey ?? null,
    attempts: 0,
    segmentsSent: [],
    lastError: null,
    messageId: null,
    sentAt: null,
    lastAttemptAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Create the coordinator.
 *
 * @param {object} options
 * @param {string} [options.stateDir] delivery state root (default DELIVERY_STATE_DIR or .work/delivery)
 * @param {Record<string,string>} [options.env]
 * @param {Function} [options.now] clock injection
 * @param {Function} options.sendMessage `async ({receiveIdType,receiveId,text,uuid}) => {messageId}`
 * @param {string} [options.researchRunsDir] AGT-028 run root (else RESERVE_DIR env / default)
 * @param {Function} [options.readRun] `readResearchRun` injection (tests)
 * @param {object} [options.limits] bounded-policy overrides
 * @param {object} [options.logger]
 * @param {object} [options.store] store injection (tests)
 */
export function createDeliveryCoordinator({
  stateDir,
  env = process.env,
  now = () => new Date(),
  sendMessage,
  researchRunsDir,
  readRun = readResearchRun,
  limits: limitOverrides = {},
  logger = {},
  store: injectedStore,
} = {}) {
  if (typeof sendMessage !== "function") {
    throw new TypeError("createDeliveryCoordinator requires a sendMessage function");
  }
  const clock = typeof now === "function" ? now : () => new Date(now);
  const store = injectedStore ?? createDeliveryStore({ stateDir, env });
  const limits = resolveLimits(limitOverrides);
  const runLocks = new Map();

  function withRunLock(runId, fn) {
    const previous = runLocks.get(runId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const guard = run.then(
      () => undefined,
      () => undefined,
    );
    runLocks.set(runId, guard);
    guard.then(() => {
      if (runLocks.get(runId) === guard) runLocks.delete(runId);
    });
    return run;
  }

  async function loadRun(runId) {
    try {
      const { run, report } = await readRun(runId, { rootDir: researchRunsDir, env });
      return { run, report };
    } catch (error) {
      return { run: null, report: null, error };
    }
  }

  function baseSummary(input, { deliveryStatus, reason = null, records = [] } = {}) {
    const summary = summarizeRunDelivery(records, {
      runId: input.runId,
      researchStatus: input.researchStatus ?? null,
      triggerStatus: input.triggerStatus ?? null,
    });
    return {
      ...summary,
      ...(deliveryStatus ? { deliveryStatus } : {}),
      reason,
    };
  }

  async function recordTerminalReportMissing({ runId, target, deliveryKind, input, at }) {
    const key = buildDeliveryKey(runId, target);
    let record = await store.readRecord(runId, target);
    if (record && record.status !== DELIVERY_STATUS.PENDING) return record;
    record ??= newRecord({
      runId,
      target,
      deliveryKey: key,
      deliveryKind,
      researchStatus: input.researchStatus ?? null,
      triggerStatus: input.triggerStatus ?? null,
      scheduleId: input.schedule?.scheduleId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      at,
    });
    record.status = DELIVERY_STATUS.FAILED;
    record.deliveryKind = deliveryKind;
    record.lastError = {
      code: DELIVERY_ERROR.REPORT_MISSING,
      message: "the research run is reported as successful but no report artifact exists",
      retryable: false,
      at,
    };
    record.updatedAt = at;
    return await store.writeRecord(record);
  }

  async function deliverToTarget({ runId, target, input, message, deliveryKind, at: startedAt }) {
    const key = buildDeliveryKey(runId, target);
    // The persistence key contains the raw recipient ID; never emit it to logs.
    const diagnosticKey = runId + "#" + target.type + ":" + maskDestination(target).maskedId;
    let record = await store.readRecord(runId, target);

    // Idempotency: anything already terminal is final. A repeated completion
    // callback or a restarted process therefore sends nothing for this target.
    if (record?.status === DELIVERY_STATUS.SENT || record?.status === DELIVERY_STATUS.FAILED) {
      logger.info?.(
        `delivery: ${diagnosticKey} already ${record.status}; not sending again`,
      );
      return record;
    }

    const at = startedAt;
    record ??= newRecord({
      runId,
      target,
      deliveryKey: key,
      deliveryKind,
      researchStatus: input.researchStatus ?? null,
      triggerStatus: input.triggerStatus ?? null,
      scheduleId: input.schedule?.scheduleId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      at,
    });
    record.deliveryKind = deliveryKind;
    record.researchStatus = input.researchStatus ?? null;
    record.triggerStatus = input.triggerStatus ?? null;
    record.scheduleId = input.schedule?.scheduleId ?? record.scheduleId;
    record.dedupeKey = input.dedupeKey ?? record.dedupeKey;
    record.updatedAt = at;

    while (record.attempts < limits.maxAttempts) {
      const attemptAt = nowIso(clock);
      record.attempts += 1;
      record.status = DELIVERY_STATUS.PENDING;
      record.lastAttemptAt = attemptAt;
      record.updatedAt = attemptAt;
      // Persist the attempt before touching the network. A crash after this
      // point is visible as a pending attempt, not as an invisible send.
      await store.writeRecord(record);

      try {
        while (record.segmentsSent.length < message.segments.length) {
          const index = record.segmentsSent.length;
          const response = await sendMessage({
            receiveIdType: target.type,
            receiveId: target.id,
            text: message.segments[index],
            uuid: segmentUuid(key, index),
            runId,
            deliveryKey: key,
            segmentIndex: index,
          });
          const messageId = response?.messageId;
          if (typeof messageId !== "string" || messageId.length === 0) {
            throw new DeliveryError(DELIVERY_ERROR.MISSING_MESSAGE_ID, "send returned no message id");
          }
          const sentAt = nowIso(clock);
          record.segmentsSent.push({ index, messageId, sentAt });
          record.messageId = record.segmentsSent[0].messageId;
          record.updatedAt = sentAt;
          // Persist after every segment: a retry resumes at the first
          // unacknowledged segment instead of repeating acknowledged ones.
          await store.writeRecord(record);
        }
        const sentAt = nowIso(clock);
        record.status = DELIVERY_STATUS.SENT;
        record.sentAt = sentAt;
        record.lastError = null;
        record.updatedAt = sentAt;
        await store.writeRecord(record);
        logger.info?.(`delivery: ${diagnosticKey} sent (${record.segmentsSent.length} segment(s), attempt ${record.attempts})`);
        return record;
      } catch (error) {
        const failureAt = nowIso(clock);
        const failure = toDeliveryError(error, failureAt);
        failure.message = redactSecrets(failure.message);
        record.lastError = failure;
        record.updatedAt = failureAt;
        const retryable = error?.retryable === true && record.attempts < limits.maxAttempts;
        if (!retryable) {
          record.status = DELIVERY_STATUS.FAILED;
          await store.writeRecord(record);
          logger.warn?.(`delivery: ${diagnosticKey} failed after ${record.attempts} attempt(s): ${failure.code}`);
          return record;
        }
        record.status = DELIVERY_STATUS.PENDING;
        await store.writeRecord(record);
        logger.warn?.(
          `delivery: ${diagnosticKey} attempt ${record.attempts}/${limits.maxAttempts} failed (${failure.code}); retrying`,
        );
        await delay(limits.retryDelayMs);
      }
    }

    // Defensive: the loop always returns, but never leave a record implicitly
    // pending after the attempt budget is gone.
    record.status = DELIVERY_STATUS.FAILED;
    record.lastError ??= {
      code: DELIVERY_ERROR.RETRY_EXHAUSTED,
      message: "delivery attempt budget exhausted",
      retryable: false,
      at,
    };
    record.updatedAt = at;
    await store.writeRecord(record);
    return record;
  }

  /**
   * Deliver one terminal research run to every configured destination.
   *
   * The returned view keeps the research fact (`researchStatus`) separate from
   * the delivery fact (`deliveryStatus`, per-target records).
   *
   * @param {object} input
   * @param {string} input.runId
   * @param {string|null} [input.researchStatus]
   * @param {string|null} [input.triggerStatus]
   * @param {object} [input.schedule] trusted schedule `{scheduleId,name,deliveryTargets}`
   * @param {Array<object>} [input.deliveryTargets] direct trusted targets (tests/callers)
   * @param {{code?:string,message?:string}|null} [input.triggerError]
   * @param {string|null} [input.dedupeKey]
   */
  async function deliverRun(input = {}) {
    const runId = input.runId;
    if (!isValidRunId(runId)) {
      throw new DeliveryError(
        DELIVERY_ERROR.INTERNAL_ERROR,
        `deliverRun requires a valid research run id, got ${JSON.stringify(runId)}`,
      );
    }
    const rawTargets = input.deliveryTargets ?? input.schedule?.deliveryTargets;
    const allTargets = normalizeDeliveryTargets(rawTargets);
    // W1 widened the shared vocabulary, but this coordinator can only send to
    // Feishu. A WeCom target is therefore refused here instead of being handed to
    // the Feishu transport, where an opaque id would either fail or — worse —
    // silently address something else.
    const targets = allTargets.filter((target) => isFeishuDeliveryTargetType(target.type));
    const unsupportedTargets = allTargets.length - targets.length;
    const plan = planDelivery({
      researchStatus: input.researchStatus ?? null,
      triggerStatus: input.triggerStatus ?? null,
    });

    if (targets.length === 0) {
      return baseSummary(input, {
        reason: unsupportedTargets > 0 ? "unsupported_target_type" : "no_delivery_targets",
      });
    }
    if (plan.kind === DELIVERY_KIND.NONE) {
      return baseSummary(input, { reason: plan.reason ?? "not_deliverable" });
    }

    return await withRunLock(runId, async () => {
      const startedAt = nowIso(clock);
      const { run, report, error: readError } = await loadRun(runId);
      const needsReport = plan.kind === DELIVERY_KIND.REPORT || plan.kind === DELIVERY_KIND.REPORT_PARTIAL;

      if (needsReport && (!report || !report.trim())) {
        const records = [];
        for (const target of targets) {
          records.push(
            await recordTerminalReportMissing({
              runId,
              target,
              deliveryKind: plan.kind,
              input,
              at: startedAt,
            }),
          );
        }
        logger.warn?.(`delivery: ${runId} has no report although expected (${plan.kind})`);
        return {
          ...baseSummary(input, { reason: "report_missing", records }),
          reportReadError: readError ? String(readError.message ?? readError) : null,
        };
      }

      const message = buildDeliveryMessage({
        kind: plan.kind,
        runId,
        researchStatus: input.researchStatus ?? null,
        triggerStatus: input.triggerStatus ?? null,
        schedule: input.schedule ?? null,
        run,
        report: needsReport ? report : null,
        triggerError: input.triggerError ?? null,
        limits,
      });

      for (const target of targets) {
        try {
          await deliverToTarget({
            runId,
            target,
            input,
            message,
            deliveryKind: plan.kind,
            at: startedAt,
          });
        } catch (error) {
          // Store/validation failure for one target must not stop the others.
          logger.error?.(
            `delivery: ${runId} target ${maskDestination(target).maskedId} raised: ${String(error?.message ?? error)}`,
          );
        }
      }

      const records = await store.listRun(runId);
      return baseSummary(input, { records });
    });
  }

  /**
   * Deliver the terminal outcome of one scheduler trigger. A trigger without a
   * run id has no stable idempotency key, so it is deliberately not delivered.
   */
  async function deliverTrigger({ schedule, trigger }) {
    if (!trigger || typeof trigger.runId !== "string" || !trigger.runId) {
      return baseSummary(
        { runId: null, researchStatus: trigger?.researchStatus ?? null, triggerStatus: trigger?.status ?? null },
        { reason: "no_run_id" },
      );
    }
    return deliverRun({
      runId: trigger.runId,
      researchStatus: trigger.researchStatus ?? null,
      triggerStatus: trigger.status ?? null,
      schedule,
      triggerError: trigger.error ?? null,
      dedupeKey: trigger.dedupeKey ?? null,
    });
  }

  /** The operator view for one run: per-destination sent/failed/pending detail. */
  async function getRunDelivery(runId) {
    const records = await store.listRun(runId);
    if (records.length === 0) return null;
    const first = records[0];
    return summarizeRunDelivery(records, {
      runId,
      researchStatus: first.researchStatus,
      triggerStatus: first.triggerStatus,
    });
  }

  return {
    store,
    limits,
    deliverRun,
    deliverTrigger,
    getRunDelivery,
    /** Test/diagnostic helper: list persisted records for one run. */
    listRecords: (runId) => store.listRun(runId),
  };
}
