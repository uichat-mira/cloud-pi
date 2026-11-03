/**
 * Single-run research executor (AGT-028).
 *
 * `executeResearch(request, deps)` normalises the request, creates the run
 * directory, drives exactly one model session through the injected AGT-027
 * runtime port, enforces the run budgets, and turns the transcript into
 * persisted artifacts. It never imports a provider, reads a credential or
 * assembles a Pi session of its own.
 *
 * Dependency injection (`deps`):
 *   runtimePort  AgentRuntimePort from `port.mjs` (required; missing → fails closed)
 *   toolLayer    `{ tools: ToolDefinition[] }` or a bare tool array; when omitted
 *                the production tools (real network) are wired lazily
 *   store        RunStore override (tests)
 *   now          Date or () => Date (tests)
 *   logger       { info?, warn?, debug? } — observation only
 *   signal       AbortSignal for caller cancellation
 *   rootDir      artifact root override (argument > RESEARCH_RUNS_DIR > default)
 *
 * Budgets are enforced here, around the tool definitions handed to the runtime:
 * calls beyond `maxSearches` / `maxPages` / `maxToolCalls` are refused with
 * `budget_exceeded` and recorded in the tool ledger. Persisted counters are
 * derived from the observed tool calls (never from model claims).
 */
import { randomBytes } from "node:crypto";
import {
  CONTRACT_VERSION,
  DEFAULT_RUNS_DIR,
  ERROR_CODE,
  LIMITS,
  RUN_STATUS,
  TIME_RANGE,
  TOOL,
  clampLimit,
  errorRecord,
  isErrorCode,
  isRunStatus,
} from "./contracts.mjs";
import { RuntimeUnavailableError, assertAgentRuntimePort } from "./port.mjs";
import { ARTIFACT, RunStoreError, createRunStore, resolveRunsRoot } from "./run-store.mjs";
import { buildResearchBrief, buildResearchSystemPrompt } from "./prompt.mjs";
import {
  buildReportMarkdown,
  buildSourcesMarkdown,
  createSourceLedger,
  extractReportBody,
  resolveCitations,
  summarizeSources,
} from "./report.mjs";

const MAX_TOPIC_CHARS = 2000;
const MAX_GOAL_CHARS = 4000;
const TIME_RANGE_VALUES = new Set(Object.values(TIME_RANGE));

export class RunValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunValidationError";
    this.code = ERROR_CODE.INVALID_REQUEST;
  }
}

export class ResearchConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResearchConfigError";
    this.code = ERROR_CODE.CONFIG_ERROR;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveClock(nowOption) {
  if (typeof nowOption === "function") {
    return () => {
      const value = nowOption();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) throw new RunValidationError("now() returned an invalid date");
      return date;
    };
  }
  const fixed = nowOption === undefined ? null : nowOption instanceof Date ? nowOption : new Date(nowOption);
  if (fixed && Number.isNaN(fixed.getTime())) throw new RunValidationError("now must be a valid date");
  return () => (fixed ? new Date(fixed.getTime()) : new Date());
}

/** `r-<UTC yyyymmddThhmmss>-<6 hex>`; the hex suffix keeps same-second runs unique. */
export function generateRunId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "T",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
  return `r-${stamp}-${randomBytes(3).toString("hex")}`;
}

function normalizeLimits(input) {
  if (input !== undefined && input !== null && !isPlainObject(input)) {
    throw new RunValidationError("limits must be an object");
  }
  const limits = {};
  const overrides = isPlainObject(input) ? input : {};
  for (const name of Object.keys(LIMITS)) {
    limits[name] = clampLimit(name, overrides[name]);
  }
  return limits;
}

/**
 * Validate and normalise a research request. Unknown fields are ignored and
 * every limit is clamped to the frozen contract bounds.
 *
 * @param {object} request
 * @param {{ rootDir?: string, env?: Record<string,string>, now?: Date|string|number }} [options]
 */
