/**
 * The AGT-027 adapter is the only place the research port meets the official
 * runtime. These tests pin the translation (no network, no credentials, no Pi
 * session): a fake AGT-027-shaped module proves the mapping and that research
 * configuration reaches the runtime intact.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgt027RuntimePort,
  mapAgentRuntimeRecord,
  researchSystemPromptExtension,
} from "../src/research/runtime/agt-027.mjs";
import {
  DEFAULT_RUNTIME_MODULE,
  loadAgentRuntimePort,
  resolveRuntimeModuleSpecifier,
} from "../src/research/port.mjs";

function fakeModule({ record, onCall } = {}) {
  return {
    loadConfig: (env) => ({ providerId: "fake", modelId: "fake-model", maxToolCalls: 8, runTimeoutMs: 1000, env }),
    async createAgentRuntime(options) {
      onCall?.(options);
      return {
        async run(prompt, runOptions) {
          onCall?.({ prompt, runOptions });
          return record ?? { status: "succeeded", text: "done", usage: { input: 1, output: 2, total: 3 }, model: { providerId: "fake", modelId: "fake-model" }, toolCalls: [], error: null };
        },
        dispose() {},
      };
    },
  };
}

const tool = (name) => ({ name, description: "x", parameters: {}, async execute() { return { content: [] }; } });

test("adapter passes tools, cwd, budget and system prompt to the official runtime", async () => {
  const calls = [];
  const port = createAgt027RuntimePort({ module: fakeModule({ onCall: (c) => calls.push(c) }), env: { A: "b" } });
  const result = await port.runAgent({
    systemPrompt: "RESEARCH POLICY",
    prompt: "研究主题",
    customTools: [tool("research_web_search"), tool("research_read_page")],
    limits: { maxTurns: 10, timeoutMs: 5000, maxToolCalls: 20 },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 2, totalTokens: 3, modelId: "fake-model", providerId: "fake", source: "provider" });
  const create = calls[0];
  assert.deepEqual(create.allowedTools, ["research_web_search", "research_read_page"]);
  assert.deepEqual(create.exposedTools, ["research_web_search", "research_read_page"]);
  assert.equal(create.config.maxToolCalls, 20, "research budget must override the runtime default of 8");
  assert.equal(create.extensionFactories.length, 1);
  assert.notEqual(create.cwd, process.cwd(), "research must not load the repository AGENTS.md");
  const run = calls[1];
  assert.equal(run.prompt, "研究主题");
  assert.equal(run.runOptions.timeoutMs, 5000);
});

test("adapter maps every runtime status and honest usage", async () => {
  const cases = [
    ["failed", "failed"],
    ["timeout", "timeout"],
    ["cancelled", "cancelled"],
    ["succeeded", "completed"],
  ];
  for (const [runtimeStatus, expected] of cases) {
    const port = createAgt027RuntimePort({
      module: fakeModule({ record: { status: runtimeStatus, text: "", usage: {}, model: {}, toolCalls: [], error: runtimeStatus === "failed" ? { code: "auth_error", message: "bad key" } : null } }),
    });
    const result = await port.runAgent({ prompt: "p", customTools: [], limits: {} });
    assert.equal(result.status, expected);
    assert.equal(result.usage.source, "provider");
    if (expected === "failed") assert.deepEqual(result.error, { code: "auth_error", message: "bad key" });
    else assert.equal(result.error, null);
  }
});

test("mapAgentRuntimeRecord keeps tool-call status without arguments or content", () => {
  const mapped = mapAgentRuntimeRecord({
    status: "succeeded",
    text: "t",
    usage: { input: 0, output: 0, total: 0 },
    model: { providerId: "p", modelId: "m" },
    toolCalls: [
      { name: "research_read_page", toolCallId: "c1", status: "ok", durationMs: 7 },
      { name: "research_web_search", toolCallId: "c2", status: "error", durationMs: 3, reason: "blocked" },
    ],
  });
  assert.deepEqual(mapped.toolCalls, [
    { callId: "c1", name: "research_read_page", status: "ok", durationMs: 7, isError: false },
    { callId: "c2", name: "research_web_search", status: "error", durationMs: 3, isError: true },
  ]);
});

test("a Pi permission denial is never translated into a successful tool call", () => {
  const mapped = mapAgentRuntimeRecord({
    status: "succeeded",
    toolCalls: [{ name: "research_read_page", toolCallId: "denied", status: "blocked", reason: "tool_not_granted" }],
  });
  assert.deepEqual(mapped.toolCalls, [
    { callId: "denied", name: "research_read_page", status: "blocked", durationMs: null, isError: true },
  ]);
});

test("system-prompt extension prepends the research policy to the runtime prompt", async () => {
  const factory = researchSystemPromptExtension("RESEARCH POLICY");
  const handlers = [];
  factory({ on: (event, handler) => handlers.push({ event, handler }) });
  assert.equal(handlers[0].event, "before_agent_start");
  const out = await handlers[0].handler({ systemPrompt: "BASE PROMPT" });
  assert.equal(out.systemPrompt, "RESEARCH POLICY\n\nBASE PROMPT");
});

test("loadAgentRuntimePort adapts an AGT-027 module that only exports createAgentRuntime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agt027-fake-"));
  const file = join(dir, "index.mjs");
  writeFileSync(
    file,
    `export function loadConfig() { return { maxToolCalls: 8 }; }
export async function createAgentRuntime() {
  return { async run() { return { status: "succeeded", text: "ok", usage: { input: 1, output: 1, total: 2 }, model: {}, toolCalls: [] }; }, dispose() {} };
}`,
  );
  try {
    const port = await loadAgentRuntimePort({ moduleSpecifier: pathToFileURL(file).href });
    assert.equal(port.portVersion, 1);
    const result = await port.runAgent({ prompt: "p", customTools: [], limits: { maxToolCalls: 5 } });
    assert.equal(result.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAgentRuntimePort still fails closed without a module", async () => {
  await assert.rejects(() => loadAgentRuntimePort({ moduleSpecifier: null }), /not configured/);
});

test("resolveRuntimeModuleSpecifier prefers an explicit module", () => {
  assert.equal(
    resolveRuntimeModuleSpecifier("./my-runtime.mjs", DEFAULT_RUNTIME_MODULE),
    "./my-runtime.mjs",
  );
  assert.equal(resolveRuntimeModuleSpecifier("  ", DEFAULT_RUNTIME_MODULE), null);
});

test("resolveRuntimeModuleSpecifier falls back only when the sibling exists", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agt028-fallback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modulePath = join(dir, "index.mjs");
  const missing = pathToFileURL(join(dir, "missing.mjs"));

  assert.equal(resolveRuntimeModuleSpecifier(null, missing), null);

  writeFileSync(modulePath, "export const createAgentRuntime = () => ({});\n");
  assert.equal(
    resolveRuntimeModuleSpecifier(null, pathToFileURL(modulePath)),
    pathToFileURL(modulePath).href,
  );
});

test("with no configured module the port loads the sibling src/index.mjs", async (t) => {
  // Simulates the post-merge layout (AGT-027's src/index.mjs beside src/research).
  const dir = mkdtempSync(join(tmpdir(), "agt028-sibling-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(new URL("../src/research", import.meta.url), join(dir, "src", "research"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "src", "index.mjs"),
    'export function createAgentRuntime() { return { async run() { return { status: "succeeded", text: "ok", usage: {}, toolCalls: [] }; }, dispose() {} }; }\n',
  );

  const copiedPort = await import(pathToFileURL(join(dir, "src", "research", "port.mjs")).href);
  const port = await copiedPort.loadAgentRuntimePort({});
  assert.equal(port.portVersion, 1);
  const result = await port.runAgent({ prompt: "p", customTools: [], limits: {} });
  assert.equal(result.status, "completed");
});
