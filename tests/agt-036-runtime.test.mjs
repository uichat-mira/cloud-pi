import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WECOM_CHANNEL_SYSTEM_PROMPT, createWecomAgentRunner } from "../src/channels/wecom/runtime.mjs";

function fakeRuntime(overrides = {}) {
  const calls = [];
  return {
    calls,
    runtime: {
      run: async (text, { signal } = {}) => {
        calls.push({ text, signal });
        return { status: "succeeded", text: `echo:${text}`, durationMs: 1 };
      },
      dispose: () => {
        calls.push({ disposed: true });
      },
      ...overrides,
    },
  };
}

test("runner: builds the one runtime with no tools and the channel prompt", async () => {
  let received;
  const { runtime } = fakeRuntime();
  const dir = mkdtempSync(join(tmpdir(), "wecom-runner-"));
  const runner = createWecomAgentRunner({
    config: { fake: true },
    cwd: dir,
    createRuntime: (options) => {
      received = options;
      return runtime;
    },
  });

  const record = await runner.runTurn({ text: "你好" });
  assert.equal(record.text, "echo:你好");
  assert.deepEqual(received.allowedTools, []);
  assert.deepEqual(received.exposedTools, []);
  assert.deepEqual(received.customTools, []);
  assert.equal(received.cwd, dir);
  assert.equal(received.extensionFactories.length, 1);
  const extension = received.extensionFactories[0];
  const handlers = new Map();
  extension({ on: (name, handler) => handlers.set(name, handler) });
  const patched = await handlers.get("before_agent_start")({ systemPrompt: "runtime prompt" });
  assert.ok(patched.systemPrompt.startsWith(WECOM_CHANNEL_SYSTEM_PROMPT));
  assert.ok(patched.systemPrompt.endsWith("runtime prompt"));

  await runner.dispose();
});

test("runner: turns are serialized even when the caller starts them together", async () => {
  const order = [];
  const { runtime } = fakeRuntime({
    run: async (text) => {
      order.push(`start:${text}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${text}`);
      return { status: "succeeded", text };
    },
  });
  const runner = createWecomAgentRunner({ config: { fake: true }, cwd: tmpdir(), createRuntime: () => runtime });

  await Promise.all([runner.runTurn({ text: "a" }), runner.runTurn({ text: "b" })]);
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"]);

  await runner.dispose();
});

test("runner: a turn aborted before its slot starts never reaches the model", async () => {
  const { runtime, calls } = fakeRuntime();
  const runner = createWecomAgentRunner({ config: { fake: true }, cwd: tmpdir(), createRuntime: () => runtime });

  const controller = new AbortController();
  controller.abort();
  const record = await runner.runTurn({ text: "ignored", signal: controller.signal });
  assert.equal(record.status, "cancelled");
  assert.deepEqual(calls, []);

  await runner.dispose();
});

test("runner: a failed turn does not poison the queue and dispose is idempotent", async () => {
  let attempts = 0;
  const { runtime } = fakeRuntime({
    run: async (text) => {
      attempts += 1;
      if (text === "boom") throw new Error("provider down");
      return { status: "succeeded", text };
    },
  });
  const runner = createWecomAgentRunner({ config: { fake: true }, cwd: tmpdir(), createRuntime: () => runtime });

  await assert.rejects(() => runner.runTurn({ text: "boom" }));
  const ok = await runner.runTurn({ text: "after" });
  assert.equal(ok.text, "after");
  assert.equal(attempts, 2);

  await runner.dispose();
  await runner.dispose();
  await assert.rejects(() => runner.runTurn({ text: "late" }), /disposed/);

  // A private workdir is owned by the runner and removed on dispose.
  const dir = mkdtempSync(join(tmpdir(), "wecom-runner-own-"));
  const owned = createWecomAgentRunner({ config: { fake: true }, cwd: dir, createRuntime: () => fakeRuntime().runtime });
  await owned.dispose();
  assert.doesNotThrow(() => rmSync(dir, { recursive: true, force: true }));
});
