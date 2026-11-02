/**
 * T3 verification harness (AGT-028, verifier-owned).
 *
 * Builds a *real* Pi SDK `AgentSession` whose only model is the SDK's own
 * `fauxProvider`, and whose tools are the *real* research `ToolDefinition`s
 * (`research_web_search`, `research_read_page`). Everything below the model is
 * the production Pi pipeline: argument validation, `tool_call`/`tool_result`
 * extension events, abort propagation, transcript persistence.
 *
 * Two isolation guarantees, because these tests must never reach the internet:
 *
 * 1. Every tool dependency is pointed at a `startFixtureServer()` instance on
 *    127.0.0.1 and called with `allowLoopback: true` / `proxyUrl: null` /
 *    `env: {}`.
 * 2. `installNetworkGuard()` patches `net.Socket.prototype.connect` so an
 *    outbound connection to anything other than loopback throws immediately and
 *    is recorded. The guard is installed on import; every test file asserts
 *    `assertNoNetworkEgress()` in `after`. A guard violation fails the test even
 *    if the tool swallowed the resulting transport error.
 *
 * This is test-only code. It is not part of the product runtime and must never
 * be imported from `src/`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RUNTIME_PORT_VERSION } from "../../src/research/port.mjs";

export const PI_CODING_AGENT_VERSION = "1.4.0";

/* -------------------------------------------------------------------------- */
/* Network guard                                                              */
/* -------------------------------------------------------------------------- */

const ALLOWED_CONNECT_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"]);

function connectTarget(args) {
  const [first, second] = args;
  // net.Socket#connect(options[, listener])
  if (first && typeof first === "object") {
    // A unix socket / pipe path is local by definition.
    if (typeof first.path === "string") return { local: true, host: first.path };
    return { local: false, host: String(first.host ?? first.hostname ?? "localhost"), port: first.port };
  }
  // net.Socket#connect(port[, host][, listener])
  if (typeof first === "number") {
    return { local: false, host: String(typeof second === "string" ? second : "localhost"), port: first };
  }
  // net.Socket#connect(path[, listener])
  return { local: true, host: String(first) };
}

function createGuard() {
  const violations = [];
  const original = net.Socket.prototype.connect;
  let installed = false;

  function patched(...args) {
    const target = connectTarget(args);
    if (!target.local && !ALLOWED_CONNECT_HOSTS.has(target.host)) {
      const violation = {
        host: target.host,
        port: target.port ?? null,
        stack: new Error("network guard stack").stack,
      };
      violations.push(violation);
      throw new Error(
        `[network-guard] blocked outbound connection to ${target.host}:${target.port ?? "?"}; tests must only use loopback fixtures`,
      );
    }
    return original.apply(this, args);
  }

  return {
    violations,
    install() {
      if (installed) return;
      net.Socket.prototype.connect = patched;
      installed = true;
    },
    restore() {
      if (!installed) return;
      net.Socket.prototype.connect = original;
      installed = false;
    },
  };
}

export const networkGuard = createGuard();
// Auto-install: importing the harness is enough to protect a test file.
networkGuard.install();

