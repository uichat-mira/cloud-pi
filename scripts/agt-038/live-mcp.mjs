#!/usr/bin/env node
/**
 * AGT-038 live evidence: a real agent run against the real Guanlan MCP server.
 *
 * The MCP side is real: Pi's built-in MCP extension connects to the deployed
 * Guanlan endpoint over the SDK's streamable-HTTP transport and the tools come
 * from a real `tools/list`. The model side is the configured provider, so the
 * tool choice is the model's, not a script's.
 *
 * Modes:
 *   happy            — one run that must call whoami then news_recent
 *   expired          — a locally expired credential: the run must fail closed
 *   wrong-audience   — a credential really issued by Cloud Auth for another service
 *
 * Usage:
 *   node --env-file=D:\cloud-pi\.env scripts/agt-038/live-mcp.mjs --mode=happy
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createAgentRuntime } from "../../src/runtime.mjs";
import { generateRunId } from "../../src/research/execute.mjs";
import { createGuanlanMcpBinding, loadGuanlanMcpConfig } from "../../src/mcp/guanlan.mjs";

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split("=");
      return [key, rest.join("=") || "true"];
    }),
);
const mode = args.get("mode") ?? "happy";
const TMP = `${process.env.TEMP}\\gln013-t23`;
const MCP_LOG = `${TMP}\\t9-mcp.log`;

const logLines = [];
const log = (entry) => {
  logLines.push(entry);
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
};

const PROMPT = [
  "You are Mira Cloud Agent. Do exactly two things in order, then answer in Chinese:",
  "1. Call the tool guanlan_whoami.",
  "2. Call the tool guanlan_news_recent with parameter limit=2.",
  "In the answer give: (a) the service identity and scope from whoami; (b) title and id of the two most recent news items.",
  "Use only data the tools returned. If a tool fails, report its error code/message verbatim; do not invent data and do not try another tool to work around it.",
].join("\n");

const evidence = { event: "agt038_live_mcp", mode, ok: false };
let exitCode = 1;

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A locally minted, already expired JWT: the binding must refuse it before any request. */
function expiredTokenFile(path) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "t9-local-expired", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(
    JSON.stringify({
      iss: "mira:cloud-auth",
      sub: "svc:t9-local",
      aud: "mira:cloud-guanlan",
      scope: ["guanlan.read"],
      iat: now - 600,
      exp: now - 300,
    }),
  ).toString("base64url");
  writeFileSync(path, `${header}.${claims}.not-a-real-signature`, { mode: 0o600 });
  return path;
}

/** Keep evidence free of credentials and of raw account/consumer identifiers. */
function sanitize(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g, "<redacted-jwt>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
}

/** A forged JWT: right claims, signature nothing Cloud Auth ever produced. */
function forgedTokenFile(path) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "gln013-t23-1", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(
    JSON.stringify({
      iss: "mira:cloud-auth",
      sub: "svc:t9-forged",
      aud: "mira:cloud-guanlan",
      scope: ["guanlan.read"],
      iat: now,
      exp: now + 300,
    }),
  ).toString("base64url");
  writeFileSync(path, `${header}.${claims}.Zm9yZ2VkLXNpZ25hdHVyZQ`, { mode: 0o600 });
  return path;
}

/** Keep only non-secret lines from the MCP server log. */
function sanitizeLogTail() {
  const text = readFileSafe(MCP_LOG);
  if (!text) return null;
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-12)
    .join("\n")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g, "<redacted-jwt>");
}

