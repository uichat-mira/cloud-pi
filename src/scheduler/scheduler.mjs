/**
 * Single-process scheduler engine for the AGT-030 POC.
 *
 * Responsibilities are deliberately narrow:
 *
 *   - decide when a schedule is due (IANA time zone, explicit persisted clock);
 *   - claim exactly one logical occurrence with a stable dedupe key;
 *   - call the existing AGT-028 `startResearch()` entry point, which is the
 *     non-blocking public form of `executeResearch()` and persists `run.json`
 *     before returning the run id;
 *   - release the per-schedule lease after success, failure, cancellation,
 *     timeout or an interrupted process, and keep the trigger audit trail.
 *
 * It does not assemble a Pi runtime, call a model, read credentials, write a
 * report or duplicate the run store. Tests inject a deterministic runtime port
 * and tool layer; the executor itself is never mocked.
 */
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { isTerminalStatus } from "../research/contracts.mjs";
import { redactSecrets } from "../research/execute.mjs";
import {
  normalizeResearchRequest,
  readResearchRun,
  startResearch,
} from "../research/index.mjs";
import {
  LIMITS,
  SCHEDULE_KIND,
  SCHEDULE_STATUS,
  SCHEDULER_ERROR,
  TRIGGER_STATUS,
  SchedulerError,
  isTerminalTriggerStatus,
  mapResearchStatusToTriggerStatus,
} from "./contracts.mjs";
import {
  cloneSchedule,
  collectDueOccurrences,
  computeNextRunAt,
  enumerateMissedOccurrences,
  makeDedupeKey,
  makeManualDedupeKey,
  normalizeScheduleInput,
} from "./schedule.mjs";
import { createScheduleStore } from "./store.mjs";

const DEFAULT_TICK_INTERVAL_MS = 30_000;

/**
 * Business fields a management caller may change in place. Identity, status,
 * leases, trigger history and statistics are never writable through an update:
 * lifecycle changes go through pause/enable and the scheduler's own state
 * machine, so an API cannot forge a lease or skip a persisted occurrence.
 */
const UPDATABLE_SCHEDULE_FIELDS = new Set(["name", "timezone", "kind", "cron", "at", "request"]);
const TIMING_FIELDS = ["kind", "timezone", "cron", "at"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveClock(nowOption) {
  if (typeof nowOption === "function") {
    return () => {
      const value = nowOption();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) throw new SchedulerError(SCHEDULER_ERROR.INVALID_REQUEST, "now() returned an invalid date");
      return date;
    };
  }
  const fixed = nowOption === undefined ? null : nowOption instanceof Date ? nowOption : new Date(nowOption);
  if (fixed && Number.isNaN(fixed.getTime())) {
    throw new SchedulerError(SCHEDULER_ERROR.INVALID_REQUEST, "now must be a valid date");
  }
  return () => (fixed ? new Date(fixed.getTime()) : new Date());
}

function bumpStat(stats, status) {
  if (Object.prototype.hasOwnProperty.call(stats, status)) stats[status] += 1;
}

function errorFromRun(record, at) {
  const first = Array.isArray(record?.errors) ? record.errors[0] : null;
  if (!first) return null;
  return {
    code: typeof first.code === "string" ? first.code : "internal_error",
    message: redactSecrets(String(first.message ?? "")).slice(0, 500),
    at,
  };
}

function errorRecord(code, message, at) {
  return {
    code: typeof code === "string" && code ? code : "executor_error",
    message: redactSecrets(String(message ?? "")).slice(0, 500),
    at,
  };
}

/**
 * Create and load a scheduler bound to one state directory.
 *
 * @param {object} [options]
 * @param {string} [options.stateDir] state root (default: SCHEDULER_STATE_DIR or .work/scheduler)
 * @param {Record<string,string>} [options.env]
 * @param {Date|string|(() => Date)} [options.now] injected clock (tests/evidence)
 * @param {object} [options.researchDeps] `{ runtimePort, toolLayer, rootDir, env, logger }`
 * @param {Function} [options.startResearchFn] executor entry override (T2 contract tests only)
 * @param {Function} [options.readResearchRunFn] run-reader override (T2 contract tests only)
 * @param {object} [options.logger]
 * @param {number} [options.tickIntervalMs]
 * @param {object} [options.store] store override
 */
export async function createScheduler(options = {}) {
  const scheduler = new Scheduler(options);
  await scheduler.load();
  return scheduler;
}