export function normalizeResearchRequest(request, { rootDir, env = process.env, now = new Date() } = {}) {
  if (!isPlainObject(request)) {
    throw new RunValidationError("research request must be an object");
  }
  const topic = typeof request.topic === "string" ? request.topic.trim() : "";
  if (!topic) throw new RunValidationError("topic is required and must be a non-empty string");
  if (topic.length > MAX_TOPIC_CHARS) {
    throw new RunValidationError(`topic must be at most ${MAX_TOPIC_CHARS} characters`);
  }

  let goal = "";
  if (request.goal !== undefined && request.goal !== null && request.goal !== "") {
    if (typeof request.goal !== "string") throw new RunValidationError("goal must be a string when provided");
    goal = request.goal.trim().slice(0, MAX_GOAL_CHARS);
  }

  let timeRange = request.timeRange;
  if (timeRange === undefined || timeRange === null || timeRange === "") timeRange = TIME_RANGE.ANY;
  if (typeof timeRange !== "string") throw new RunValidationError("timeRange must be a string");
  timeRange = timeRange.trim().toLowerCase();
  if (!TIME_RANGE_VALUES.has(timeRange)) {
    throw new RunValidationError(
      `unsupported timeRange ${JSON.stringify(request.timeRange)}; expected one of ${Object.values(TIME_RANGE).join(", ")}`,
    );
  }

  const clockDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(clockDate.getTime())) throw new RunValidationError("now must be a valid date");

  const limits = normalizeLimits(request.limits);
  return {
    runId: generateRunId(clockDate),
    rootDir: resolveRunsRoot({ rootDir, env }),
    createdAt: clockDate.toISOString(),
    request: { topic, goal, timeRange, limits },
    limits,
  };
}

function abortError() {
  const error = new Error("research run aborted");
  error.name = "AbortError";
  error.code = ERROR_CODE.ABORTED;
  return error;
}

/** Remove credential-looking substrings from text that will be persisted. */
export function redactSecrets(value) {
  if (typeof value !== "string") return value;
  let text = value;
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  text = text.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password)(\s*[=:]\s*)(["']?)[A-Za-z0-9._~+/=-]{6,}\3/gi,
    (_match, key, separator) => `${key}${separator}[redacted]`,
  );
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]");
  return text;
}

function redactDeep(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactDeep(entry);
    return out;
  }
  return value;
}

/**
 * Remove credential-looking substrings from a source record before it is
 * persisted. URLs stay usable as provenance (the source id is the citation
 * key), but `access_token=…`, `api_key=…`, bearer tokens and similar values
 * never reach sources.json / sources.md. The model-facing tool text keeps the
 * real URL, so citation-by-id still works.
 */
function redactSourceRecord(source) {
  return {
    ...source,
    title: redactSecrets(source.title),
    url: redactSecrets(source.url),
    finalUrl: source.finalUrl === null ? null : redactSecrets(source.finalUrl),
    siteName: redactSecrets(source.siteName),
    excerpt: source.excerpt === null ? null : redactSecrets(source.excerpt),
    aliases: Array.isArray(source.aliases) ? source.aliases.map((url) => redactSecrets(url)) : [],
    error: source.error
      ? { ...source.error, message: redactSecrets(source.error.message) }
      : null,
  };
}

function toErrorRecord({ code, message, phase }) {
  const safeCode = isErrorCode(code) ? code : ERROR_CODE.INTERNAL_ERROR;
  return errorRecord(safeCode, redactSecrets(String(message ?? safeCode)), { phase });
}

function classifyRuntimeError(error) {
  const code =
    error?.name === "AbortError"
      ? ERROR_CODE.ABORTED
      : isErrorCode(error?.code)
        ? error.code
        : ERROR_CODE.MODEL_ERROR;
  return toErrorRecord({
    code,
    message: error?.message ?? "agent runtime failed",
    phase: "runtime",
  });
}

function normalizeUsage(usage) {
  const raw = isPlainObject(usage) ? usage : {};
  const numberOrNull = (value) => (Number.isFinite(value) ? Number(value) : null);
  const inputTokens = numberOrNull(raw.inputTokens);
  const outputTokens = numberOrNull(raw.outputTokens);
  const reportedTotal = numberOrNull(raw.totalTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      reportedTotal ??
      (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    modelId: typeof raw.modelId === "string" && raw.modelId ? raw.modelId : null,
    providerId: typeof raw.providerId === "string" && raw.providerId ? raw.providerId : null,
    // Never claim provider-verified usage the runtime did not report.
    source: raw.source === "provider" ? "provider" : "unknown",
  };
}

/** Accept `{tools}` or a bare array; every entry must look like a Pi ToolDefinition. */
function assertToolLayer(toolLayer) {
  if (!toolLayer) {
    throw new ResearchConfigError(
      "toolLayer is required: pass the research tool definitions to executeResearch()",
    );
  }
  const tools = Array.isArray(toolLayer) ? toolLayer : toolLayer.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new ResearchConfigError("toolLayer.tools must be a non-empty array of tool definitions");
  }
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") {
      throw new ResearchConfigError("every toolLayer entry needs a name and an execute() function");
    }
  }
  return { tools };
}

