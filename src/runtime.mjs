/**
 * Cloud Pi Agent runtime: one real Pi SDK session per run, on a configured live model.
 *
 * The public surface is deliberately small so AGT-028 (research tools) can reuse
 * it without copying session assembly:
 *
 *   const runtime = await createAgentRuntime({ allowedTools, extensionFactories });
 *   const result = await runtime.run("prompt");
 *   runtime.dispose();
 *
 * Failures of the model, the network or a tool are returned as a classified run
 * record, not thrown; only invalid construction arguments throw.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { classifyError, RuntimeError } from "./errors.mjs";
import { describeConfig, loadConfig, redactSecrets } from "./config.mjs";
import { createModelRuntime } from "./provider.mjs";

const RESULT_PREVIEW_CHARS = 2_000;
const IDLE_GRACE_MS = 10_000;

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Exact names and `*` wildcards, e.g. `mcp__guanlan__*`. Never allows anything by default. */
export function isToolAllowed(toolName, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((pattern) => typeof pattern === "string" && pattern.length > 0 && globToRegExp(pattern).test(toolName));
}

function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Permission gate and run observation.
 *
 * The gate is the runtime enforcement point, not the tool declaration: a tool
 * can be visible to the model and still be denied execution here.
 */
function createRunGuard({ capture, allowedTools, maxToolCalls, onEvent, secrets }) {
  return (pi) => {
    let executed = 0;
    pi.on("tool_call", (event) => {
      const record = {
        id: event.toolCallId,
        name: event.toolName,
        status: "pending",
        requestedAt: new Date().toISOString(),
      };
      capture.records.set(event.toolCallId, record);
      capture.order.push(record);
      emit(onEvent, { type: "tool_call", tool: event.toolName, toolCallId: event.toolCallId });

      if (!isToolAllowed(event.toolName, allowedTools)) {
        record.status = "blocked";
        record.reason = "tool_not_granted";
        return {
          block: true,
          reason: `tool_not_granted: ${event.toolName} is not granted to this session`,
        };
      }
      if (executed >= maxToolCalls) {
        record.status = "blocked";
        record.reason = "tool_budget_exhausted";
        return {
          block: true,
          reason: `tool_budget_exhausted: this run allows at most ${maxToolCalls} tool calls`,
          terminate: true,
        };
      }
      executed += 1;
      record.status = "running";
      record.startedAt = Date.now();
      return undefined;
    });

    pi.on("tool_result", (event) => {
      const record = capture.records.get(event.toolCallId);
      if (!record) return;
      record.status = event.isError ? "error" : "ok";
      record.error = Boolean(event.isError);
      if (typeof record.startedAt === "number") record.durationMs = Date.now() - record.startedAt;
      record.resultPreview = redactSecrets(textOfContent(event.content), secrets).slice(0, RESULT_PREVIEW_CHARS);
      emit(onEvent, {
        type: "tool_result",
        tool: event.toolName,
        toolCallId: event.toolCallId,
        status: record.status,
        durationMs: record.durationMs,
      });
    });
  };
}

function emit(listener, event) {
  if (typeof listener !== "function") return;
  try {
    listener(event);
  } catch {
    // Observers must not be able to break a run.
  }
}

function normalizePatterns(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new TypeError(`${name} must be an array of non-empty tool name patterns`);
  }
  return [...new Set(value)];
}

/**
 * Create a reusable runtime bound to one model configuration and tool policy.
 *
 * @param {object} options
 * @param {object} [options.config] validated config; otherwise `loadConfig(env)` runs
 * @param {Record<string,string>} [options.env] environment source when `config` is omitted
 * @param {string[]} [options.allowedTools] execution allowlist (patterns); default: none
 * @param {string[]} [options.exposedTools] model-visible allowlist; default: `allowedTools`
 * @param {object[]} [options.customTools] Pi `ToolDefinition`s registered for this runtime
 * @param {Function[]} [options.extensionFactories] Pi extension factories (e.g. native MCP in AGT-028)
 * @param {string} [options.cwd] session working directory; default: `process.cwd()`
 * @param {object} [options.modelRuntime] injected Pi ModelRuntime (tests)
 * @param {object} [options.model] injected Pi model (tests)
 */