class Scheduler {
  constructor(options = {}) {
    this._clock = resolveClock(options.now);
    this._store = options.store ?? createScheduleStore({ stateDir: options.stateDir, env: options.env });
    this._logger = options.logger ?? {};
    this._researchDeps = { ...(options.researchDeps ?? {}) };
    this._startResearch = options.startResearchFn ?? startResearch;
    this._readRun = options.readResearchRunFn ?? readResearchRun;
    this._tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    if (!Number.isFinite(this._tickIntervalMs) || this._tickIntervalMs < LIMITS.minTickIntervalMs) {
      throw new SchedulerError(SCHEDULER_ERROR.INVALID_REQUEST, "tickIntervalMs is below the minimum");
    }

    this._schedules = new Map();
    this._running = false;
    this._timer = null;
    this._disposed = false;
    this._recovered = false;
    this._stateChain = Promise.resolve();
    this._slotFree = true;
    this._abortGeneration = 0;
    this._background = new Set();
    this._controllers = new Map();
  }

  get stateDir() {
    return this._store.rootDir;
  }

  /**
   * Re-read every schedule from disk. Does not fire anything.
   *
   * Startup / idle-only. The reload replaces every in-memory schedule object,
   * so it must not overlap an execution that is already under way: that run
   * keeps the previous object, releases its lease against it and writes that
   * object to disk, while this instance would still hold the reloaded copy —
   * including its stale `activeTrigger` — and skip the schedule from then on.
   * A busy instance gets `scheduler_busy` instead of a hot reload. Lease
   * recovery stays the job of `start()`, which runs again after a reload.
   */
  async load() {
    this._assertUsable();
    return this._withStateLock(async () => {
      this._assertIdle("load()");
      const records = await this._store.list();
      this._schedules = new Map(records.map((record) => [record.scheduleId, record]));
      this._recovered = false;
      return this;
    });
  }

  listSchedules() {
    return [...this._schedules.values()]
      .sort((a, b) => {
        const delta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        return delta !== 0 ? delta : a.scheduleId.localeCompare(b.scheduleId);
      })
      .map((schedule) => cloneSchedule(schedule));
  }

  getSchedule(scheduleId) {
    return cloneSchedule(this._require(scheduleId));
  }

  async createSchedule(input) {
    return this._withStateLock(async () => {
      this._assertUsable();
      if (this._schedules.size >= LIMITS.maxSchedules) {
        throw new SchedulerError(
          SCHEDULER_ERROR.INVALID_REQUEST,
          `at most ${LIMITS.maxSchedules} schedules are supported by this POC`,
        );
      }
      const record = normalizeScheduleInput(input, { now: this._now() });
      if (this._schedules.has(record.scheduleId)) {
        throw new SchedulerError(
          SCHEDULER_ERROR.CONFLICT,
          `schedule ${record.scheduleId} already exists`,
        );
      }
      await this._store.write(record);
      this._schedules.set(record.scheduleId, record);
      return cloneSchedule(record);
    });
  }