/**
 * Resolve the injected tool layer, or lazily wire the production tools from
 * `tools/search.mjs` and `tools/read-page.mjs` (real network). Tests always
 * inject a fixture layer, so they never depend on the tool modules.
 */
async function resolveToolLayer(toolLayer, limits) {
  if (toolLayer) return assertToolLayer(toolLayer);
  let searchModule;
  let readModule;
  try {
    [searchModule, readModule] = await Promise.all([
      import("./tools/search.mjs"),
      import("./tools/read-page.mjs"),
    ]);
  } catch (error) {
    throw new ResearchConfigError(
      `cannot load the production research tool layer: ${error?.message ?? error}`,
    );
  }
  return {
    tools: [
      searchModule.createWebSearchTool({ limits }),
      readModule.createReadPageTool({ limits }),
    ],
  };
}

function toolKind(name) {
  if (name === TOOL.SEARCH) return "search";
  if (name === TOOL.READ_PAGE) return "page";
  return "other";
}

function budgetRefusal(kind, limits, counters) {
  if (counters.toolCalls >= limits.maxToolCalls) {
    return `maxToolCalls (${limits.maxToolCalls}) exhausted`;
  }
  if (kind === "search" && counters.searches >= limits.maxSearches) {
    return `maxSearches (${limits.maxSearches}) exhausted`;
  }
  if (kind === "page" && counters.pages >= limits.maxPages) {
    return `maxPages (${limits.maxPages}) exhausted`;
  }
  if (kind === "page" && counters.pageChars >= limits.maxTotalPageChars) {
    return `maxTotalPageChars (${limits.maxTotalPageChars}) exhausted`;
  }
  return null;
}

function budgetExceededResult(reason) {
  return {
    content: [{ type: "text", text: `budget_exceeded: ${reason}. Stop calling tools and write the report with what you have.` }],
    details: {
      status: "error",
      kind: "budget",
      error: { code: ERROR_CODE.BUDGET_EXCEEDED, message: reason, retryable: false },
    },
    isError: true,
  };
}

function appendModelFacingText(result, note) {
  const base = isPlainObject(result) ? result : {};
  const content = Array.isArray(base.content) ? [...base.content] : [];
  content.push({ type: "text", text: note });
  return { ...base, content };
}

function detailsErrorCode(details) {
  const code = details?.error?.code;
  return isErrorCode(code) ? code : ERROR_CODE.INTERNAL_ERROR;
}

/**
 * Wrap tool definitions with the run budget, the global abort signal and the
 * provenance capture. Returned details are the only source of source-ledger
 * facts; the model-facing text is annotated with the assigned `S<n>` ids.
 */
