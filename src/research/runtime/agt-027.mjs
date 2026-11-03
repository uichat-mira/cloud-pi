/**
 * Thin adapter: the AGT-027 Cloud-Pi Agent Runtime 鈫?the research runtime port.
 *
 * AGT-028 does not assemble sessions, register providers or read credentials;
 * this module only translates the two interfaces:
 *
 *   AGT-027  createAgentRuntime({ config, customTools, allowedTools, cwd, extensionFactories })
 *            runtime.run(prompt, { signal, timeoutMs, onEvent }) 鈫?run record
 *   port     runAgent({ systemPrompt, prompt, customTools, limits, signal, onEvent })
 *
 * The research system prompt is injected with Pi's `before_agent_start`
 * extension hook, so the runtime keeps owning prompt assembly.
 *
 * If AGT-027 later exports `createAgentRuntimePort()` itself, `loadAgentRuntimePort`
 * uses that directly and this adapter is not loaded.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PORT_VERSION } from "../port.mjs";

const STATUS_MAP = Object.freeze({
  succeeded: "completed",
  completed: "completed",
  failed: "failed",
  timeout: "timeout",
  cancelled: "cancelled",
});

function numberOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

/**
 * Build a system-prompt extension factory: prepend the research policy to the
 * prompt the runtime rendered, keeping the runtime's own instructions.
 */
export function researchSystemPromptExtension(systemPrompt) {
  return (pi) => {
    pi.on("before_agent_start", async (event) => ({
      systemPrompt: `${systemPrompt}\n\n${event?.systemPrompt ?? ""}`.trim(),
    }));
  };
}

/** Map an AGT-027 run record onto the research port result shape. */
export function mapAgentRuntimeRecord(record) {
  const raw = record && typeof record === "object" ? record : {};
  const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
  const model = raw.model && typeof raw.model === "object" ? raw.model : {};
  const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
  return {
    status: STATUS_MAP[raw.status] ?? "failed",
    text: typeof raw.text === "string" ? raw.text : "",
    // AGT-027's run record always carries numeric token stats (0 when absent),
    // so usage is provider-reported by contract.
    usage: {
      inputTokens: numberOrNull(usage.input),
      outputTokens: numberOrNull(usage.output),
      totalTokens: numberOrNull(usage.total),
      modelId: typeof model.modelId === "string" ? model.modelId : null,
      providerId: typeof model.providerId === "string" ? model.providerId : null,
      source: "provider",
    },
    toolCalls: toolCalls.map((call) => {
      // A denied Pi tool call never executed. It must not be reported as ok.
      const status = call?.status === "blocked" ? "blocked" : call?.status === "ok" ? "ok" : "error";
      return {
        callId: typeof call?.toolCallId === "string" ? call.toolCallId : null,
        name: typeof call?.name === "string" ? call.name : "unknown",
        status,
        durationMs: numberOrNull(call?.durationMs),
        isError: status !== "ok",
      };
    }),
    error: raw.error
      ? {
          code: typeof raw.error.code === "string" ? raw.error.code : "model_error",
          message: typeof raw.error.message === "string" ? raw.error.message : "agent runtime failed",
        }
      : null,
  };
}

/**
 * @param {{ module: object, env?: Record<string,string> }} options
 *   `module` is the imported AGT-027 module namespace.
 */
export function createAgt027RuntimePort({ module, env = process.env } = {}) {
  if (!module || typeof module.createAgentRuntime !== "function") {
    throw new TypeError("AGT-027 module does not export createAgentRuntime()");
  }
  return {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent({ systemPrompt, prompt, customTools, limits = {}, signal, onEvent } = {}) {
      const tools = Array.isArray(customTools) ? customTools : [];
      const names = tools.map((tool) => tool.name).filter((name) => typeof name === "string");
      // Research must not load a repository AGENTS.md into the model context.
      const cwd = mkdtempSync(join(tmpdir(), "cloud-pi-research-cwd-"));
      try {
        const baseConfig = typeof module.loadConfig === "function" ? module.loadConfig(env) : undefined;
        const config =
          baseConfig && Number.isFinite(limits.maxToolCalls)
            ? { ...baseConfig, maxToolCalls: Math.max(1, Math.trunc(limits.maxToolCalls)) }
            : baseConfig;
        const extensionFactories = [];
        if (typeof systemPrompt === "string" && systemPrompt.trim()) {
          extensionFactories.push(researchSystemPromptExtension(systemPrompt));
        }
        // Opt-in: with GUANLAN_MCP_URL set, the research run also reaches Guanlan
        // through Pi's native MCP extension. A bad config or an unusable
        // credential fails the run instead of silently dropping the tools.
        let allowedNames = names;
        let exposedNames = names;
        let guanlanBinding = null;
        if (typeof env.GUANLAN_MCP_URL === "string" && env.GUANLAN_MCP_URL.trim()) {
          // Loaded only when enabled: a research deployment without Guanlan must
          // not depend on the MCP module being present.
          const { createGuanlanMcpBinding } = await import("../../mcp/guanlan.mjs");
          guanlanBinding = createGuanlanMcpBinding({ env, log: () => {} });
          // Fail the run now if the credential is missing or stale: otherwise the
          // MCP connection stays silent and the model answers without real data.
          guanlanBinding.assertReady();
          extensionFactories.push(...guanlanBinding.extensionFactories);
          allowedNames = [...names, ...guanlanBinding.allowedTools];
          exposedNames = [...names, ...guanlanBinding.exposedTools];
        }
        const runtime = await module.createAgentRuntime({
          ...(config ? { config } : { env }),
          cwd,
          allowedTools: allowedNames,
          exposedTools: exposedNames,
          customTools: tools,
          extensionFactories,
        });
        try {
          const record = await runtime.run(prompt, {
            signal,
            ...(Number.isFinite(limits.timeoutMs) ? { timeoutMs: limits.timeoutMs } : {}),
            onEvent,
          });
          // A rejected credential or a dead server must not turn into an answer
          // built from nothing: if Guanlan was enabled and no MCP tool succeeded,
          // the run fails with the transport verdict instead of "completed".
          if (guanlanBinding) {
            const usedGuanlan = (record.toolCalls ?? []).some(
              (call) => typeof call.name === "string" && call.name.startsWith("mcp__guanlan__") && call.status === "ok",
            );
            const health = guanlanBinding.health();
            if (!usedGuanlan && !health.ok) {
              const error = new Error(
                `mcp_server_unavailable: ${health.reason}${Number.isFinite(health.status) ? ` (HTTP ${health.status})` : ""}`,
              );
              error.code = "mcp_server_unavailable";
              throw error;
            }
          }
          return mapAgentRuntimeRecord(record);
        } finally {
          runtime.dispose?.();
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
