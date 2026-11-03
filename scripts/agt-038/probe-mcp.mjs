#!/usr/bin/env node
/**
 * AGT-038 MCP connection probe: no model call, only the real MCP binding.
 *
 * Builds a real Pi session with the Guanlan binding, waits for the MCP
 * extension to declare the tools from a real `tools/list`, and reports the
 * declared names. Used to separate "MCP binding broken" from "model misbehaved".
 *
 * Usage: node scripts/agt-038/probe-mcp.mjs
 */
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createGuanlanMcpBinding, loadGuanlanMcpConfig } from "../../src/mcp/guanlan.mjs";

const MCP_LOG = `${process.env.TEMP}\\gln013-t23\\t9-probe-mcp.log`;
const evidence = { event: "agt038_probe_mcp", ok: false };
let exitCode = 1;

function logTail() {
  try {
    return readFileSync(MCP_LOG, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-15)
      .join("\n")
      .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
      .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g, "<redacted-jwt>");
  } catch {
    return null;
  }
}

try {
  const config = loadGuanlanMcpConfig(process.env);
  const traceFetch = async (input, init) => {
    const startedAt = Date.now();
    try {
      const response = await fetch(input, init);
      process.stderr.write(
        `${JSON.stringify({ ev: "mcp_http", url: String(input).slice(0, 120), status: response.status, ms: Date.now() - startedAt })}\n`,
      );
      return response;
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          ev: "mcp_http_error",
          url: String(input).slice(0, 120),
          code: error?.cause?.code ?? error?.code ?? null,
          message: String(error?.message ?? error).slice(0, 200),
          ms: Date.now() - startedAt,
        })}\n`,
      );
      throw error;
    }
  };
  const binding = createGuanlanMcpBinding({
    env: process.env,
    config,
    log: () => {},
    logPath: MCP_LOG,
    fetch: traceFetch,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "cloud-pi-t9-probe-"));
  const faux = fauxProvider({ provider: "t9-faux", models: [{ id: "t9-scripted", name: "T9 scripted model" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(tempDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const resourceLoader = new DefaultResourceLoader({
    cwd: tempDir,
    agentDir: tempDir,
    extensionFactories: binding.extensionFactories,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: tempDir,
    agentDir: tempDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    settingsManager: SettingsManager.inMemory({}),
    sessionManager: SessionManager.inMemory(),
    tools: binding.exposedTools,
  });
  await session.bindExtensions({});

  const startedAt = Date.now();
  let tools = [];
  while (Date.now() - startedAt < 20_000) {
    tools = session.getActiveToolNames().filter((name) => name.startsWith("mcp__guanlan__"));
    if (tools.length >= binding.config.tools.length) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  evidence.tools = [...tools].sort();
  evidence.expected = binding.config.tools.map((tool) => `mcp__guanlan__${tool}`).sort();
  evidence.waitedMs = Date.now() - startedAt;
  evidence.credential = binding.credentials.describe();
  evidence.ok = evidence.expected.every((name) => evidence.tools.includes(name));
  evidence.mcpLogTail = logTail();
  exitCode = evidence.ok ? 0 : 1;
  evidence.exitCode = exitCode;
} catch (error) {
  evidence.error = { code: error?.code ?? "error", message: String(error?.message ?? error).slice(0, 400) };
  evidence.mcpLogTail = logTail();
  exitCode = 1;
  evidence.exitCode = 1;
} finally {
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  process.exitCode = exitCode;
}