export async function createAgentRuntime(options = {}) {
  const config = options.config ?? loadConfig(options.env ?? process.env);
  const secrets = [config.apiKey].filter(Boolean);

  const allowedTools = normalizePatterns(options.allowedTools, "allowedTools");
  const exposedTools =
    options.exposedTools === undefined ? allowedTools : normalizePatterns(options.exposedTools, "exposedTools");
  const customTools = Array.isArray(options.customTools) ? [...options.customTools] : [];
  const extensionFactories = Array.isArray(options.extensionFactories) ? [...options.extensionFactories] : [];
  const cwd = options.cwd ?? process.cwd();

  let ownedModelRuntime;
  let modelRuntime = options.modelRuntime;
  let model = options.model;
  if (!modelRuntime || !model) {
    ownedModelRuntime = await createModelRuntime(config);
    modelRuntime = ownedModelRuntime.modelRuntime;
    model = ownedModelRuntime.model;
  }

  const ownedAgentDir = options.agentDir === undefined;
  const agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "cloud-pi-agent-"));
  let disposed = false;

  return {
    config: describeConfig(config),
    model: { providerId: config.providerId, modelId: config.modelId, api: config.api },
    description: describeConfig(config),

    /**
     * Run one prompt to completion.
     *
     * @param {string} prompt
     * @param {object} [runOptions]
     * @param {AbortSignal} [runOptions.signal] caller cancellation
     * @param {number} [runOptions.timeoutMs] overrides `CLOUD_PI_RUN_TIMEOUT_MS`
     * @param {Function} [runOptions.onEvent] observes tool names/status only, never content
     * @returns {Promise<object>} classified run record
     */
    async run(prompt, runOptions = {}) {
      if (disposed) throw new RuntimeError("runtime_disposed", "This Agent runtime has been disposed");
      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        throw new TypeError("run(prompt) requires a non-empty prompt string");
      }

      const timeoutMs = runOptions.timeoutMs ?? config.runTimeoutMs;
      const runId = randomUUID();
      const startedAt = Date.now();
      const capture = { records: new Map(), order: [] };

      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        extensionFactories: [
          createRunGuard({ capture, allowedTools, maxToolCalls: config.maxToolCalls, onEvent: runOptions.onEvent, secrets }),
          ...extensionFactories,
        ],
      });

      let session;
      try {
        await resourceLoader.reload();
        ({ session } = await createAgentSession({
          cwd,
          agentDir,
          modelRuntime,
          model,
          resourceLoader,
          settingsManager: SettingsManager.inMemory({}),
          sessionManager: SessionManager.inMemory(),
          customTools,
          // Empty list is meaningful: no built-in read/bash/edit/write tools leak in.
          tools: exposedTools,
        }));
        await session.bindExtensions({});
      } catch (error) {
        session?.dispose();
        const record = buildFailureRecord({ runId, config, startedAt, timeoutMs, error, secrets });
        emit(runOptions.onEvent, { type: "run_end", runId, status: record.status });
        return record;
      }

      let timedOut = false;
      let cancelled = false;
      let idleTimedOut = false;
      let promptError;

      const abort = () => {
        void session.abort().catch(() => {});
      };
      const onCallerAbort = () => {
        cancelled = true;
        abort();
      };

      const timer =
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              abort();
            }, timeoutMs)
          : undefined;

      if (runOptions.signal) {
        if (runOptions.signal.aborted) onCallerAbort();
        else runOptions.signal.addEventListener("abort", onCallerAbort, { once: true });
      }

      emit(runOptions.onEvent, { type: "run_start", runId });

      try {
        try {
          await session.prompt(prompt);
        } catch (error) {
          promptError = error;
        }
        const idle = session.waitForIdle().then(
          () => true,
          () => true,
        );
        const becameIdle = await Promise.race([
          idle,
          new Promise((resolveWait) => setTimeout(() => resolveWait(false), IDLE_GRACE_MS).unref?.()),
        ]);
        idleTimedOut = becameIdle === false;
      } finally {
        if (timer) clearTimeout(timer);
        runOptions.signal?.removeEventListener("abort", onCallerAbort);
      }

      let record;
      try {
        record = buildRunRecord({
          runId,
          config,
          capture,
          session,
          promptError,
          timedOut,
          cancelled,
          idleTimedOut,
          startedAt,
          timeoutMs,
          secrets,
        });
      } finally {
        session.dispose();
      }
      emit(runOptions.onEvent, { type: "run_end", runId, status: record.status });
      return record;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      ownedModelRuntime?.dispose();
      if (ownedAgentDir) rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