function wrapTools({ tools, limits, signal, calls, provenance, counters }) {
  return tools.map((definition) => ({
    ...definition,
    async execute(toolCallId, params, toolSignal, onUpdate, context) {
      const name = definition.name;
      const kind = toolKind(name);
      const callId = typeof toolCallId === "string" ? toolCallId : null;

      const refusal = budgetRefusal(kind, limits, counters);
      if (refusal) {
        counters.refused += 1;
        calls.push({
          seq: calls.length + 1,
          callId,
          name,
          status: "refused",
          durationMs: 0,
          errorCode: ERROR_CODE.BUDGET_EXCEEDED,
        });
        return budgetExceededResult(refusal);
      }
      if (signal.aborted) throw abortError();

      counters.toolCalls += 1;
      if (kind === "search") counters.searches += 1;
      if (kind === "page") counters.pages += 1;

      const started = Date.now();
      try {
        let result = await definition.execute(toolCallId, params, toolSignal ?? signal, onUpdate, context);
        let details = result?.details ?? result?.structuredContent ?? null;
        // A page may be larger than the remaining global character budget.
        // Reject its body *before* giving it to the model or marking it fetched;
        // the next page call is refused without another network request.
        const chars = Number(details?.contentChars);
        if (kind === "page" && details?.status === "ok" && Number.isFinite(chars) &&
            chars > limits.maxTotalPageChars - counters.pageChars) {
          const reason = `page exceeds remaining maxTotalPageChars (${limits.maxTotalPageChars - counters.pageChars})`;
          counters.pageChars = limits.maxTotalPageChars;
          details = {
            ...details,
            status: "error",
            contentChars: 0,
            excerpt: null,
            error: { code: ERROR_CODE.BUDGET_EXCEEDED, message: reason, retryable: false },
          };
          result = { content: [{ type: "text", text: `budget_exceeded: ${reason}` }], details, isError: true };
        }
        const isError = Boolean(result?.isError) || details?.status === "error";
        calls.push({
          seq: calls.length + 1,
          callId,
          name,
          status: isError ? "error" : "ok",
          durationMs: Date.now() - started,
          errorCode: isError ? detailsErrorCode(details) : null,
        });

        if (kind === "search") {
          const annotations = provenance.addSearch(details);
          if (annotations.length > 0) {
            const lines = annotations.map((entry) => `${entry.id}: ${entry.url}`);
            return appendModelFacingText(
              result,
              `来源编号（引用时使用）:\n${lines.join("\n")}`,
            );
          }
        } else if (kind === "page") {
          const chars = Number(details?.contentChars);
          if (Number.isFinite(chars) && chars > 0) counters.pageChars += chars;
          const annotation = provenance.addPage(details);
          if (annotation) {
            return appendModelFacingText(
              result,
              `来源编号: ${annotation.id}（状态: ${annotation.status}）`,
            );
          }
        }
        return result;
      } catch (error) {
        const code =
          error?.name === "AbortError"
            ? ERROR_CODE.ABORTED
            : isErrorCode(error?.code)
              ? error.code
              : ERROR_CODE.INTERNAL_ERROR;
        calls.push({
          seq: calls.length + 1,
          callId,
          name,
          status: "error",
          durationMs: Date.now() - started,
          errorCode: code,
        });
        throw error;
      }
    },
  }));
}

/** Merge executor-observed calls with runtime-reported ones, without arguments. */
export function mergeToolCalls(observed, reported) {
  const calls = observed.map((call) => ({ ...call }));
  const seen = new Set(calls.filter((call) => call.callId).map((call) => call.callId));
  if (Array.isArray(reported)) {
    for (const entry of reported) {
      if (!entry || typeof entry.name !== "string") continue;
      if (entry.callId && seen.has(entry.callId)) continue;
      const isError = Boolean(entry.isError) || entry.status === "error";
      const status = isError ? "error" : "ok";
      calls.push({
        seq: calls.length + 1,
        callId: typeof entry.callId === "string" ? entry.callId : null,
        name: entry.name,
        status,
        durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
        errorCode: isErrorCode(entry.errorCode)
          ? entry.errorCode
          : isError
            ? ERROR_CODE.INTERNAL_ERROR
            : null,
      });
    }
  }
  return calls.map((call, index) => ({ ...call, seq: index + 1 }));
}

/** Counters are derived from the persisted call ledger, not from model claims. */
export function deriveCounters(calls = []) {
  const counters = { searches: 0, pages: 0, toolCalls: 0, refused: 0 };
  for (const call of calls) {
    if (call.status === "refused") {
      counters.refused += 1;
      continue;
    }
    counters.toolCalls += 1;
    if (call.name === TOOL.SEARCH) counters.searches += 1;
    if (call.name === TOOL.READ_PAGE) counters.pages += 1;
  }
  return counters;
}

function buildInitialRecord(normalized) {
  const { runId, createdAt, request, limits } = normalized;
  return {
    contractVersion: CONTRACT_VERSION,
    runId,
    status: RUN_STATUS.RUNNING,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    finishedAt: null,
    durationMs: null,
    request: {
      topic: request.topic,
      goal: request.goal,
      timeRange: request.timeRange,
    },
    limits,
    statusHistory: [{ status: RUN_STATUS.RUNNING, at: createdAt }],
    runtime: null,
    tools: {
      counters: { searches: 0, pages: 0, toolCalls: 0, refused: 0 },
      calls: [],
    },
    sourcesSummary: null,
    citations: null,
    errors: [],
    paths: {
      run: ARTIFACT.RUN,
      report: null,
      sources: null,
      sourcesMarkdown: null,
      transcript: null,
    },
  };
}