  /**
   * Change business fields of a stored schedule without bypassing the state
   * machine. This is the minimal mutation a management API needs; it is not a
   * general record editor.
   *
   * - Only `name`, `timezone`, `kind`, `cron`, `at` and `request` are accepted.
   *   Unknown, internal and lifecycle fields (including `enabled`/`status`) are
   *   refused: pause()/enable() are the only activation paths, so an update
   *   cannot replay a missed occurrence or preserve a past `nextRunAt` as active.
   * - An in-flight run (`activeTrigger` or a live controller) fails closed with
   *   `conflict`: writing the definition under an execution that will later
   *   release its lease against the old object would leave a stale lease.
   * - When only non-timing fields change, `nextRunAt`/`status` are preserved, so
   *   a due-but-not-yet-claimed occurrence is not silently skipped.
   * - A completed schedule can be edited only together with a new future
   *   timing, which intentionally starts a fresh activation; history and stats
   *   are kept as audit.
   *
   * @param {string} scheduleId
   * @param {object} patch
   */
  async updateSchedule(scheduleId, patch) {
    if (!isPlainObject(patch)) {
      throw new SchedulerError(SCHEDULER_ERROR.INVALID_REQUEST, "update requires a JSON object");
    }
    const fields = Object.keys(patch);
    if (fields.length === 0) {
      throw new SchedulerError(SCHEDULER_ERROR.INVALID_REQUEST, "update requires at least one field");
    }
    const unsupported = fields.filter((field) => !UPDATABLE_SCHEDULE_FIELDS.has(field));
    if (unsupported.length > 0) {
      throw new SchedulerError(
        SCHEDULER_ERROR.INVALID_REQUEST,
        `unsupported schedule fields: ${unsupported.join(", ")}`,
      );
    }
    return this._withStateLock(async () => {
      this._assertUsable();
      const current = this._require(scheduleId);
      if (current.activeTrigger) {
        throw new SchedulerError(
          SCHEDULER_ERROR.CONFLICT,
          `schedule ${scheduleId} has an active run; wait for it to finish or cancel it before updating`,
        );
      }
      if (this._controllers.has(scheduleId)) {
        throw new SchedulerError(
          SCHEDULER_ERROR.CONFLICT,
          `schedule ${scheduleId} has an active run; wait for it to finish or cancel it before updating`,
        );
      }

      const timingChanged = TIMING_FIELDS.some((field) => field in patch);
      if (current.status === SCHEDULE_STATUS.COMPLETED && !timingChanged) {
        throw new SchedulerError(
          SCHEDULER_ERROR.CONFLICT,
          `schedule ${scheduleId} is completed; provide a new future at/cron to update it`,
        );
      }

      const nextKind = "kind" in patch ? patch.kind : current.kind;
      if (nextKind !== SCHEDULE_KIND.ONCE && nextKind !== SCHEDULE_KIND.RECURRING) {
        throw new SchedulerError(
          SCHEDULER_ERROR.INVALID_REQUEST,
          `kind must be "${SCHEDULE_KIND.ONCE}" or "${SCHEDULE_KIND.RECURRING}"`,
        );
      }
      if ("at" in patch && nextKind !== SCHEDULE_KIND.ONCE) {
        throw new SchedulerError(SCHEDULER_ERROR.INVALID_REQUEST, "at is only valid for once schedules");
      }
      if ("cron" in patch && nextKind !== SCHEDULE_KIND.RECURRING) {
        throw new SchedulerError(SCHEDULER_ERROR.INVALID_REQUEST, "cron is only valid for recurring schedules");
      }

      let name = current.name;
      if ("name" in patch) {
        if (typeof patch.name !== "string") {
          throw new SchedulerError(SCHEDULER_ERROR.INVALID_REQUEST, "name must be a string");
        }
        name = patch.name.trim().slice(0, 200);
      }

      let request = current.request;
      if ("request" in patch) {
        try {
          request = normalizeResearchRequest(patch.request, { now: this._now() }).request;
        } catch (error) {
          throw new SchedulerError(
            SCHEDULER_ERROR.INVALID_REQUEST,
            `invalid research request: ${error?.message ?? error}`,
            { cause: error },
          );
        }
      }

      const candidate = cloneSchedule(current);
      candidate.name = "name" in patch ? name : current.name;
      candidate.request = request;

      if (timingChanged) {
        const input = {
          scheduleId,
          kind: nextKind,
          timezone: "timezone" in patch ? patch.timezone : current.timezone,
          request,
          name,
        };
        if (nextKind === SCHEDULE_KIND.ONCE) input.at = "at" in patch ? patch.at : current.onceAt;
        else input.cron = "cron" in patch ? patch.cron : current.cron;

        let normalized;
        try {
          normalized = normalizeScheduleInput(input, { now: this._now() });
        } catch (error) {
          if (error instanceof SchedulerError) throw error;
          throw new SchedulerError(
            SCHEDULER_ERROR.INVALID_REQUEST,
            `invalid schedule update: ${error?.message ?? error}`,
            { cause: error },
          );
        }
        candidate.kind = normalized.kind;
        candidate.timezone = normalized.timezone;
        candidate.cron = normalized.cron;
        candidate.onceAt = normalized.onceAt;
        candidate.onceAtUtc = normalized.onceAtUtc;
        candidate.request = normalized.request;
        candidate.name = normalized.name;
        candidate.nextRunAt = normalized.nextRunAt;
        if (current.status === SCHEDULE_STATUS.COMPLETED) {
          candidate.status = SCHEDULE_STATUS.ACTIVE;
          candidate.completedAt = null;
        }
      }

      await this._save(candidate);
      this._schedules.set(scheduleId, candidate);
      return cloneSchedule(candidate);
    });
  }

  /**
   * Remove a schedule and its persisted file. Deleting is refused while the
   * schedule owns a lease or an execution controller: the running trigger would
   * otherwise release into a schedule that no longer exists. The global run slot
   * and other schedules are unaffected.
   *
   * @param {string} scheduleId
   */
  async deleteSchedule(scheduleId) {
    return this._withStateLock(async () => {
      this._assertUsable();
      const schedule = this._require(scheduleId);
      if (schedule.activeTrigger) {
        throw new SchedulerError(
          SCHEDULER_ERROR.CONFLICT,
          `schedule ${scheduleId} has an active run; wait for it to finish or cancel it before deleting`,
        );
      }
      if (this._controllers.has(scheduleId)) {
        throw new SchedulerError(
          SCHEDULER_ERROR.CONFLICT,
          `schedule ${scheduleId} has an active run; wait for it to finish or cancel it before deleting`,
        );
      }
      // The scheduler owns the file layout; the API never touches JSON files.
      await rm(this._store.fileFor(scheduleId), { force: true });
      this._schedules.delete(scheduleId);
      return { scheduleId, deleted: true };
    });
  }

