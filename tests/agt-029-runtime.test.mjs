/**
 * AGT-029 T3: Channel Adapter → real Cloud Pi `createAgentRuntime().run()`.
 *
 * The model is Pi's own deterministic `fauxProvider`; the session assembly,
 * extension pipeline, tool permission gate, AbortSignal propagation and error
 * classification are the production ones in `src/runtime.mjs`. No network.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentRuntime } from "../src/runtime.mjs";
import { loadConfig } from "../src/config.mjs";
import { createFeishuChannel } from "../src/channels/feishu/channel.mjs";
import { createFeishuAgentRunner, feishuChannelPromptExtension } from "../src/channels/feishu/runtime.mjs";
import { textEvent } from "./helpers/feishu-events.mjs";

const BASE_ENV = Object.freeze({
  CLOUD_PI_MODEL_BASE_URL: "https://faux.example.com/v1",
  CLOUD_PI_MODEL_API_KEY: "sk-test-0123456789abcdef",
  CLOUD_PI_MODEL_ID: "faux-feishu-model",
  CLOUD_PI_MODEL_PROVIDER_ID: "faux-feishu",
  CLOUD_PI_MODEL_CONTEXT_WINDOW: "8192",
  CLOUD_PI_MODEL_MAX_OUTPUT_TOKENS: "1024",
  CLOUD_PI_RUN_TIMEOUT_MS: "10000",
  CLOUD_PI_MAX_TOOL_CALLS: "2",
});

const cleanup = [];
after(() => {
  for (const dispose of cleanup.reverse()) {
    try {
      dispose();
    } catch {
      // best effort test cleanup
    }
  }
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function makeRuntime({ customTools = [], allowedTools = [], extensionFactories = [] } = {}) {
  const dir = tempDir("agt029-session-");
  const faux = fauxProvider({ provider: "faux-feishu", models: [{ id: "faux-feishu-model", name: "Faux Feishu" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = loadConfig(BASE_ENV);
  const runtime = await createAgentRuntime({
    config,
    modelRuntime,
    model: faux.getModel(),
    cwd: dir,
    customTools,
    allowedTools,
    exposedTools: allowedTools,
    extensionFactories: [feishuChannelPromptExtension(), ...extensionFactories],
  });
  cleanup.push(() => runtime.dispose());
  return { faux, runtime };
}

function harness(runtime) {
  const replies = [];
  const outcomes = [];
  const records = [];
  const channel = createFeishuChannel({
    allowedChatIds: [],
    botOpenId: "ou_bot_0001",
    runTurn: async (input) => {
      const record = await runtime.run(input.text, { signal: input.signal });
      records.push(record);
      return record;
    },
    reply: async (messageId, text) => {
      replies.push({ messageId, text });
      return { messageId: `om_reply_${replies.length}` };
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  cleanup.push(() => channel.dispose());
  return { channel, replies, outcomes, records };
}

describe("AGT-029 T3: real Cloud Pi runtime behind the channel", () => {
  test("a Feishu message runs a real Pi session and its answer is replied", async () => {
    const { faux, runtime } = await makeRuntime();
    faux.setResponses([fauxAssistantMessage("pong from the real session")]);
    const { channel, replies, outcomes, records } = harness(runtime);

    channel.handleEvent(textEvent({ text: "ping" }));
    await channel.whenIdle();

    assert.equal(records.length, 1);
    assert.equal(records[0].status, "succeeded");
    assert.equal(records[0].text, "pong from the real session");
    assert.equal(records[0].toolCalls.length, 0, "the Feishu run must expose no tools");
    assert.match(records[0].runId, /^[0-9a-f-]{36}$/);
    assert.equal(records[0].model.modelId, "faux-feishu-model");
    assert.deepEqual(replies, [{ messageId: "om_0000000000000001", text: "pong from the real session" }]);
    assert.equal(outcomes.find((outcome) => outcome.action === "replied").runId, records[0].runId);
  });

  test("the run record's AbortSignal reaches the real Pi session on /stop", { timeout: 15_000 }, async () => {
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    const slowTool = {
      name: "slow_tool",
      label: "Slow",
      description: "Test-only tool that waits until its AbortSignal fires.",
      parameters: Type.Object({}),
      execute(_id, _params, signal) {
        started();
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error("slow_tool aborted"));
          if (signal?.aborted) return onAbort();
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    };

    const { faux, runtime } = await makeRuntime({ customTools: [slowTool], allowedTools: ["slow_tool"] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("slow_tool", {}, { id: "call-slow" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("slow-done"),
    ]);
    const { channel, replies, outcomes, records } = harness(runtime);

    channel.handleEvent(textEvent({ messageId: "om_work", text: "run the slow tool" }));
    await startedPromise;

    channel.handleEvent(textEvent({ eventId: "evt_stop", messageId: "om_stop", text: "/stop" }));
    await channel.whenIdle();

    assert.equal(records.length, 1);
    assert.equal(records[0].status, "cancelled");
    assert.equal(records[0].error.code, "cancelled");
    assert.deepEqual(replies, [{ messageId: "om_stop", text: "已停止当前任务。" }]);
    assert.ok(outcomes.some((outcome) => outcome.action === "cancelled"));
  });

  test("a model error becomes a bounded Feishu error reply without leaking the key", async () => {
    const { faux, runtime } = await makeRuntime();
    const apiKey = BASE_ENV.CLOUD_PI_MODEL_API_KEY;
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: `401 invalid api key: ${apiKey}` }),
    ]);
    const { channel, replies, records } = harness(runtime);

    channel.handleEvent(textEvent({ text: "ping" }));
    await channel.whenIdle();

    assert.equal(records[0].status, "failed");
    assert.equal(records[0].error.code, "auth_error");
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /auth_error/);
    assert.equal(replies[0].text.includes(apiKey), false);
  });
});

describe("AGT-029 T3: the channel runner grants no tools", () => {
  test("incomplete model configuration is rejected at construction", () => {
    assert.throws(
      () => createFeishuAgentRunner({ env: {} }),
      (error) => error?.name === "ConfigError" && error.fields.includes("CLOUD_PI_MODEL_BASE_URL"),
    );
  });

  test("createFeishuAgentRunner assembles a tool-free runtime in a temp cwd", async () => {
    let captured;
    let disposed = false;
    const runner = createFeishuAgentRunner({
      config: loadConfig(BASE_ENV),
      createRuntime: async (options) => {
        captured = options;
        return {
          async run() {
            return { status: "succeeded", text: "ok", runId: "run-fake" };
          },
          dispose() {
            disposed = true;
          },
        };
      },
    });
    cleanup.push(() => runner.dispose());

    const record = await runner.runTurn({ text: "hello" });
    assert.equal(record.runId, "run-fake");
    assert.deepEqual(captured.allowedTools, []);
    assert.deepEqual(captured.exposedTools, []);
    assert.deepEqual(captured.customTools, []);
    assert.equal(captured.extensionFactories.length, 1);
    assert.match(captured.cwd, /cloud-pi-feishu-/);
    assert.equal(captured.cwd.includes(process.cwd()), false);

    await runner.dispose();
    assert.equal(disposed, true);
  });
});