function buildTranscript({ runId, status, generatedAt, calls }) {
  const lines = [
    `# 工具调用记录 · ${runId}`,
    "",
    `- 生成时间: ${generatedAt}`,
    `- 运行状态: ${status}`,
    "",
    "| # | 工具 | 状态 | 耗时(ms) | 错误码 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const call of calls) {
    lines.push(
      `| ${call.seq} | ${call.name} | ${call.status} | ${call.durationMs ?? "-"} | ${call.errorCode ?? "-"} |`,
    );
  }
  lines.push(
    "",
    "说明: 仅记录工具名、状态、耗时与错误码；不记录调用参数、页面正文或任何凭据。",
  );
  return `${lines.join("\n")}\n`;
}

function resolveRunStatus({ abortReason, runtimeError, runtimeResult, reportBody, calls, sources }) {
  if (abortReason === "deadline") return RUN_STATUS.TIMEOUT;
  if (abortReason === "external") return RUN_STATUS.CANCELLED;
  const runtimeStatus = runtimeResult?.status;
  if (runtimeStatus === RUN_STATUS.CANCELLED) return RUN_STATUS.CANCELLED;
  if (runtimeStatus === RUN_STATUS.TIMEOUT) return RUN_STATUS.TIMEOUT;
  if (runtimeError || runtimeStatus === RUN_STATUS.FAILED || !runtimeResult) return RUN_STATUS.FAILED;
  if (!reportBody) return RUN_STATUS.FAILED;
  const toolFailure = calls.some((call) => call.status !== "ok");
  const sourceFailure = sources.some((source) => source.status === "failed");
  return toolFailure || sourceFailure ? RUN_STATUS.COMPLETED_WITH_ERRORS : RUN_STATUS.COMPLETED;
}

async function prepareExecution(request, deps) {
  const clock = resolveClock(deps.now);
  const normalized = normalizeResearchRequest(request, {
    rootDir: deps.rootDir,
    env: deps.env ?? process.env,
    now: clock(),
  });
  if (!deps.runtimePort) {
    throw new RuntimeUnavailableError(
      "Agent runtime port is not configured. AGT-027 provides the real model runtime; " +
        "pass deps.runtimePort (see src/research/port.mjs).",
    );
  }
  const runtimePort = assertAgentRuntimePort(deps.runtimePort);
  const toolLayer = await resolveToolLayer(deps.toolLayer, normalized.limits);
  const store = deps.store ?? createRunStore({ rootDir: normalized.rootDir, env: deps.env, now: clock });
  if (!store || typeof store.createRun !== "function" || typeof store.saveRun !== "function") {
    throw new ResearchConfigError("store must implement createRun() and saveRun()");
  }

  const record = buildInitialRecord(normalized);
  const context = {
    normalized,
    runtimePort,
    toolLayer,
    store,
    clock,
    deps,
    record,
    provenance: createSourceLedger(),
    calls: [],
    counters: { searches: 0, pages: 0, toolCalls: 0, refused: 0, pageChars: 0 },
  };
  const ready = store.createRun(record);
  const done = ready.then(() => runPreparedExecution(context));
  return { normalized, ready, done };
}