/** Assert that no test in this file attempted a non-fixture outbound socket. */
export function assertNoNetworkEgress() {
  if (networkGuard.violations.length > 0) {
    const detail = networkGuard.violations
      .map((violation) => `${violation.host}:${violation.port ?? "?"}`)
      .join(", ");
    throw new Error(`network guard recorded ${networkGuard.violations.length} outbound connection(s): ${detail}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Real Pi session with the real research tools                               */
/* -------------------------------------------------------------------------- */

function tempDirFor(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Create one real Pi AgentSession bound to the faux model.
 *
 * @param {object} options
 * @param {Array<object>} options.tools  Real Pi `ToolDefinition`s (customTools).
 * @param {string} [options.systemPrompt]
 * @param {string} [options.cwd]
 * @param {string} [options.modelId]
 */
export async function createResearchSession({
  tools,
  systemPrompt = "You are a deterministic research test agent. Use the provided read-only research tools.",
  cwd,
  modelId = "research-scripted",
} = {}) {
  if (!Array.isArray(tools) || tools.length === 0) throw new Error("createResearchSession requires tools");
  const dir = cwd ?? tempDirFor("cloud-pi-t3-session-");
  const ownsDir = cwd === undefined;

  const faux = fauxProvider({
    provider: "research-faux",
    models: [{ id: modelId, name: "T3 scripted research model" }],
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const capture = { toolCalls: [], toolResults: [] };
  const plugin = (pi) => {
    pi.on("tool_call", (event) => {
      capture.toolCalls.push({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: structuredClone(event.input),
      });
      return undefined;
    });
    pi.on("tool_result", (event) => {
      capture.toolResults.push({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        content: structuredClone(event.content),
        details: structuredClone(event.details),
        isError: event.isError,
      });
    });
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    extensionFactories: [plugin],
    systemPrompt,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noExtensions: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    settingsManager: SettingsManager.inMemory({}),
    sessionManager: SessionManager.inMemory(),
    customTools: tools,
    // Only the supplied research tools are activatable; no built-in read/bash/edit/write.
    tools: tools.map((tool) => tool.name),
  });
  await session.bindExtensions({});

  const handle = {
    session,
    faux,
    capture,
    dir,
    /** Scripted turn: N assistant tool calls then one final assistant text. */
    async run(steps) {
      faux.setResponses(steps);
      await session.prompt("T3 deterministic research turn");
    },
    lastToolResult(toolName) {
      return session.messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === toolName,
      );
    },
    activeToolNames() {
      return session.getActiveToolNames().sort();
    },
    dispose() {
      session.dispose();
      if (ownsDir) rmSync(dir, { recursive: true, force: true });
    },
  };
  return handle;
}

/** Build one faux assistant message that calls `name` with `args`. */
export function toolCallStep(name, args = {}, { id } = {}) {
  return fauxAssistantMessage([fauxToolCall(name, args, { id: id ?? `call-${name}` })], {
    stopReason: "toolUse",
  });
}

/** Build one faux final assistant text message. */
export function textStep(text) {
  return fauxAssistantMessage(text, { stopReason: "stop" });
}

/** Wrap a real ToolDefinition so a test can prove `execute` did or did not run. */
export function spyOnTool(definition) {
  const calls = [];
  return {
    calls,
    definition: {
      ...definition,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        calls.push({ toolCallId, params: structuredClone(params) });
        return definition.execute(toolCallId, params, signal, onUpdate, ctx);
      },
    },
  };
}

function messageText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function toolResultText(result) {
  return messageText(result?.content);
}

/** Every toolResult in the transcript, in order, reduced for assertions. */
export function transcriptToolResults(session) {
  return session.messages
    .filter((message) => message.role === "toolResult")
    .map((message) => ({
      toolCallId: message.toolCallId ?? null,
      toolName: message.toolName,
      isError: Boolean(message.isError),
      durationMs: Number.isFinite(message.durationMs) ? message.durationMs : null,
      text: messageText(message.content),
      details: message.details ?? null,
    }));
}

/* -------------------------------------------------------------------------- */
/* Test-only runtime port backed by a real Pi session                          */
/* -------------------------------------------------------------------------- */

/**
 * A *test* implementation of the AGT-027 runtime port (`port.mjs`) that drives
 * a real Pi session. It exists only to prove the executor's mapping against the
 * real Pi pipeline in T3; production must use the AGT-027 module.
 *
 * `responses` is a list of faux response steps (or a factory that receives the
 * spec). The port creates a fresh session per `runAgent` call, passes the
 * executor's `customTools` to Pi, and maps transcript state back to the port's
 * `AgentRunResult` shape.
 */
export function createPiPipelinePort({ responses, systemPrompt, cwd } = {}) {
  const sessions = [];

  function usageFromStats(stats, model) {
    const tokens = stats?.tokens ?? {};
    const asNumber = (value) => (Number.isFinite(value) ? Number(value) : null);
    const inputTokens = asNumber(tokens.input);
    const outputTokens = asNumber(tokens.output);
    const totalTokens = asNumber(tokens.total);
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      modelId: typeof model?.id === "string" ? model.id : null,
      providerId: typeof model?.provider === "string" ? model.provider : null,
      source: totalTokens === null ? "unknown" : "provider",
    };
  }

  return {
    portVersion: RUNTIME_PORT_VERSION,
    sessions,
    disposeAll() {
      for (const handle of sessions) {
        try {
          handle.dispose();
        } catch {
          // best effort cleanup for test-only sessions
        }
      }
      sessions.length = 0;
    },
    async runAgent(spec) {
      const steps = typeof responses === "function" ? await responses(spec) : responses;
      if (!Array.isArray(steps)) throw new Error("createPiPipelinePort: responses must be an array");
      const handle = await createResearchSession({
        tools: spec.customTools,
        systemPrompt: systemPrompt ?? spec.systemPrompt ?? "T3 research system prompt",
        cwd,
      });
      sessions.push(handle);
      let status = "completed";
      let error = null;
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        handle.session.abort().catch(() => {});
      };
      spec.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        handle.faux.setResponses(steps);
        await handle.session.prompt(spec.prompt);
      } catch (caught) {
        error = {
          code: caught?.code === "aborted" || caught?.name === "AbortError" ? "aborted" : "model_error",
          message: String(caught?.message ?? caught),
        };
      } finally {
        spec.signal?.removeEventListener("abort", onAbort);
      }
      if (aborted || spec.signal?.aborted) {
        status = "cancelled";
        error = null;
      } else if (error) {
        status = "failed";
      }
      const stats = handle.session.getSessionStats();
      const toolCalls = transcriptToolResults(handle.session).map((entry) => ({
        callId: entry.toolCallId,
        name: entry.toolName,
        status: entry.isError ? "error" : "ok",
        durationMs: entry.durationMs,
        isError: entry.isError,
      }));
      const model = handle.session.model;
      return {
        status,
        text: handle.session.getLastAssistantText?.() ?? "",
        usage: usageFromStats(stats, model),
        toolCalls,
        ...(error ? { error } : {}),
      };
    },
  };
}