try {
  const env = { ...process.env };
  if (mode === "expired") {
    env.GUANLAN_MCP_TOKEN_FILE = expiredTokenFile(`${TMP}\\t9-expired.txt`);
    delete env.GUANLAN_MCP_TOKEN;
  }
  if (mode === "forged") {
    // Correct aud/exp/scope but not signed by Cloud Auth: the client cannot tell,
    // the server must. Proves a real 401 does not become a plausible answer.
    env.GUANLAN_MCP_TOKEN_FILE = forgedTokenFile(`${TMP}\\t9-forged.txt`);
    delete env.GUANLAN_MCP_TOKEN;
  }
  if (mode === "audience-mismatch") {
    // A real Guanlan token, but this binding is told to require another audience.
    // The client must refuse rather than send a credential for the wrong service.
    env.GUANLAN_MCP_AUDIENCE = "mira:cloud-shiyan";
  }
  if (mode === "wrong-audience") {
    // Really issued by Cloud Auth, but for another audience/service.
    const issued = readFileSafe(`${TMP}\\t9-wrong-audience.txt`);
    if (!issued) throw new Error("t9-wrong-audience.txt is missing; mint one with --audience=mira:shiyan");
    env.GUANLAN_MCP_TOKEN_FILE = `${TMP}\\t9-wrong-audience.txt`;
    delete env.GUANLAN_MCP_TOKEN;
  }

  const config = loadGuanlanMcpConfig(env, { fileExists: (p) => readFileSafe(p) !== null });
  const binding = createGuanlanMcpBinding({ env, config, log, logPath: MCP_LOG });

  // Fail before the model is called when the credential cannot be used: the MCP
  // connection is lazy, so a bad token would otherwise only mean "no tools".
  evidence.preflight = binding.assertReady();
  evidence.credential = binding.credentials.describe();

  const runtime = await createAgentRuntime({
    env,
    generateRunId,
    allowedTools: binding.allowedTools,
    exposedTools: binding.exposedTools,
    extensionFactories: binding.extensionFactories,
  });

  let record;
  try {
    record = await runtime.run(PROMPT, { timeoutMs: 180_000 });
  } finally {
    runtime.dispose();
  }

  evidence.run = {
    runId: record.runId,
    status: record.status,
    durationMs: record.durationMs,
    usage: { input: record.usage?.input, output: record.usage?.output },
    // The quadruple the card asks for: tool → argument summary → result summary → duration.
    toolCalls: (record.toolCalls ?? []).map((call) => ({
      name: call.name,
      status: call.status,
      reason: call.reason ?? null,
      inputSummary: sanitize(call.inputSummary ?? ""),
      resultSummary: sanitize(call.resultPreview ?? "").slice(0, 200),
      durationMs: call.durationMs ?? null,
    })),
    error: record.error ?? null,
    textChars: typeof record.text === "string" ? record.text.length : 0,
    text: sanitize(record.text ?? "").slice(0, 600),
  };
  evidence.credential = binding.credentials.describe();
  evidence.health = binding.health();
  evidence.tools = binding.config.tools;
  evidence.url = binding.config.url;
  evidence.credentialLog = logLines.filter((line) => line.event === "guanlan_mcp_credential");

  const names = evidence.run.toolCalls.map((call) => call.name);
  const allOk = evidence.run.toolCalls.length > 0 && evidence.run.toolCalls.every((call) => call.status === "ok");

  if (mode === "happy") {
    const finished = record.status === "succeeded" || record.status === "completed";
    evidence.ok =
      finished &&
      names.includes("mcp__guanlan__guanlan_whoami") &&
      names.includes("mcp__guanlan__guanlan_news_recent") &&
      allOk &&
      evidence.health.ok === true;
    exitCode = evidence.ok ? 0 : 1;
  } else {
    // A failing mode passes only when nothing pretended to succeed.
    const noSuccess = !evidence.run.toolCalls.some((call) => call.status === "ok");
    const runFailed = !["succeeded", "completed"].includes(record.status);
    // Mirrors the product rule: Guanlan enabled, no successful MCP call and a
    // failing transport verdict means the run must fail, not answer.
    if (!noSuccess) {
      evidence.ok = false;
    } else if (runFailed) {
      evidence.ok = !evidence.health.ok;
    } else {
      evidence.failedClosedByRule = evidence.health.ok ? null : "mcp_server_unavailable";
      evidence.ok = evidence.health.ok === false;
    }
    exitCode = evidence.ok ? 0 : 1;
  }
  evidence.exitCode = exitCode;
} catch (error) {
  evidence.error = { code: error?.code ?? "error", message: String(error?.message ?? error).slice(0, 400) };
  // A config or credential rejection before the run is the expected fail-closed shape.
  evidence.ok =
    mode !== "happy" && ["mcp_credential_unavailable", "guanlan_mcp_config_error"].includes(evidence.error.code);
  exitCode = evidence.ok ? 0 : 1;
  evidence.exitCode = exitCode;
} finally {
  evidence.mcpLogTail = sanitizeLogTail();
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  process.exitCode = exitCode;
}
