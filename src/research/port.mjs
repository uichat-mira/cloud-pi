/**
 * Agent Runtime port consumed by the research executor.
 *
 * AGT-027 owns the real model provider, Pi session assembly, tool execution
 * permissions and credential loading. AGT-028 must consume that runtime instead
 * of assembling a second one. The port below is the only coupling surface; the
 * executor receives a port instance by dependency injection so deterministic
 * tests can substitute a scripted port without touching product code.
 *
 * Until AGT-027's module lands on `dev`, the live CLI fails closed with
 * RuntimeUnavailableError. Nothing in this feature may import a provider, read
 * an API key or build its own Pi session outside tests.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RUNTIME_PORT_VERSION = 1;

export class RuntimeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeUnavailableError";
    this.code = "runtime_unavailable";
  }
}

/**
 * @typedef {Object} AgentRunSpec
 * @property {string} systemPrompt   Full system prompt for the research run.
 * @property {string} prompt         User-side research brief.
 * @property {import("@earendil-works/pi-ai").ToolDefinition[]} customTools
 *   Pi tool definitions (createAgentSession `customTools`). The runtime decides
 *   exposure/permissions; research tools are read-only and must stay read-only.
 * @property {{ maxTurns: number, timeoutMs: number, maxTotalTokens?: number,
 *   maxToolCalls?: number }} limits
 *   `timeoutMs`/`maxToolCalls` are the research budget; a runtime default must
 *   not silently cap a research run below them.
 * @property {AbortSignal} [signal]
 * @property {(event: AgentRunEvent) => void} [onEvent]  Observation only.
 * @property {{ runId: string, purpose: "research" }} metadata
 */

/**
 * @typedef {Object} AgentRunEvent
 * @property {"tool_start"|"tool_end"|"text_delta"|"turn"} type
 * @property {string} [toolName]
 * @property {string} [toolCallId]
 * @property {number} [durationMs]
 * @property {boolean} [isError]
 * @property {string} [errorCode]
 */

/**
 * @typedef {Object} AgentRunResult
 * @property {"completed"|"failed"|"cancelled"|"timeout"} status
 * @property {string} text  Final assistant text (may be empty on failure).
 * @property {{ inputTokens: number|null, outputTokens: number|null,
 *   totalTokens: number|null, modelId: string|null, providerId: string|null,
 *   source: "provider"|"unknown" }} usage
 * @property {Array<{ callId: string|null, name: string, status: string,
 *   durationMs: number|null, isError: boolean }>} toolCalls
 * @property {{ code: string, message: string }|null} [error]
 */

/**
 * @typedef {Object} AgentRuntimePort
 * @property {number} portVersion
 * @property {(spec: AgentRunSpec) => Promise<AgentRunResult>} runAgent
 */

/** @param {unknown} port */
export function assertAgentRuntimePort(port) {
  if (!port || typeof port !== "object") {
    throw new RuntimeUnavailableError("Agent runtime port is not configured");
  }
  if (port.portVersion !== RUNTIME_PORT_VERSION) {
    throw new RuntimeUnavailableError(
      `Unsupported agent runtime port version: ${String(port.portVersion)} (expected ${RUNTIME_PORT_VERSION})`,
    );
  }
  if (typeof port.runAgent !== "function") {
    throw new RuntimeUnavailableError("Agent runtime port is missing runAgent()");
  }
  return port;
}

/**
 * Load the AGT-027 runtime module. The module specifier is trusted local
 * configuration (absolute path, file URL or an installed package name), never
 * model-controlled. The module must export `createAgentRuntimePort()` or a
 * ready `agentRuntimePort`.
 *
 * @param {{ moduleSpecifier?: string|null }} [options]
 * @returns {Promise<AgentRuntimePort>}
 */
export async function loadAgentRuntimePort({ moduleSpecifier } = {}) {
  // After AGT-027 lands on the same branch, its runtime is the sibling
  // `src/index.mjs`; before that the live path still fails closed.
  const fallback = new URL("../index.mjs", import.meta.url);
  const requested = typeof moduleSpecifier === "string" && moduleSpecifier.trim() ? moduleSpecifier.trim() : null;
  const specifier = requested ?? (existsSync(fileURLToPath(fallback)) ? fallback.href : null);
  if (!specifier) {
    throw new RuntimeUnavailableError(
      "Agent runtime module is not configured. AGT-027 provides the real model " +
        "runtime; set RESEARCH_AGENT_RUNTIME_MODULE (or pass --runtime-module) " +
        "to the module it publishes (default candidate: src/index.mjs).",
    );
  }
  let mod;
  try {
    mod = await import(moduleSpecifier);
  } catch (error) {
    throw new RuntimeUnavailableError(
      `Cannot load agent runtime module ${specifier}: ${error?.message ?? error}`,
    );
  }
  let port =
    typeof mod.createAgentRuntimePort === "function"
      ? await mod.createAgentRuntimePort({ purpose: "research" })
      : mod.agentRuntimePort;
  if (!port && typeof mod.createAgentRuntime === "function") {
    // AGT-027 shape: adapt the official runtime instead of duplicating it.
    const { createAgt027RuntimePort } = await import("./runtime/agt-027.mjs");
    port = createAgt027RuntimePort({ module: mod });
  }
  return assertAgentRuntimePort(port);
}
