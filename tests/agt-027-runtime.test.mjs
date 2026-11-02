/**
 * T2/T3: permission gate, tool budget, timeout, cancellation, error
 * classification and the restricted local tool.
 *
 * The model here is Pi's own `fauxProvider`, so the suite is deterministic and
 * free. The session, the extension pipeline, the tool registry, the permission
 * gate and this repository's runtime code are the real ones. `fauxProvider` is
 * never imported by `src/`.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  LOCAL_READ_TOOL_NAME,
  classifyError,
  createAgentRuntime,
  createLocalReadTool,
  loadConfig,
} from "../src/index.mjs";

const BASE_ENV = Object.freeze({
  CLOUD_PI_MODEL_BASE_URL: "https://faux.example.com/v1",
  CLOUD_PI_MODEL_API_KEY: "sk-test-0123456789abcdef",
  CLOUD_PI_MODEL_ID: "faux-model",
  CLOUD_PI_MODEL_PROVIDER_ID: "faux-test",
  CLOUD_PI_MODEL_CONTEXT_WINDOW: "8192",
  CLOUD_PI_MODEL_MAX_OUTPUT_TOKENS: "1024",
  CLOUD_PI_RUN_TIMEOUT_MS: "10000",
  CLOUD_PI_MAX_TOOL_CALLS: "2",
});

const cleanup = [];

after(() => {
  for (const dispose of cleanup) dispose();
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function spyTool(calls) {
  return {
    name: "spy_tool",
    label: "Spy",
    description: "Test-only tool that records execution.",
    parameters: Type.Object({ note: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      calls.push(params);
      return { content: [{ type: "text", text: "spy-executed" }], details: {} };
    },
  };
}

function slowTool() {
  return {
    name: "slow_tool",
    label: "Slow",
    description: "Test-only tool that waits until aborted.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      await new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(resolveWait, 5_000);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            rejectWait(new Error("slow_tool aborted"));
          },
          { once: true },
        );
      });
      return { content: [{ type: "text", text: "slow-done" }], details: {} };
    },
  };
}

async function makeRuntime({
  customTools = [],
  allowedTools = [],
  exposedTools,
  configOverrides = {},
  agentDir,
} = {}) {
  const dir = tempDir("agt027-session-");
  const faux = fauxProvider({ provider: "faux-test", models: [{ id: "faux-model", name: "Faux model" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = loadConfig({ ...BASE_ENV, ...configOverrides });
  const runtime = await createAgentRuntime({
    config,
    modelRuntime,
    model: faux.getModel(),
    customTools,
    allowedTools,
    exposedTools,
    agentDir,
  });
  cleanup.push(() => runtime.dispose());
  return { faux, runtime, config };
}

describe("AGT-027 T3: a granted tool executes through the real Pi pipeline", () => {
  test("local_read_text runs, returns file content and is recorded with usage", async () => {
    const notes = tempDir("agt027-notes-");
    writeFileSync(join(notes, "note.md"), "# note\nhello from note\n", "utf8");
    const { faux, runtime } = await makeRuntime({
      customTools: [createLocalReadTool({ root: notes })],
      allowedTools: [LOCAL_READ_TOOL_NAME],
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(LOCAL_READ_TOOL_NAME, { path: "note.md" }, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("The note says hello from note."),
    ]);

    const record = await runtime.run("Read note.md and summarize it.");
    assert.equal(record.status, "succeeded");
    assert.equal(record.stopReason, "stop");
    assert.equal(record.toolCalls.length, 1);
    assert.equal(record.toolCalls[0].name, LOCAL_READ_TOOL_NAME);
    assert.equal(record.toolCalls[0].status, "ok");
    assert.equal(record.toolCalls[0].reason, undefined);
    assert.match(record.toolCalls[0].resultPreview, /hello from note/);
    assert.match(record.text, /hello from note/);
    assert.equal(typeof record.runId, "string");
    assert.ok(record.durationMs >= 0);
    assert.deepEqual(Object.keys(record.usage).sort(), [
      "cacheRead",
      "cacheWrite",
      "cost",
      "input",
      "output",
      "total",
    ]);
    assert.equal(record.model.modelId, "faux-model");
  });

  test("a tool visible to the model but not granted is blocked before execution", async () => {
    const calls = [];
    const { faux, runtime } = await makeRuntime({
      customTools: [spyTool(calls)],
      allowedTools: [],
      exposedTools: ["spy_tool"],
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("spy_tool", {}, { id: "call-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("I could not use that tool."),
    ]);

    const record = await runtime.run("Use spy_tool.");
    assert.equal(calls.length, 0, "a denied tool must not execute");
    assert.equal(record.toolCalls.length, 1);
    assert.equal(record.toolCalls[0].status, "blocked");
    assert.equal(record.toolCalls[0].reason, "tool_not_granted");
    assert.equal(record.status, "succeeded");
  });

  test("the per-run tool budget blocks further calls after the limit", async () => {
    const calls = [];
    const { faux, runtime } = await makeRuntime({
      customTools: [spyTool(calls)],
      allowedTools: ["spy_tool"],
      configOverrides: { CLOUD_PI_MAX_TOOL_CALLS: "1" },
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("spy_tool", { note: "one" }, { id: "call-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("spy_tool", { note: "two" }, { id: "call-2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("budget reached"),
    ]);

    const record = await runtime.run("Call spy_tool twice.");
    assert.equal(calls.length, 1, "only the first call may execute");
    assert.deepEqual(
      record.toolCalls.map((call) => [call.name, call.status, call.reason]),
      [
        ["spy_tool", "ok", undefined],
        ["spy_tool", "blocked", "tool_budget_exhausted"],
      ],
    );
  });
});

describe("AGT-027 T2: timeout, cancellation and failure classification", () => {
  test("a run timeout aborts the session and is reported as timeout", async () => {
    const { faux, runtime } = await makeRuntime({
      customTools: [slowTool()],
      allowedTools: ["slow_tool"],
      configOverrides: { CLOUD_PI_MAX_TOOL_CALLS: "1" },
    });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("slow_tool", {}, { id: "call-1" })], { stopReason: "toolUse" })]);

    const record = await runtime.run("Use slow_tool.", { timeoutMs: 200 });
    assert.equal(record.status, "timeout");
    assert.equal(record.error.code, "timeout");
    assert.ok(record.durationMs < 5_000, "abort must interrupt the run before the tool would finish");
  });

  test("caller cancellation aborts the session and is reported as cancelled", async () => {
    const { faux, runtime } = await makeRuntime({
      customTools: [slowTool()],
      allowedTools: ["slow_tool"],
      configOverrides: { CLOUD_PI_MAX_TOOL_CALLS: "1" },
    });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("slow_tool", {}, { id: "call-1" })], { stopReason: "toolUse" })]);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    const record = await runtime.run("Use slow_tool.", { signal: controller.signal });
    clearTimeout(timer);

    assert.equal(record.status, "cancelled");
    assert.equal(record.error.code, "cancelled");
    assert.ok(record.durationMs < 5_000);
  });

  test("a provider auth failure becomes a classified, redacted run failure", async () => {
    const { faux, runtime, config } = await makeRuntime();
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: `401 invalid api key: ${config.apiKey}`,
      }),
    ]);

    const record = await runtime.run("hello");
    assert.equal(record.status, "failed");
    assert.equal(record.error.code, "auth_error");
    assert.equal(record.error.message.includes(config.apiKey), false);
    assert.equal(JSON.stringify(record).includes(config.apiKey), false);
  });

  test("the message heuristics classify common gateway failures", () => {
    assert.equal(classifyError(new Error("400 bad request: max_tokens invalid")).code, "invalid_request");
    assert.equal(classifyError(new Error("insufficient balance")).code, "rate_limit");
    assert.equal(classifyError(new Error("getaddrinfo ENOTFOUND host"), { secrets: [] }).code, "network_error");
  });
});

describe("AGT-027 T2: restricted local read tool", () => {
  function expectError(result, pattern) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, pattern);
  }

  test("reads a text file and returns an integrity digest", async () => {
    const root = tempDir("agt027-tool-");
    writeFileSync(join(root, "ok.md"), "hello", "utf8");
    const tool = createLocalReadTool({ root });
    const result = await tool.execute("call", { path: "ok.md" });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, "hello");
    assert.equal(result.details.path, "ok.md");
    assert.match(result.details.sha256, /^[a-f0-9]{64}$/);
  });

  test("rejects traversal, absolute paths, unsupported types and missing files", async () => {
    const root = tempDir("agt027-tool-");
    writeFileSync(join(root, "ok.md"), "hello", "utf8");
    writeFileSync(join(root, "secret.env"), "TOKEN=1", "utf8");
    const outside = tempDir("agt027-outside-");
    writeFileSync(join(outside, "hidden.md"), "outside", "utf8");
    symlinkSync(join(outside, "hidden.md"), join(root, "link.md"));
    const tool = createLocalReadTool({ root });

    expectError(await tool.execute("call", { path: "../outside.md" }), /escapes the read-only root/);
    expectError(await tool.execute("call", { path: "/etc/passwd" }), /absolute paths are not allowed/);
    expectError(await tool.execute("call", { path: "secret.env" }), /unsupported file type/);
    expectError(await tool.execute("call", { path: "link.md" }), /escapes the read-only root/);
    expectError(await tool.execute("call", { path: "missing.md" }), /file not found/);
  });

  test("rejects files above the byte limit", async () => {
    const root = tempDir("agt027-tool-");
    writeFileSync(join(root, "big.md"), "x".repeat(200), "utf8");
    const tool = createLocalReadTool({ root, maxBytes: 100 });
    expectError(await tool.execute("call", { path: "big.md" }), /larger than 100 bytes/);
  });
});

describe("AGT-027 T1: production entry points never import the scripted provider", () => {
  test("src/ contains no faux provider import", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".mjs"))) {
      const source = readFileSync(new URL(file, dir), "utf8");
      assert.equal(source.includes("providers/faux"), false, `${file} must not import fauxProvider`);
      assert.equal(source.includes("p0-faux"), false, `${file} must not reference the P0 faux provider`);
    }
  });
});
