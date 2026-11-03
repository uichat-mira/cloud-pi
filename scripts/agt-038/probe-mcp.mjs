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
import { mkdtempSync, rmSync } from "node:fs";
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
import { redactCompactJwt } from "../../src/redaction.mjs";

/**
 * Private per-run directory for the MCP log.
 *
 * `mkdtemp` gives a fresh 0700 directory instead of a fixed path under a shared
 * temp root, so the probe cannot be pointed at a file another local user
 * prepared. Removed on exit.
 */
const RUN_DIR = mkdtempSync(join(tmpdir(), "agt-038-probe-"));
const MCP_LOG = join(RUN_DIR, "mcp.log");
process.on("exit", () => {
  try {
    rmSync(RUN_DIR, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
});
const evidence = { event: "agt038_probe_mcp", ok: false };
let exitCode = 1;

function logTail() {
  try {
    return redactCompactJwt(
      readFileSync(MCP_LOG, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-15)
        .join("\n")
        .replace(/Bearer\s+\S+/gi, "Bearer <redacted>"),
    );
  } catch {
    return null;
  }
}

/** Last transport observations, so a failure can name its cause. */
const httpTrace = [];
try {
  const config = loadGuanlanMcpConfig(process.env);
  const traceFetch = async (input, init) => {
    const startedAt = Date.now();
    try {
      const response = await fetch(input, init);
      httpTrace.push({ status: response.status, ms: Date.now() - startedAt });
      process.stderr.write(
        `${JSON.stringify({ ev: "mcp_http", url: String(input).slice(0, 120), status: response.status, ms: Date.now() - startedAt })}\n`,
      );
      return response;
    } catch (error) {
      const code = error?.cause?.code ?? error?.code ?? null;
      httpTrace.push({ status: null, code, message: String(error?.message ?? error).slice(0, 200), ms: Date.now() - startedAt });
      process.stderr.write(
        `${JSON.stringify({
          ev: "mcp_http_error",
          url: String(input).slice(0, 120),
          code,
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

  // Explicit comparator: the default sort is alphabetical, which is not the
  // ordering this evidence means (and Sonar S2871 flags it as a defect).
  const byName = (left, right) => left.localeCompare(right);
  evidence.tools = [...tools].sort(byName);
  evidence.expected = binding.config.tools.map((tool) => `mcp__guanlan__${tool}`).sort(byName);
  evidence.waitedMs = Date.now() - startedAt;
  evidence.credential = binding.credentials.describe();
  evidence.ok = evidence.expected.every((name) => evidence.tools.includes(name));
  evidence.diagnostic = {
    httpStatus: httpTrace.findLast((entry) => entry.status !== null)?.status ?? null,
    transportCode: httpTrace.findLast((entry) => entry.code)?.code ?? null,
    attempts: httpTrace.length,
    missing: evidence.expected.filter((name) => !evidence.tools.includes(name)),
  };
  evidence.mcpLogTail = logTail();
  exitCode = evidence.ok ? 0 : 1;
  evidence.exitCode = exitCode;
} catch (error) {
  const last = httpTrace.findLast((entry) => entry.status !== null);
  const lastTransport = httpTrace.findLast((entry) => entry.code);
  evidence.error = {
    code: error?.code ?? "error",
    message: String(error?.message ?? error).slice(0, 400),
    // 401/403 and a transport verdict are different diagnoses; name them so a
    // negative probe is actionable instead of a generic "no tools".
    diagnostic: {
      httpStatus: last?.status ?? null,
      transportCode: lastTransport?.code ?? null,
      attempts: httpTrace.length,
    },
  };
  evidence.mcpLogTail = logTail();
  exitCode = 1;
  evidence.exitCode = 1;
} finally {
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  process.exitCode = exitCode;
}