async function runPreparedExecution(context) {
  const { normalized, runtimePort, toolLayer, store, deps, record, provenance, calls, counters } = context;
  const { runId, limits, createdAt } = normalized;
  const startedAtMs = Date.now();

  deps.logger?.info?.(`research run ${runId} started`);
  await store.saveRun(runId, record).catch(() => {});

  const controller = new AbortController();
  let abortReason = null;
  const externalSignal = deps.signal;
  const onExternalAbort = () => {
    if (!abortReason) abortReason = "external";
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const deadlineTimer = setTimeout(() => {
    if (!abortReason) abortReason = "deadline";
    controller.abort();
  }, limits.maxRuntimeMs);
  deadlineTimer.unref?.();

  let runtimeResult = null;
  let runtimeError = null;
  const runtimeStartedAt = Date.now();
  try {
    const wrappedTools = wrapTools({
      tools: toolLayer.tools,
      limits,
      signal: controller.signal,
      calls,
      provenance,
      counters,
    });
    const runNow = context.clock();
    runtimeResult = await runtimePort.runAgent({
      systemPrompt: buildResearchSystemPrompt({ now: runNow, timeRange: normalized.request.timeRange }),
      prompt: buildResearchBrief({
        topic: normalized.request.topic,
        goal: normalized.request.goal,
        timeRange: normalized.request.timeRange,
        now: runNow,
        limits,
        runId,
      }),
      customTools: wrappedTools,
      limits: {
        maxTurns: limits.maxTurns,
        timeoutMs: limits.maxRuntimeMs,
        maxTotalTokens: limits.maxTotalTokens,
        maxToolCalls: limits.maxToolCalls,
      },
      signal: controller.signal,
      onEvent: (event) => {
        if (typeof deps.onEvent === "function") {
          try {
            deps.onEvent(event);
          } catch {
            // Observation callbacks must never break a run.
          }
        }
      },
      metadata: { runId, purpose: "research" },
    });
    if (!runtimeResult || typeof runtimeResult !== "object") {
      runtimeError = toErrorRecord({
        code: ERROR_CODE.MODEL_ERROR,
        message: "agent runtime returned no result object",
        phase: "runtime",
      });
      runtimeResult = null;
    } else if (runtimeResult.status === RUN_STATUS.FAILED && runtimeResult.error) {
      const code = isErrorCode(runtimeResult.error.code)
        ? runtimeResult.error.code
        : ERROR_CODE.MODEL_ERROR;
      runtimeError = toErrorRecord({
        code,
        message: runtimeResult.error.message ?? "agent runtime reported a failure",
        phase: "runtime",
      });
    }
  } catch (error) {
    runtimeError = classifyRuntimeError(error);
  } finally {
    clearTimeout(deadlineTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
  const runtimeDurationMs = Date.now() - runtimeStartedAt;

  const finishedAt = context.clock().toISOString();
  const reportBody = extractReportBody(runtimeResult?.text);
  const mergedCalls = mergeToolCalls(calls, runtimeResult?.toolCalls);
  // Persisted provenance is redacted; ledger identity stays the source id.
  const sources = provenance.snapshot().map(redactSourceRecord);
  const sourcesSummary = summarizeSources(sources);
  const citations = reportBody
    ? resolveCitations(reportBody, sources)
    : { references: [], resolved: [], unresolved: [], unfetched: [], citedSourceIds: [] };
  const citationFault = citations.unresolved.length > 0 || citations.unfetched.length > 0;
  let status = resolveRunStatus({
    abortReason,
    runtimeError,
    runtimeResult,
    reportBody,
    calls,
    sources,
  });
  if (citationFault && status === RUN_STATUS.COMPLETED) status = RUN_STATUS.COMPLETED_WITH_ERRORS;

  const errors = [];
  if (citationFault) {
    errors.push(toErrorRecord({
      code: ERROR_CODE.MODEL_ERROR,
      message: `report citations not verified: ${citations.unresolved.length} unknown, ${citations.unfetched.length} unread`,
      phase: "citations",
    }));
  }
  if (abortReason === "deadline") {
    errors.push(
      toErrorRecord({
        code: ERROR_CODE.TIMEOUT,
        message: `research run exceeded maxRuntimeMs (${limits.maxRuntimeMs}ms)`,
        phase: "deadline",
      }),
    );
  }
  if (abortReason === "external") {
    errors.push(toErrorRecord({
      code: ERROR_CODE.ABORTED,
      message: "research run cancelled by caller",
      phase: "cancel",
    }));
  }
  if (runtimeError) errors.push(runtimeError);
  if (!reportBody && !runtimeError && abortReason === null) {
    errors.push(
      toErrorRecord({
        code: ERROR_CODE.MODEL_ERROR,
        message: runtimeResult
          ? "agent runtime returned no usable Markdown report body"
          : "agent runtime produced no result",
        phase: "report",
      }),
    );
  }
  for (const source of sources) {
    if (source.status !== "failed") continue;
    errors.push(
      toErrorRecord({
        code: source.error?.code,
        message: `${source.id} fetch failed: ${source.error?.message ?? "unknown error"}`,
        phase: "sources",
      }),
    );
  }
  for (const call of mergedCalls) {
    if (call.status === "error") {
      errors.push(
        toErrorRecord({
          code: call.errorCode,
          message: `tool ${call.name} failed`,
          phase: "tools",
        }),
      );
    } else if (call.status === "refused") {
      errors.push(
        toErrorRecord({
          code: ERROR_CODE.BUDGET_EXCEEDED,
          message: `tool ${call.name} refused: run budget exhausted`,
          phase: "tools",
        }),
      );
    }
  }

  const paths = {
    run: ARTIFACT.RUN,
    report: null,
    sources: null,
    sourcesMarkdown: null,
    transcript: null,
  };
  const generatedAt = finishedAt;
  const usage = normalizeUsage(runtimeResult?.usage);
  const runtimeRecord = {
    status: typeof runtimeResult?.status === "string" ? runtimeResult.status : null,
    durationMs: runtimeDurationMs,
    usage,
    error: runtimeError ? { code: runtimeError.code, message: runtimeError.message } : null,
  };
  const statusHistory = [
    ...record.statusHistory,
    ...(status !== RUN_STATUS.RUNNING ? [{ status, at: finishedAt }] : []),
  ];

  const finalRecord = {
    ...record,
    status,
    updatedAt: finishedAt,
    finishedAt,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    statusHistory,
    runtime: runtimeRecord,
    tools: { counters: deriveCounters(mergedCalls), calls: mergedCalls },
    sourcesSummary: {
      total: sourcesSummary.total,
      fetched: sourcesSummary.fetched,
      failed: sourcesSummary.failed,
      not_fetched: sourcesSummary.not_fetched,
      failures: sourcesSummary.failures.map((failure) => ({
        id: failure.id,
        code: failure.error?.code ?? ERROR_CODE.INTERNAL_ERROR,
      })),
    },
    citations: {
      references: citations.references,
      resolved: citations.resolved.map((entry) => ({
        id: entry.id,
        count: entry.count,
        status: entry.status,
      })),
      unresolved: citations.unresolved,
      unfetched: citations.unfetched.map((entry) => ({
        id: entry.id,
        count: entry.count,
        status: entry.status,
      })),
    },
    errors,
    paths,
  };

  // Artifacts first, so the final run.json can name exactly what exists.
  let artifactError = null;
  try {
    await store.writeArtifact(runId, ARTIFACT.SOURCES_JSON, {
      runId,
      generatedAt,
      contractVersion: CONTRACT_VERSION,
      sources,
    });
    paths.sources = ARTIFACT.SOURCES_JSON;

    await store.writeArtifact(
      runId,
      ARTIFACT.SOURCES_MD,
      buildSourcesMarkdown({ sources, runId, generatedAt, failures: errors }),
    );
    paths.sourcesMarkdown = ARTIFACT.SOURCES_MD;

    if (reportBody) {
      const reportMarkdown = buildReportMarkdown({
        body: reportBody,
        runId,
        generatedAt,
        sources,
        citations,
        failures: errors,
      });
      await store.writeArtifact(runId, ARTIFACT.REPORT, reportMarkdown);
      paths.report = ARTIFACT.REPORT;
    }

    await store.writeArtifact(
      runId,
      ARTIFACT.TRANSCRIPT,
      buildTranscript({ runId, status, generatedAt, calls: mergedCalls }),
    );
    paths.transcript = ARTIFACT.TRANSCRIPT;
  } catch (error) {
    artifactError = toErrorRecord({
      code: ERROR_CODE.INTERNAL_ERROR,
      message: `artifact write failed: ${error?.message ?? error}`,
      phase: "artifacts",
    });
    finalRecord.errors = [...errors, artifactError];
    finalRecord.status = RUN_STATUS.FAILED;
    finalRecord.statusHistory = [
      ...record.statusHistory,
      { status: finalRecord.status, at: finishedAt },
    ];
  }

  const persisted = redactDeep(finalRecord);
  await store.saveRun(runId, persisted);
  deps.logger?.info?.(`research run ${runId} finished with status ${persisted.status}`);
  return persisted;
}

/**
 * Execute one research run and resolve with the persisted run record.
 *
 * @param {object} request `{ topic, goal?, timeRange?, limits? }`
 * @param {object} deps see the module docblock
 * @returns {Promise<object>} the persisted `run.json` record
 */
export async function executeResearch(request, deps = {}) {
  const prepared = await prepareExecution(request, deps);
  await prepared.ready;
  return prepared.done;
}

/**
 * Start one research run and return early with its id and a completion promise.
 * The initial `run.json` exists before the returned promise resolves.
 *
 * @returns {Promise<{ runId: string, done: Promise<object> }>}
 */
export async function startResearch(request, deps = {}) {
  const prepared = await prepareExecution(request, deps);
  await prepared.ready;
  return { runId: prepared.normalized.runId, done: prepared.done };
}

export { DEFAULT_RUNS_DIR, RunStoreError, isRunStatus, resolveRunsRoot };
