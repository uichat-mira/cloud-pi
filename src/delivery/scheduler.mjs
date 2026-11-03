/**
 * Composition root: an existing scheduler plus the independent delivery stage.
 *
 * Nothing in `src/scheduler/` is modified for delivery. The wrapper observes the
 * public results the scheduler already produces — a terminal trigger returned by
 * `tick()`/`runNow()`, and terminal triggers replayed by startup recovery — and
 * hands them to the coordinator. Delivery is therefore a stage *after* the
 * scheduler's terminal state, not part of research execution.
 *
 * Why this wrapper instead of `startResearchFn`:
 *
 *   - the scheduler passes only `schedule.request` to `startResearch()`, so an
 *     executor wrapper cannot see the trusted `deliveryTargets` of the schedule;
 *   - a terminal run recovered after a restart never flows through
 *     `startResearchFn` at all, so it would still need a reconciliation pass.
 *
 * Both are visible in the scheduler's persisted trigger audit, which is what
 * this wrapper consumes. Delivery errors never change the scheduler result.
 */
import { createScheduler } from "../scheduler/index.mjs";
import { createDeliveryCoordinator } from "./coordinator.mjs";
import { DELIVERY_RUN_STATUS } from "./contracts.mjs";

/** Trigger statuses that have a research fact worth delivering. */
const DELIVERABLE_TRIGGER_STATUSES = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "timeout",
]);

function scheduleIdFromDedupeKey(dedupeKey) {
  if (typeof dedupeKey !== "string") return null;
  const at = dedupeKey.indexOf("@");
  return at > 0 ? dedupeKey.slice(0, at) : null;
}

/**
 * @param {object} [options]
 * @param {object} [options.schedulerOptions] forwarded to `createScheduler()`
 * @param {object} [options.delivery] coordinator options (`sendMessage` required
 *   unless `delivery.coordinator` is supplied)
 * @param {Function} [options.log]
 * @returns {Promise<{scheduler:object, coordinator:object, reconcile:Function, deliverTrigger:Function}>}
 */
export async function createDeliveringScheduler({ schedulerOptions = {}, delivery = {}, log = () => {} } = {}) {
  const scheduler = await createScheduler(schedulerOptions);
  const logger = delivery.logger ?? schedulerOptions.logger ?? {};
  const coordinator =
    delivery.coordinator ??
    createDeliveryCoordinator({
      stateDir: delivery.stateDir,
      env: delivery.env ?? schedulerOptions.env,
      now: delivery.now ?? schedulerOptions.now,
      sendMessage: delivery.sendMessage,
      researchRunsDir: delivery.researchRunsDir ?? schedulerOptions.researchDeps?.rootDir,
      readRun: delivery.readRun,
      limits: delivery.limits,
      logger,
      store: delivery.store,
    });

  const logDeliveryError = (message) => {
    logger.warn?.(`delivery: ${message}`);
    log({ level: "warn", event: "delivery_stage_failed", detail: String(message).slice(0, 300) });
  };

  async function deliverTrigger(trigger) {
    if (!trigger || !DELIVERABLE_TRIGGER_STATUSES.has(trigger.status) || !trigger.runId) {
      return null;
    }
    try {
      const scheduleId = scheduleIdFromDedupeKey(trigger.dedupeKey);
      const schedule = scheduleId ? scheduler.getSchedule(scheduleId) : null;
      return await coordinator.deliverTrigger({ schedule, trigger });
    } catch (error) {
      // Delivery is an independent stage: its failure must not turn a successful
      // research trigger into a scheduler failure.
      logDeliveryError(`trigger ${trigger?.dedupeKey ?? "unknown"} delivery raised: ${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * Replay at most `reconcilePerSchedule` recent terminal trigger(s) per
   * schedule that has targets. This is the restart path for "the run finished
   * but the process died before delivery". Already-sent destinations are
   * skipped by the coordinator, so replay is safe and bounded.
   */
  async function reconcile() {
    const limit = coordinator.limits.reconcilePerSchedule;
    const results = [];
    for (const schedule of scheduler.listSchedules()) {
      if (!Array.isArray(schedule.deliveryTargets) || schedule.deliveryTargets.length === 0) continue;
      const terminal = (schedule.triggers ?? []).filter(
        (trigger) => trigger.runId && DELIVERABLE_TRIGGER_STATUSES.has(trigger.status),
      );
      for (const trigger of terminal.slice(-limit)) {
        results.push(await deliverTrigger(trigger));
      }
    }
    return results;
  }

  const originalTick = scheduler.tick.bind(scheduler);
  scheduler.tick = async (...args) => {
    const result = await originalTick(...args);
    for (const trigger of result?.triggered ?? []) {
      await deliverTrigger(trigger);
    }
    return result;
  };

  const originalRunNow = scheduler.runNow.bind(scheduler);
  scheduler.runNow = async (...args) => {
    const trigger = await originalRunNow(...args);
    await deliverTrigger(trigger);
    return trigger;
  };

  const originalStart = scheduler.start.bind(scheduler);
  scheduler.start = async (...args) => {
    const result = await originalStart(...args);
    await reconcile();
    return result;
  };

  // Startup reconciliation even before `start()`: a caller that only inspects
  // or runs `tick()` manually still recovers an undelivered terminal run.
  await reconcile();

  return {
    scheduler,
    coordinator,
    reconcile,
    deliverTrigger,
    /** The delivery fact for one run, or null when nothing was ever attempted. */
    getRunDelivery: (runId) => coordinator.getRunDelivery(runId),
    /** Convenience: current aggregate delivery status for the last run. */
    getLastRunDelivery: async (scheduleId) => {
      const schedule = scheduler.getSchedule(scheduleId);
      const runId = schedule.lastRun?.runId;
      if (!runId) return { deliveryStatus: DELIVERY_RUN_STATUS.NONE, runId: null };
      return (await coordinator.getRunDelivery(runId)) ?? {
        deliveryStatus: DELIVERY_RUN_STATUS.NONE,
        runId,
        researchStatus: schedule.lastRun?.researchStatus ?? null,
        triggerStatus: schedule.lastRun?.status ?? null,
        counts: { total: 0, sent: 0, failed: 0, pending: 0 },
        targets: [],
      };
    },
  };
}