  async pause(scheduleId) {
    return this._withStateLock(async () => {
      const schedule = this._require(scheduleId);
      if (schedule.status === SCHEDULE_STATUS.COMPLETED) {
        throw new SchedulerError(
          SCHEDULER_ERROR.CONFLICT,
          `schedule ${scheduleId} is completed and cannot be paused`,
        );
      }
      schedule.status = SCHEDULE_STATUS.PAUSED;
      await this._save(schedule);
      return cloneSchedule(schedule);
    });
  }

  /**
   * Re-enable a paused schedule. Occurrences that became due while paused are
   * recorded as a single `missed` audit entry and are not replayed; the next
   * fire time is recomputed strictly after `now`.
   */
  async enable(scheduleId) {
    return this._withStateLock(async () => {
      const schedule = this._require(scheduleId);
      if (schedule.status === SCHEDULE_STATUS.ACTIVE) return cloneSchedule(schedule);
      if (schedule.status === SCHEDULE_STATUS.COMPLETED) {
        throw new SchedulerError(
          SCHEDULER_ERROR.CONFLICT,
          `schedule ${scheduleId} is completed and cannot be enabled`,
        );
      }

      const now = this._now();
      const nowIso = now.toISOString();
      const previousNext = schedule.nextRunAt;
      const previousNextMs = Date.parse(previousNext ?? "");

      if (schedule.kind === SCHEDULE_KIND.ONCE) {
        const onceMs = Date.parse(schedule.onceAtUtc);
        if (onceMs <= now.getTime()) {
          schedule.status = SCHEDULE_STATUS.COMPLETED;
          schedule.completedAt = nowIso;
          schedule.nextRunAt = null;
          const trigger = this._missedTrigger(schedule, {
            scheduledFor: schedule.onceAtUtc,
            count: 1,
            reason: "paused",
            now,
          });
          this._appendTrigger(schedule, trigger);
          schedule.stats.triggers += 1;
          schedule.stats.missed += 1;
        } else {
          schedule.status = SCHEDULE_STATUS.ACTIVE;
          schedule.nextRunAt = schedule.onceAtUtc;
        }
      } else {
        let missed = null;
        if (Number.isFinite(previousNextMs) && previousNextMs <= now.getTime()) {
          missed = enumerateMissedOccurrences(schedule, new Date(previousNextMs), now);
        }
        schedule.status = SCHEDULE_STATUS.ACTIVE;
        const next = computeNextRunAt(schedule, now);
        schedule.nextRunAt = next ? next.toISOString() : null;
        if (!next) {
          schedule.status = SCHEDULE_STATUS.COMPLETED;
          schedule.completedAt = nowIso;
        }
        if (missed?.count) {
          const trigger = this._missedTrigger(schedule, {
            scheduledFor: previousNext,
            count: missed.count,
            latest: missed.latest,
            capped: missed.capped,
            reason: "paused",
            now,
          });
          this._appendTrigger(schedule, trigger);
          schedule.stats.triggers += 1;
          schedule.stats.missed += 1;
        }
      }

      await this._save(schedule);
      return cloneSchedule(schedule);
    });
  }

  /**
   * Trigger one research run immediately. Works for paused and completed
   * schedules because it is an explicit user action; it never consumes or
   * rewrites the schedule's next occurrence.
   */
  async runNow(scheduleId) {
    const prepared = await this._withStateLock(async () => {
      this._assertUsable();
      const schedule = this._require(scheduleId);
      if (schedule.activeTrigger) {
        throw new SchedulerError(
          SCHEDULER_ERROR.BUSY,
          `schedule ${scheduleId} already has an active trigger`,
        );
      }
      if (!this._slotFree) {
        throw new SchedulerError(SCHEDULER_ERROR.BUSY, "another research run is already active");
      }
      const now = this._now();
      const nowIso = now.toISOString();
      const dedupeKey = makeManualDedupeKey(scheduleId, nowIso, randomBytes(4).toString("hex"));
      const trigger = {
        dedupeKey,
        scheduledFor: nowIso,
        triggerAt: nowIso,
        claimedAt: nowIso,
        runId: null,
        status: TRIGGER_STATUS.SCHEDULED,
        researchStatus: null,
        manual: true,
        catchUp: false,
        missedCount: 0,
        missedThrough: null,
        capped: false,
        lateByMs: 0,
        finishedAt: null,
        durationMs: null,
        error: null,
      };
      schedule.activeTrigger = {
        dedupeKey,
        scheduledFor: trigger.scheduledFor,
        claimedAt: trigger.claimedAt,
        runId: null,
      };
      this._appendTrigger(schedule, trigger);
      schedule.stats.triggers += 1;
      await this._save(schedule);
      this._slotFree = false;
      return { prepared: { schedule, trigger, controller: new AbortController(), generation: this._abortGeneration } };
    });
    return this._executePrepared(prepared.prepared);
  }