function buildFailureRecord({ runId, config, startedAt, timeoutMs, error, secrets }) {
  const failure = classifyError(error, { secrets });
  return {
    runId,
    status: "failed",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    model: { providerId: config.providerId, modelId: config.modelId, api: config.api },
    limits: { timeoutMs, maxToolCalls: config.maxToolCalls, maxOutputTokens: config.maxOutputTokens },
    text: "",
    stopReason: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
    toolCalls: [],
    error: failure,
  };
}

function buildRunRecord({ runId, config, capture, session, promptError, timedOut, cancelled, idleTimedOut, startedAt, timeoutMs, secrets }) {
  const messages = session.messages;
  const lastAssistant = messages.findLast((message) => message.role === "assistant");
  const stats = session.getSessionStats();

  let status = "succeeded";
  let error = null;

  if (timedOut) {
    status = "timeout";
    error = classifyError(promptError ?? new Error(`run timed out after ${timeoutMs}ms`), {
      secrets,
      timedOut: true,
    });
  } else if (cancelled) {
    status = "cancelled";
    error = classifyError(promptError ?? new Error("run was cancelled by the caller"), {
      secrets,
      cancelled: true,
    });
  } else if (promptError) {
    status = "failed";
    error = classifyError(promptError, { secrets });
  } else if (idleTimedOut) {
    status = "failed";
    error = classifyError(new Error(`session did not become idle within ${IDLE_GRACE_MS}ms`), {
      secrets,
      timedOut: true,
    });
  } else if (lastAssistant?.stopReason === "error") {
    status = "failed";
    error = classifyError(new Error(lastAssistant.errorMessage ?? "model request failed"), { secrets });
  } else if (lastAssistant?.stopReason === "aborted") {
    status = "cancelled";
    error = classifyError(new Error(lastAssistant.errorMessage ?? "model request aborted"), {
      secrets,
      cancelled: true,
    });
  }

  const text = textOfContent(lastAssistant?.content ?? []);
  const toolCalls = capture.order.map((record) => ({
    name: record.name,
    toolCallId: record.id,
    status: record.status,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
    ...(record.resultPreview !== undefined ? { resultPreview: record.resultPreview } : {}),
  }));

  return {
    runId,
    status,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    model: {
      providerId: config.providerId,
      modelId: config.modelId,
      api: config.api,
    },
    limits: {
      timeoutMs,
      maxToolCalls: config.maxToolCalls,
      maxOutputTokens: config.maxOutputTokens,
    },
    text,
    stopReason: lastAssistant?.stopReason ?? null,
    usage: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      total: stats.tokens.total,
      cost: stats.cost,
    },
    toolCalls,
    error,
  };
}

/**
 * Convenience one-shot helper for callers that do not need a reusable runtime.
 * Creates, runs and disposes the runtime in one call.
 */
export async function runAgentOnce(prompt, options = {}) {
  const runtime = await createAgentRuntime(options);
  try {
    return await runtime.run(prompt, options.runOptions ?? {});
  } finally {
    runtime.dispose();
  }
}
