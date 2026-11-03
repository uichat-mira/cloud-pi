/**
 * Reviewed projections from Scheduler / Research records to API JSON.
 *
 * The API never returns a stored record verbatim. Every field below is
 * explicitly selected so an internal field (absolute paths, transcripts,
 * environment snapshots, credentials, leases, delivery internals) cannot leak
 * into a response by accident. Errors and URLs get an additional scrub because
 * they originate from network/model input.
 */
import { redactSecrets } from "../config.mjs";
import { API_LIMITS } from "./contracts.mjs";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeText(value, max = 500) {
  if (typeof value !== "string") return "";
  return redactSecrets(value).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Keep an absolute web URL but drop any embedded userinfo. */
export function safeUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return null;
  }
}

function projectLimits(limits) {
  if (!isObject(limits)) return {};
  const out = {};
  for (const [key, value] of Object.entries(limits)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function projectRequest(request) {
  if (!isObject(request)) return { topic: "", goal: "", timeRange: "any", limits: {} };
  return {
    topic: typeof request.topic === "string" ? request.topic : "",
    goal: typeof request.goal === "string" ? request.goal : "",
    timeRange: typeof request.timeRange === "string" ? request.timeRange : "any",
    limits: projectLimits(request.limits),
  };
}

const STAT_KEYS = [
  "triggers",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "timeout",
  "interrupted",
  "missed",
  "duplicatesSkipped",
];

function projectStats(stats) {
  const out = {};
  if (!isObject(stats)) return out;
  for (const key of STAT_KEYS) {
    out[key] = typeof stats[key] === "number" && Number.isFinite(stats[key]) ? stats[key] : 0;
  }
  return out;
}

export function toTriggerView(trigger) {
  if (!isObject(trigger)) return null;
  return {
    dedupeKey: typeof trigger.dedupeKey === "string" ? trigger.dedupeKey : null,
    scheduledFor: typeof trigger.scheduledFor === "string" ? trigger.scheduledFor : null,
    triggerAt: typeof trigger.triggerAt === "string" ? trigger.triggerAt : null,
    claimedAt: typeof trigger.claimedAt === "string" ? trigger.claimedAt : null,
    runId: typeof trigger.runId === "string" ? trigger.runId : null,
    status: typeof trigger.status === "string" ? trigger.status : null,
    researchStatus: typeof trigger.researchStatus === "string" ? trigger.researchStatus : null,
    manual: trigger.manual === true,
    catchUp: trigger.catchUp === true,
    missedCount: typeof trigger.missedCount === "number" ? trigger.missedCount : 0,
    missedThrough: typeof trigger.missedThrough === "string" ? trigger.missedThrough : null,
    capped: trigger.capped === true,
    lateByMs: typeof trigger.lateByMs === "number" ? trigger.lateByMs : 0,
    finishedAt: typeof trigger.finishedAt === "string" ? trigger.finishedAt : null,
    durationMs: typeof trigger.durationMs === "number" ? trigger.durationMs : null,
    error: isObject(trigger.error)
      ? {
          code: typeof trigger.error.code === "string" ? trigger.error.code : "internal_error",
          message: safeText(trigger.error.message),
          at: typeof trigger.error.at === "string" ? trigger.error.at : null,
        }
      : null,
    recovery: trigger.recovery === true,
  };
}

function projectLastRun(lastRun) {
  if (!isObject(lastRun)) return null;
  return {
    dedupeKey: typeof lastRun.dedupeKey === "string" ? lastRun.dedupeKey : null,
    scheduledFor: typeof lastRun.scheduledFor === "string" ? lastRun.scheduledFor : null,
    runId: typeof lastRun.runId === "string" ? lastRun.runId : null,
    status: typeof lastRun.status === "string" ? lastRun.status : null,
    researchStatus: typeof lastRun.researchStatus === "string" ? lastRun.researchStatus : null,
    startedAt: typeof lastRun.startedAt === "string" ? lastRun.startedAt : null,
    finishedAt: typeof lastRun.finishedAt === "string" ? lastRun.finishedAt : null,
    durationMs: typeof lastRun.durationMs === "number" ? lastRun.durationMs : null,
  };
}

function projectActiveTrigger(activeTrigger) {
  if (!isObject(activeTrigger)) return null;
  return {
    dedupeKey: typeof activeTrigger.dedupeKey === "string" ? activeTrigger.dedupeKey : null,
    scheduledFor: typeof activeTrigger.scheduledFor === "string" ? activeTrigger.scheduledFor : null,
    claimedAt: typeof activeTrigger.claimedAt === "string" ? activeTrigger.claimedAt : null,
    runId: typeof activeTrigger.runId === "string" ? activeTrigger.runId : null,
  };
}

/**
 * Project one schedule. `includeTriggers` is bounded so a list response stays
 * small; detail responses include the most recent audit entries only.
 *
 * Trusted local management clients receive configured targets for edits.
 * Delivery status diagnostics expose masked recipient IDs instead.
 */
export function toScheduleView(schedule, { includeTriggers = false } = {}) {
  if (!isObject(schedule)) return null;
  const triggers = Array.isArray(schedule.triggers) ? schedule.triggers : [];
  const view = {
    scheduleId: schedule.scheduleId,
    name: typeof schedule.name === "string" ? schedule.name : "",
    kind: schedule.kind,
    timezone: schedule.timezone,
    cron: typeof schedule.cron === "string" ? schedule.cron : null,
    onceAt: typeof schedule.onceAt === "string" ? schedule.onceAt : null,
    onceAtUtc: typeof schedule.onceAtUtc === "string" ? schedule.onceAtUtc : null,
    request: projectRequest(schedule.request),
    deliveryTargets: Array.isArray(schedule.deliveryTargets)
      ? schedule.deliveryTargets.map((target) => ({
          type: target.type,
          id: target.id,
          ...(typeof target.label === "string" ? { label: target.label } : {}),
        }))
      : [],
    status: schedule.status,
    missedRunPolicy: schedule.missedRunPolicy,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    nextRunAt: typeof schedule.nextRunAt === "string" ? schedule.nextRunAt : null,
    completedAt: typeof schedule.completedAt === "string" ? schedule.completedAt : null,
    lastRun: projectLastRun(schedule.lastRun),
    activeTrigger: projectActiveTrigger(schedule.activeTrigger),
    stats: projectStats(schedule.stats),
    triggerCount: triggers.length,
  };
  if (includeTriggers) {
    view.recentTriggers = triggers
      .slice(-API_LIMITS.maxRecentTriggers)
      .map(toTriggerView)
      .filter(Boolean);
  }
  return view;
}

function projectUsage(usage) {
  if (!isObject(usage)) return null;
  const out = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
    if (typeof usage[key] === "number" && Number.isFinite(usage[key])) out[key] = usage[key];
  }
  if (typeof usage.modelId === "string") out.modelId = usage.modelId;
  if (typeof usage.providerId === "string") out.providerId = usage.providerId;
  return Object.keys(out).length > 0 ? out : null;
}

function projectSourcesSummary(summary) {
  if (!isObject(summary)) return null;
  const failures = Array.isArray(summary.failures) ? summary.failures : [];
  return {
    total: Number.isFinite(summary.total) ? summary.total : 0,
    fetched: Number.isFinite(summary.fetched) ? summary.fetched : 0,
    failed: Number.isFinite(summary.failed) ? summary.failed : 0,
    not_fetched: Number.isFinite(summary.not_fetched) ? summary.not_fetched : 0,
    failures: failures.slice(0, 20).map((failure) => ({
      id: typeof failure?.id === "string" ? failure.id : null,
      code: typeof failure?.code === "string" ? failure.code : "internal_error",
    })),
  };
}

function projectCitations(citations) {
  if (!isObject(citations)) return null;
  const count = (value) => (Array.isArray(value) ? value.length : 0);
  return {
    references: count(citations.references),
    resolved: count(citations.resolved),
    unresolved: count(citations.unresolved),
    unfetched: count(citations.unfetched),
  };
}

function projectErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, 20).map((error) => ({
    code: typeof error?.code === "string" ? error.code : "internal_error",
    message: safeText(error?.message),
    retryable: error?.retryable === true,
    phase: typeof error?.phase === "string" ? error.phase : null,
    at: typeof error?.at === "string" ? error.at : null,
  }));
}