  /** Cancel the active research run for one schedule, if any. */
  cancel(scheduleId, reason = "cancelled by caller") {
    const controller = this._controllers.get(scheduleId);
    if (!controller) return false;
    controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
    return true;
  }

  cancelAll(reason = "cancelled by caller") {
    let count = 0;
    for (const controller of this._controllers.values()) {
      controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
      count += 1;
    }
    return count;
  }

  /**
   * Start the persistent tick loop. Recovery of interrupted leases happens
   * once per instance before the first tick; the initial tick performs the
   * coalesced catch-up for occurrences missed while this process was down.
   */
  async start({ tickIntervalMs } = {}) {
    this._assertUsable();
    if (tickIntervalMs !== undefined) {
      if (!Number.isFinite(tickIntervalMs) || tickIntervalMs < LIMITS.minTickIntervalMs) {
        throw new SchedulerError(SCHEDULER_ERROR.INVALID_REQUEST, "tickIntervalMs is below the minimum");
      }
      this._tickIntervalMs = tickIntervalMs;
    }
    if (this._running) return this;
    if (!this._recovered) {
      await this._recoverInterruptedTriggers();
      this._recovered = true;
    }
    this._running = true;
    this._timer = setInterval(() => this._kickTick(), this._tickIntervalMs);
    this._timer.unref?.();
    this._kickTick();
    return this;
  }

  /**
   * Stop the tick loop. With `abortActive` (the default) every in-flight
   * research run is cancelled and awaited, so a stopped scheduler leaves no
   * unowned run behind. Pass `{ abortActive: false }` for a drain-only stop.
   */
  async stop({ abortActive = true } = {}) {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._running = false;
    if (abortActive) {
      this._abortGeneration += 1;
      this.cancelAll("scheduler stopped");
    }
    await this.settle();
    return this;
  }

  /** Wait for scheduler-started background ticks/runs to settle. */
  async settle() {
    while (this._background.size > 0) {
      await Promise.allSettled([...this._background]);
    }
    return this;
  }

  /**
   * Deterministic entry point: fire every currently due schedule one at a
   * time. It is safe to call concurrently; state transitions are serialised
   * and the global single-run slot prevents parallel research runs.
   */
  async tick() {
    const triggered = [];
    while (true) {
      const claimed = await this._claimNextDue();
      if (!claimed) break;
      if (claimed.retry) continue;
      triggered.push(await this._executePrepared(claimed.prepared));
    }
    return { triggered };
  }

  async dispose() {
    if (this._disposed) return;
    await this.stop({ abortActive: true });
    this._disposed = true;
  }

  _assertUsable() {
    if (this._disposed) throw new SchedulerError(SCHEDULER_ERROR.CONFLICT, "scheduler is disposed");
  }

  /**
   * Guard for operations that require a startup/idle instance. A running tick
   * loop, a claimed global slot, a live controller or pending background work
   * all mean some execution still owns the current in-memory schedule objects.
   */
  _assertIdle(operation) {
    const busy =
      this._running || !this._slotFree || this._controllers.size > 0 || this._background.size > 0;
    if (!busy) return;
    throw new SchedulerError(
      SCHEDULER_ERROR.BUSY,
      `${operation} is only allowed while the scheduler is idle; stop it and let active work settle first`,
    );
  }

  _now() {
    return this._clock();
  }

  _require(scheduleId) {
    const schedule = this._schedules.get(scheduleId);
    if (!schedule) {
      throw new SchedulerError(SCHEDULER_ERROR.NOT_FOUND, `schedule not found: ${scheduleId}`);
    }
    return schedule;
  }

  async _save(schedule) {
    schedule.updatedAt = this._now().toISOString();
    await this._store.write(schedule);
  }

