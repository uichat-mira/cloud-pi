/**
 * Real Pi SDK session wiring for the Cloud Pi P0.
 *
 * Everything below is the public `@earendil-works/pi-coding-agent` SDK surface:
 * a real AgentSession, the real built-in MCP extension, and the real streamable
 * HTTP transport from `@earendil-works/pi-mcp`. Only the model is scripted, using
 * the SDK's own `fauxProvider` test provider, so tool selection is deterministic
 * without faking the Pi extension pipeline or the MCP server.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export const MCP_SERVER_NAME = "guanlan";
export const TOOL_WHOAMI = "mcp__guanlan__guanlan_whoami";
export const TOOL_NEWS = "mcp__guanlan__guanlan_news_recent";
export const EXPECTED_TOOLS = [TOOL_NEWS, TOOL_WHOAMI].sort();

/**
 * Creates one Pi SDK session bound to a Guanlan fixture URL.
 *
 * `token` is a fixture credential from the trusted test host. It is passed only
 * through the MCP server configuration (an HTTP header); it never enters the
 * model prompt, tool arguments, transcript or logs captured by this POC.
 */
export async function createPocSession({
  bridgeUrl,
  token,
  timeoutSeconds = 30,
  deniedTools = [],
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "cloud-pi-p0-"));
  const logPath = join(tempDir, "mcp.log");

  const faux = fauxProvider({
    provider: "p0-faux",
    models: [{ id: "p0-scripted", name: "P0 scripted model" }],
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(tempDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const capture = { toolCalls: [], toolResults: [], notifications: [] };
  const gate = { denied: new Set(deniedTools), blocked: [] };
  let api;

  const serverConfig = (credential) => ({
    url: bridgeUrl,
    headers: { Authorization: `Bearer ${credential}` },
    exposure: "direct",
    timeout: timeoutSeconds,
  });

  const p0Plugin = (pi) => {
    api = pi;
    pi.registerMcpServer(MCP_SERVER_NAME, serverConfig(token));
    pi.on("tool_call", (event) => {
      capture.toolCalls.push({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: structuredClone(event.input),
      });
      if (!event.toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)) return;
      const tool = event.toolName.slice(`mcp__${MCP_SERVER_NAME}__`.length);
      if (gate.denied.has(tool)) {
        gate.blocked.push(tool);
        return { block: true, reason: `P0 permission gate: ${tool} is not granted to this session` };
      }
      return undefined;
    });
    pi.on("tool_result", (event) => {
      capture.toolResults.push({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        content: structuredClone(event.content),
        structuredContent: structuredClone(event.structuredContent),
        isError: event.isError,
      });
    });
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd: tempDir,
    agentDir: tempDir,
    extensionFactories: [p0Plugin, createMcpExtension({ logPath })],
  });
  await resourceLoader.reload();

  const settingsManager = SettingsManager.inMemory({});
  const { session } = await createAgentSession({
    cwd: tempDir,
    agentDir: tempDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    // Only the two granted Guanlan tools; no built-in tools are exposed.
    tools: [`mcp__${MCP_SERVER_NAME}__*`],
  });
  await session.bindExtensions({});

  return {
    session,
    faux,
    capture,
    gate,
    logPath,
    tempDir,
    serverConfig,
    /** Rotate the test credential by replacing this extension's server registration. */
    rotateToken(nextToken) {
      api.registerMcpServer(MCP_SERVER_NAME, serverConfig(nextToken));
    },
    /** Re-read the current server registration; used after a credential rotation. */
    async reload() {
      await session.reload();
    },
    readLog() {
      try {
        return readFileSync(logPath, "utf8");
      } catch {
        return "";
      }
    },
    dispose() {
      session.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** The MCP tools currently declared to the model. */
export function activeMcpTools(session) {
  return session
    .getActiveToolNames()
    .filter((name) => name.startsWith(`mcp__${MCP_SERVER_NAME}__`))
    .sort();
}

export async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Wait until the MCP extension has connected and declared the two read tools. */
export async function waitForMcpTools(session, timeoutMs = 15000) {
  await waitFor(() => activeMcpTools(session).length === EXPECTED_TOOLS.length, {
    timeoutMs,
    label: "MCP tools to connect",
  });
  return activeMcpTools(session);
}

/**
 * Drive one real model turn that selects `toolName` with `args`, then a final
 * text turn. The tool call itself runs through Pi's tool pipeline.
 */
export async function scriptedToolCall(session, faux, toolName, args = {}) {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(toolName, args, { id: `p0-${toolName}` })], { stopReason: "toolUse" }),
    fauxAssistantMessage("p0-done"),
  ]);
  await session.prompt(`P0 deterministic call to ${toolName}`);
}

/** The latest transcript tool result for one tool. */
export function lastToolResult(session, toolName) {
  return session.messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === toolName,
  );
}

/** The Guanlan page carried by the Pi tool result (nested CallToolResult). */
export function guanlanPageFromResult(result) {
  return result?.structuredContent?.structuredContent;
}

export function textOf(content) {
  return (content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