function projectToolCounters(tools) {
  if (!isObject(tools) || !isObject(tools.counters)) return null;
  const out = {};
  for (const key of ["searches", "pages", "toolCalls", "refused"]) {
    if (Number.isFinite(tools.counters[key])) out[key] = tools.counters[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Project one persisted research run for the run history/detail view. */
export function toRunView(run) {
  if (!isObject(run)) return null;
  return {
    runId: run.runId,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: typeof run.startedAt === "string" ? run.startedAt : null,
    finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : null,
    durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
    request: projectRequest(run.request),
    limits: projectLimits(run.limits),
    runtime: isObject(run.runtime)
      ? {
          status: typeof run.runtime.status === "string" ? run.runtime.status : null,
          durationMs: Number.isFinite(run.runtime.durationMs) ? run.runtime.durationMs : null,
          usage: projectUsage(run.runtime.usage),
        }
      : null,
    tools: projectToolCounters(run.tools),
    sourcesSummary: projectSourcesSummary(run.sourcesSummary),
    citations: projectCitations(run.citations),
    errors: projectErrors(run.errors),
    // Additive chat fields (AGT-037): a chat turn is stored in the same run store,
    // so its channel facts must be readable through the same route. Research runs
    // keep `chat: null` and their existing fields are unchanged.
    chat:
      typeof run.channel === "string"
        ? {
            channel: run.channel,
            chatType: typeof run.chatType === "string" ? run.chatType : null,
            chatIdMasked: typeof run.chatIdMasked === "string" ? run.chatIdMasked : null,
            usage: projectUsage(run.usage),
            reply: isObject(run.reply)
              ? {
                  delivered: run.reply.delivered === true,
                  segments: Number.isFinite(run.reply.segments) ? run.reply.segments : null,
                  segmentsDelivered: Number.isFinite(run.reply.segmentsDelivered)
                    ? run.reply.segmentsDelivered
                    : null,
                }
              : null,
          }
        : null,
    artifacts: {
      report: typeof run.paths?.report === "string",
      sources: typeof run.paths?.sources === "string",
      sourcesMarkdown: typeof run.paths?.sourcesMarkdown === "string",
    },
  };
}

/** Project one source ledger entry, bounded and stripped of embedded userinfo. */
export function toSourceView(source) {
  if (!isObject(source)) return null;
  return {
    id: typeof source.id === "string" ? source.id : null,
    kind: typeof source.kind === "string" ? source.kind : null,
    status: typeof source.status === "string" ? source.status : null,
    url: safeUrl(source.finalUrl ?? source.url),
    siteName: typeof source.siteName === "string" ? source.siteName : null,
    title: typeof source.title === "string" ? source.title : null,
    publishedAt: typeof source.publishedAt === "string" ? source.publishedAt : null,
    accessedAt: typeof source.accessedAt === "string" ? source.accessedAt : null,
    contentChars: Number.isFinite(source.contentChars) ? source.contentChars : null,
    error: isObject(source.error)
      ? {
          code: typeof source.error.code === "string" ? source.error.code : "internal_error",
          retryable: source.error.retryable === true,
        }
      : null,
  };
}

/** Project a run report + bounded source provenance. */
export function toReportView(run, report, sources) {
  const list = Array.isArray(sources) ? sources : [];
  const bounded = list.slice(0, API_LIMITS.maxReportSources);
  return {
    runId: run.runId,
    status: run.status,
    report: typeof report === "string" ? report : null,
    reportChars: typeof report === "string" ? report.length : 0,
    sourcesSummary: projectSourcesSummary(run.sourcesSummary),
    sources: bounded.map(toSourceView).filter(Boolean),
    sourcesTruncated: list.length > bounded.length,
  };
}

/** Read-only projection of AGT-033 results: no raw recipient IDs,
 * persisted delivery keys or untrusted error message text. */
export function toDeliveryView(delivery, { runId, researchStatus } = {}) {
  if (!delivery) {
    return {
      runId,
      researchStatus: researchStatus ?? null,
      triggerStatus: null,
      deliveryStatus: "none",
      counts: { total: 0, sent: 0, failed: 0, pending: 0 },
      targets: [],
    };
  }
  const targets = Array.isArray(delivery.targets) ? delivery.targets : [];
  return {
    runId,
    researchStatus: researchStatus ?? null,
    triggerStatus: typeof delivery.triggerStatus === "string" ? delivery.triggerStatus : null,
    deliveryStatus: delivery.deliveryStatus,
    counts: Object.fromEntries(
      ["total", "sent", "failed", "pending"].map((key) => [
        key, Number.isSafeInteger(delivery.counts?.[key]) ? delivery.counts[key] : 0,
      ]),
    ),
    targets: targets.slice(0, 10).map((target) => ({
      destination: {
        type: target.destination?.type ?? "unknown",
        maskedId: target.destination?.maskedId ?? "",
      },
      status: target.status,
      attempts: Number.isSafeInteger(target.attempts) ? target.attempts : 0,
      deliveryKind: target.deliveryKind,
      sentAt: target.sentAt ?? null,
      messageId: target.messageId ?? null,
      lastError: target.lastError ? {
        code: typeof target.lastError.code === "string" ? target.lastError.code : "internal_error",
        retryable: target.lastError.retryable === true,
        feishuCode: typeof target.lastError.feishuCode === "number" ? target.lastError.feishuCode : null,
        at: target.lastError.at ?? null,
      } : null,
    })),
  };
}