  _withStateLock(fn) {
    const next = this._stateChain.then(fn, fn);
    this._stateChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  _appendTrigger(schedule, trigger) {
    schedule.triggers.push(trigger);
    while (schedule.triggers.length > LIMITS.maxTriggerHistory) {
      const activeKey = schedule.activeTrigger?.dedupeKey;
      const index = schedule.triggers.findIndex((entry) => entry.dedupeKey !== activeKey);
      if (index === -1) break;
      schedule.triggers.splice(index, 1);
    }
  }

  _missedTrigger(schedule, { scheduledFor, count, latest = null, capped = false, reason, now }) {
    return {
      dedupeKey: `${schedule.scheduleId}@missed:${scheduledFor ?? now.toISOString()}:${reason}`,
      scheduledFor: scheduledFor ?? now.toISOString(),
      triggerAt: now.toISOString(),
      claimedAt: now.toISOString(),
      runId: null,
      status: TRIGGER_STATUS.MISSED,
      researchStatus: null,
      manual: false,
      catchUp: false,
      missedCount: count,
      missedThrough: latest ? latest.toISOString() : null,
      capped,
      lateByMs: 0,
      finishedAt: now.toISOString(),
      durationMs: null,
      error: null,
      reason,
    };
  }

  async _claimNextDue() {
    return this._withStateLock(async () => {
      if (this._disposed || !this._slotFree) return null;
      const now = this._now();
      const due = [...this._schedules.values()]
        .filter(
          (schedule) =>
            schedule.status === SCHEDULE_STATUS.ACTIVE &&
            !schedule.activeTrigger &&
            schedule.nextRunAt &&
            Date.parse(schedule.nextRunAt) <= now.getTime(),
        )
        .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt) || a.scheduleId.localeCompare(b.scheduleId));
      if (due.length === 0) return null;

      const schedule = due[0];
      const occurrence = collectDueOccurrences(schedule, now);
      if (!occurrence) {
        const next = computeNextRunAt(schedule, now);
        schedule.nextRunAt = next ? next.toISOString() : null;
        if (!next) {
          schedule.status = SCHEDULE_STATUS.COMPLETED;
          schedule.completedAt = now.toISOString();
        }
        await this._save(schedule);
        return { retry: true };
      }

      const trigger = this._claimScheduledTrigger(schedule, occurrence, now);
      if (!trigger) {
        await this._save(schedule);
        return { retry: true };
      }
      this._slotFree = false;
      return {
        prepared: {
          schedule,
          trigger,
          controller: new AbortController(),
          generation: this._abortGeneration,
        },
      };
    });
  }

  _claimScheduledTrigger(schedule, occurrence, now) {
    const scheduleId = schedule.scheduleId;
    const scheduledFor = occurrence.first.toISOString();
    const dedupeKey = makeDedupeKey(scheduleId, scheduledFor);
    const nowIso = now.toISOString();

    if (schedule.triggers.some((entry) => entry.dedupeKey === dedupeKey)) {
      schedule.stats.duplicatesSkipped += 1;
      schedule.nextRunAt = this._advanceAfter(schedule, now);
      if (schedule.kind === SCHEDULE_KIND.ONCE) {
        schedule.status = SCHEDULE_STATUS.COMPLETED;
        schedule.completedAt = nowIso;
      }
      return null;
    }

    const trigger = {
      dedupeKey,
      scheduledFor,
      triggerAt: nowIso,
      claimedAt: nowIso,
      runId: null,
      status: TRIGGER_STATUS.SCHEDULED,
      researchStatus: null,
      manual: false,
      catchUp: occurrence.missedCount > 0,
      missedCount: occurrence.missedCount,
      missedThrough: occurrence.missedThrough,
      capped: occurrence.capped,
      lateByMs: occurrence.lateByMs,
      finishedAt: null,
      durationMs: null,
      error: null,
    };
    schedule.activeTrigger = {
      dedupeKey,
      scheduledFor,
      claimedAt: nowIso,
      runId: null,
    };
    schedule.nextRunAt = this._advanceAfter(schedule, now);
    if (schedule.kind === SCHEDULE_KIND.ONCE) {
      schedule.status = SCHEDULE_STATUS.COMPLETED;
      schedule.completedAt = nowIso;
    } else if (!schedule.nextRunAt) {
      schedule.status = SCHEDULE_STATUS.COMPLETED;
      schedule.completedAt = nowIso;
    }
    this._appendTrigger(schedule, trigger);
    schedule.stats.triggers += 1;
    return trigger;
  }

  _advanceAfter(schedule, now) {
    const next = computeNextRunAt(schedule, now);
    return next ? next.toISOString() : null;
  }

  async _executePrepared(prepared) {
    const { schedule, trigger, controller, generation } = prepared;
    this._controllers.set(schedule.scheduleId, controller);
    if (generation !== this._abortGeneration) controller.abort("scheduler stopped");
    const startedAtMs = Date.now();
    try {
      const deps = {
        ...this._researchDeps,
        now: () => this._now(),
        signal: controller.signal,
        logger: this._researchDeps.logger ?? this._logger,
      };
      const started = await this._startResearch(schedule.request, deps);
      if (!started || typeof started.runId !== "string" || !started.runId) {
        throw new SchedulerError(SCHEDULER_ERROR.EXECUTOR_ERROR, "executor returned no run id");
      }
      if (!started.done || typeof started.done.then !== "function") {
        throw new SchedulerError(SCHEDULER_ERROR.EXECUTOR_ERROR, "executor returned no completion promise");
      }
      await this._withStateLock(async () => {
        if (isTerminalTriggerStatus(trigger.status)) return;
        trigger.runId = started.runId;
        trigger.status = TRIGGER_STATUS.STARTED;
        schedule.activeTrigger = { ...schedule.activeTrigger, runId: started.runId };
        schedule.lastRunId = started.runId;
        await this._save(schedule);
      });
      const record = await started.done;
      await this._withStateLock(async () => {
        await this._finishSuccess(schedule, trigger, record, startedAtMs);
      });
    } catch (error) {
      await this._withStateLock(async () => {
        await this._finishFailure(schedule, trigger, error, controller.signal.aborted, startedAtMs);
      });
    } finally {
      this._controllers.delete(schedule.scheduleId);
      this._slotFree = true;
    }
    return cloneSchedule(trigger);
  }

  async _finishSuccess(schedule, trigger, record, startedAtMs) {
    if (isTerminalTriggerStatus(trigger.status)) return;
    const nowIso = this._now().toISOString();
    const mapped = record && typeof record.status === "string"
      ? mapResearchStatusToTriggerStatus(record.status)
      : TRIGGER_STATUS.FAILED;
    trigger.status = mapped;
    trigger.researchStatus = record?.status ?? null;
    trigger.finishedAt = nowIso;
    trigger.durationMs = Math.max(0, Date.now() - startedAtMs);
    trigger.error = errorFromRun(record, nowIso);
    if (mapped === TRIGGER_STATUS.FAILED && !trigger.error) {
      trigger.error = errorRecord(SCHEDULER_ERROR.EXECUTOR_ERROR, "research run ended without a usable status", nowIso);
    }
    schedule.activeTrigger = null;
    schedule.lastRunId = trigger.runId;
    schedule.lastRun = {
      dedupeKey: trigger.dedupeKey,
      scheduledFor: trigger.scheduledFor,
      runId: trigger.runId,
      status: trigger.status,
      researchStatus: trigger.researchStatus,
      startedAt: trigger.claimedAt,
      finishedAt: trigger.finishedAt,
      durationMs: trigger.durationMs,
    };
    bumpStat(schedule.stats, trigger.status);
    if (schedule.kind === SCHEDULE_KIND.ONCE && schedule.status === SCHEDULE_STATUS.ACTIVE) {
      schedule.status = SCHEDULE_STATUS.COMPLETED;
      schedule.completedAt ??= trigger.finishedAt;
    }
    await this._save(schedule);
    this._logger.info?.(
      `scheduler: trigger ${trigger.dedupeKey} finished as ${trigger.status} (research: ${trigger.researchStatus ?? "none"})`,
    );
  }

  async _finishFailure(schedule, trigger, error, aborted, startedAtMs) {
    if (isTerminalTriggerStatus(trigger.status)) return;
    const nowIso = this._now().toISOString();
    const status = aborted || error?.name === "AbortError"
      ? TRIGGER_STATUS.CANCELLED
      : TRIGGER_STATUS.FAILED;
    trigger.status = status;
    trigger.researchStatus = null;
    trigger.finishedAt = nowIso;
    trigger.durationMs = Math.max(0, Date.now() - startedAtMs);
    trigger.error = errorRecord(
      aborted ? "aborted" : (error?.code ?? SCHEDULER_ERROR.EXECUTOR_ERROR),
      error?.message ?? "executor failed",
      nowIso,
    );
    schedule.activeTrigger = null;
    schedule.lastRun = {
      dedupeKey: trigger.dedupeKey,
      scheduledFor: trigger.scheduledFor,
      runId: trigger.runId,
      status: trigger.status,
      researchStatus: null,
      startedAt: trigger.claimedAt,
      finishedAt: trigger.finishedAt,
      durationMs: trigger.durationMs,
    };
    bumpStat(schedule.stats, trigger.status);
    if (schedule.kind === SCHEDULE_KIND.ONCE && schedule.status === SCHEDULE_STATUS.ACTIVE) {
      schedule.status = SCHEDULE_STATUS.COMPLETED;
      schedule.completedAt ??= trigger.finishedAt;
    }
    await this._save(schedule);
    this._logger.warn?.(
      `scheduler: trigger ${trigger.dedupeKey} finished as ${trigger.status}: ${trigger.error?.code}`,
    );
  }

  /**
   * Recover leases left by a previous process. A run that already reached a
   * terminal state in the AGT-028 run store is adopted as that outcome; a run
   * still marked running is recorded as an orphaned `interrupted` trigger and
   * is never retried automatically. The next future occurrence still runs.
   */
  async _recoverInterruptedTriggers() {
    await this._withStateLock(async () => {
      const now = this._now();
      const nowIso = now.toISOString();
      for (const schedule of this._schedules.values()) {
        if (!schedule.activeTrigger) continue;
        const active = schedule.activeTrigger;
        const trigger =
          schedule.triggers.find((entry) => entry.dedupeKey === active.dedupeKey) ??
          this._adoptedTrigger(schedule, active, now);
        if (!schedule.triggers.includes(trigger)) this._appendTrigger(schedule, trigger);

        let status = TRIGGER_STATUS.INTERRUPTED;
        let researchStatus = null;
        let error = errorRecord(
          SCHEDULER_ERROR.INTERRUPTED,
          "scheduler restarted before the research run id was recorded",
          nowIso,
        );
        const runId = active.runId ?? trigger.runId ?? null;

        if (runId) {
          try {
            const { run } = await this._readRun(runId, {
              rootDir: this._researchDeps.rootDir,
              env: this._researchDeps.env,
            });
            researchStatus = run?.status ?? null;
            if (isTerminalStatus(run?.status)) {
              status = mapResearchStatusToTriggerStatus(run.status);
              error = errorFromRun(run, nowIso);
            } else {
              error = errorRecord(
                SCHEDULER_ERROR.INTERRUPTED,
                `scheduler restarted while run ${runId} was still marked ${String(run?.status)}; the run may be orphaned`,
                nowIso,
              );
            }
          } catch (readError) {
            error = errorRecord(
              SCHEDULER_ERROR.INTERRUPTED,
              `scheduler restarted and run ${runId} could not be read: ${readError?.message ?? readError}`,
              nowIso,
            );
          }
        }

        trigger.status = status;
        trigger.researchStatus = researchStatus;
        trigger.finishedAt = nowIso;
        trigger.recovery = true;
        trigger.error = error;
        schedule.activeTrigger = null;
        schedule.lastRun = {
          dedupeKey: trigger.dedupeKey,
          scheduledFor: trigger.scheduledFor,
          runId,
          status,
          researchStatus,
          startedAt: trigger.claimedAt,
          finishedAt: nowIso,
          durationMs: null,
        };
        bumpStat(schedule.stats, status);
        if (schedule.kind === SCHEDULE_KIND.ONCE) {
          schedule.status = SCHEDULE_STATUS.COMPLETED;
          schedule.completedAt ??= nowIso;
        }
        await this._save(schedule);
        this._logger.warn?.(
          `scheduler: recovered trigger ${trigger.dedupeKey} as ${status}${researchStatus ? ` (research: ${researchStatus})` : ""}`,
        );
      }

      for (const schedule of this._schedules.values()) {
        if (schedule.status !== SCHEDULE_STATUS.ACTIVE || schedule.nextRunAt) continue;
        const next = computeNextRunAt(schedule, now);
        schedule.nextRunAt = next ? next.toISOString() : null;
        if (!next) {
          schedule.status = SCHEDULE_STATUS.COMPLETED;
          schedule.completedAt = nowIso;
        }
        await this._save(schedule);
      }
    });
  }

  _adoptedTrigger(schedule, active, now) {
    return {
      dedupeKey: active.dedupeKey,
      scheduledFor: active.scheduledFor ?? now.toISOString(),
      triggerAt: active.claimedAt ?? now.toISOString(),
      claimedAt: active.claimedAt ?? now.toISOString(),
      runId: active.runId ?? null,
      status: TRIGGER_STATUS.SCHEDULED,
      researchStatus: null,
      manual: false,
      catchUp: false,
      missedCount: 0,
      missedThrough: null,
      capped: false,
      lateByMs: 0,
      finishedAt: null,
      durationMs: null,
      error: null,
    };
  }

  _kickTick() {
    if (this._disposed) return;
    const promise = this.tick()
      .catch((error) => {
        this._logger.warn?.(`scheduler tick failed: ${error?.message ?? error}`);
      })
      .finally(() => {
        this._background.delete(promise);
      });
    this._background.add(promise);
  }
}
