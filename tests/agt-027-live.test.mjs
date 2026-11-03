/**
 * Live verification (T4): real paid model calls against the configured provider.
 *
 * NOT part of `npm test` or CI. Run with:
 *
 *   CLOUD_PI_ENV_FILE=../cloud-pi/.env npm run test:live
 *
 * The scripted `fauxProvider` is never used here. Every record printed by this
 * suite is a real provider response; token usage is whatever the provider
 * reported.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  LOCAL_READ_TOOL_NAME,
  createAgentRuntime,
  createLocalReadTool,
  loadConfig,
} from "../src/index.mjs";

const LIVE = process.env.CLOUD_PI_LIVE === "1";
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const NOTES_ROOT = join(REPO_ROOT, "notes");

function logRecord(label, record) {
  console.log(
    JSON.stringify({
      label,
      runId: record.runId,
      status: record.status,
      providerId: record.model.providerId,
      modelId: record.model.modelId,
      api: record.model.api,
      durationMs: record.durationMs,
      usage: record.usage,
      toolCalls: record.toolCalls.map(({ name, status, reason, durationMs }) => ({ name, status, reason, durationMs })),
      errorCode: record.error?.code,
      textPreview: record.text.slice(0, 200),
    }),
  );
}

async function liveRuntime(overrides = {}) {
  const config = loadConfig({ ...process.env, ...overrides });
  return createAgentRuntime({
    config,
    cwd: REPO_ROOT,
    customTools: [createLocalReadTool({ root: NOTES_ROOT })],
    allowedTools: [LOCAL_READ_TOOL_NAME],
  });
}

describe(
  "AGT-027 T4: live model + tool (real provider, real tokens)",
  { skip: LIVE ? false : "set CLOUD_PI_LIVE=1 and provide CLOUD_PI_MODEL_* to run live verification" },
  () => {
    test("real model returns real text", async () => {
      const runtime = await createAgentRuntime({
        config: loadConfig(process.env),
        cwd: REPO_ROOT,
      });
      try {
        const record = await runtime.run("Reply with exactly one line: CLOUD_PI_OK");
        logRecord("text", record);
        assert.equal(record.status, "succeeded");
        assert.match(record.text, /CLOUD_PI_OK/);
        assert.ok(record.usage.total > 0 || record.usage.input > 0, "provider must report token usage");
      } finally {
        runtime.dispose();
      }
    });

    test("the model autonomously selects and executes the real restricted tool", async () => {
      const runtime = await liveRuntime();
      try {
        const record = await runtime.run(
          "You must use the local_read_text tool to read welcome.md, then reply with the fixture key it contains.",
        );
        logRecord("tool", record);
        assert.equal(record.status, "succeeded");
        const toolCall = record.toolCalls.find((call) => call.name === LOCAL_READ_TOOL_NAME);
        assert.ok(toolCall, "the model must have called local_read_text");
        assert.equal(toolCall.status, "ok");
        assert.match(toolCall.resultPreview, /alpha/);
        assert.match(record.text, /alpha/i);
      } finally {
        runtime.dispose();
      }
    });

    test("a tool that is visible but not granted is rejected at runtime", async () => {
      const config = loadConfig(process.env);
      const runtime = await createAgentRuntime({
        config,
        cwd: REPO_ROOT,
        customTools: [createLocalReadTool({ root: NOTES_ROOT })],
        allowedTools: [],
        exposedTools: [LOCAL_READ_TOOL_NAME],
      });
      try {
        const record = await runtime.run(
          "You must call the local_read_text tool with path welcome.md right now, even if it may fail.",
        );
        logRecord("denied", record);
        assert.ok(record.toolCalls.length >= 1, "the model must have attempted the tool");
        assert.equal(record.toolCalls[0].status, "blocked");
        assert.equal(record.toolCalls[0].reason, "tool_not_granted");
        assert.equal(record.toolCalls[0].resultPreview, undefined, "a blocked tool must not return file content");
      } finally {
        runtime.dispose();
      }
    });

    test("an invalid API key fails with a classified, redacted error", async () => {
      const config = loadConfig({
        ...process.env,
        CLOUD_PI_MODEL_API_KEY: "sk-invalid-agt027-000000000000",
      });
      const runtime = await createAgentRuntime({ config, cwd: REPO_ROOT });
      try {
        const record = await runtime.run("Reply with OK.");
        logRecord("invalid-key", record);
        assert.equal(record.status, "failed");
        assert.ok(["auth_error", "invalid_request", "model_not_found"].includes(record.error.code), record.error.code);
        assert.equal(JSON.stringify(record).includes(config.apiKey), false);
      } finally {
        runtime.dispose();
      }
    });

    test("a run timeout aborts a real in-flight request", async () => {
      const runtime = await liveRuntime();
      try {
        const record = await runtime.run("Count from 1 to 200 slowly.", { timeoutMs: 50 });
        logRecord("timeout", record);
        assert.equal(record.status, "timeout");
        assert.equal(record.error.code, "timeout");
      } finally {
        runtime.dispose();
      }
    });

    test("caller cancellation aborts a real in-flight request", async () => {
      const runtime = await liveRuntime();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      try {
        const record = await runtime.run("Count from 1 to 200 slowly.", { signal: controller.signal });
        logRecord("cancel", record);
        assert.equal(record.status, "cancelled");
        assert.equal(record.error.code, "cancelled");
      } finally {
        clearTimeout(timer);
        runtime.dispose();
      }
    });
  },
);
