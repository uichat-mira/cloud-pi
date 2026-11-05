/**
 * AGT-032 T2: Feishu research runner boundary.
 *
 * The runner is the only place that knows about AGT-028. These tests inject the
 * executor entry (`startResearchFn`) and the run reader so the call boundary,
 * AbortSignal propagation and cross-chat concurrency cap are directly
 * observable; the un-mocked executor path is covered in agt-032-live-path.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createFeishuResearchRunner } from "../src/channels/feishu/runtime.mjs";
import { RUNTIME_PORT_VERSION } from "../src/research/port.mjs";
import { REPORT_TEXT } from "./agt-032-fixtures.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeResearch({ onCall } = {}) {
  const calls = [];
  async function startResearchFn(request, deps) {
    const index = calls.length + 1;
    calls.push({ request, deps });
    const runId = `r-20260101T00000${index % 10}-abcdef`;
    const done = onCall
      ? onCall({ request, deps, runId, index })
      : Promise.resolve({ status: "completed", runId, durationMs: 5, errors: [] });
    return { runId, done };
  }
  return { startResearchFn, calls };
}

function fakeReadRun({ report = REPORT_TEXT, sources = [{ id: "S1" }], throws = false } = {}) {
  const calls = [];
  async function readRunFn(runId, options) {
    calls.push({ runId, options });
    if (throws) throw new Error("run store unavailable");
    return { run: { runId }, report, sources };
  }
  return { readRunFn, calls };
}

function port() {
  return { portVersion: RUNTIME_PORT_VERSION, async runAgent() { throw new Error("must not run a model"); } };
}

function baseOptions(overrides = {}) {
  return {
    env: {},
    researchDeps: { runtimePort: port(), toolLayer: { tools: [] } },
    loadPort: async () => port(),
    ...overrides,
  };
}

describe("AGT-032 T2: startResearch call boundary", () => {
  test("one command calls startResearch once with only the topic and public research deps", async () => {
    const { startResearchFn, calls } = fakeResearch();
    const { readRunFn } = fakeReadRun();
    const runner = createFeishuResearchRunner({
      ...baseOptions(),
      startResearchFn,
      readRunFn,
    });

    const result = await runner.runResearch({ topic: "  AI Agent 工程进展  ", chatId: "oc_x", messageId: "om_x" });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].request, { topic: "AI Agent 工程进展" });
    const deps = calls[0].deps;
    assert.equal(deps.runtimePort.portVersion, RUNTIME_PORT_VERSION);
    assert.ok(deps.signal instanceof AbortSignal);
    for (const forbidden of ["allowedTools", "exposedTools", "customTools", "mcp", "account", "cloudAuth"]) {
      assert.equal(forbidden in deps, false, `research deps must not expose ${forbidden}`);
    }
    assert.equal(result.status, "completed");
    assert.equal(result.runId, "r-20260101T000001-abcdef");
    assert.equal(result.report, REPORT_TEXT);
    assert.equal(result.sources, 1);
  });

  test("the report is read back through the public run reader with the same root/env", async () => {
    const { startResearchFn, calls } = fakeResearch();
    const { readRunFn, calls: readCalls } = fakeReadRun();
    const runner = createFeishuResearchRunner({
      ...baseOptions({ researchDeps: { runtimePort: port(), toolLayer: { tools: [] }, rootDir: "/tmp/agt-032-runs" } }),
      startResearchFn,
      readRunFn,
    });
    await runner.runResearch({ topic: "AI" });
    assert.equal(calls[0].deps.rootDir, "/tmp/agt-032-runs");
    assert.equal(readCalls.length, 1);
    assert.equal(readCalls[0].runId, "r-20260101T000001-abcdef");
    assert.equal(readCalls[0].options.rootDir, "/tmp/agt-032-runs");
  });

  test("a missing runtime port fails closed without starting any run", async () => {
    const { startResearchFn, calls } = fakeResearch();
    const runner = createFeishuResearchRunner({
      ...baseOptions({
        researchDeps: { toolLayer: { tools: [] } },
        loadPort: async () => {
          throw Object.assign(new Error("no AGT-027 runtime"), { code: "runtime_unavailable" });
        },
      }),
      startResearchFn,
      readRunFn: fakeReadRun().readRunFn,
    });
    const result = await runner.runResearch({ topic: "AI" });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "runtime_unavailable");
    assert.equal(calls.length, 0);
  });

  test("public chat research cannot inherit Guanlan owner credentials", async () => {
    const { startResearchFn, calls } = fakeResearch();
    let portLoads = 0;
    const runner = createFeishuResearchRunner({
      ...baseOptions({
        env: {
          GUANLAN_MCP_URL: "https://private.example.invalid/mcp",
          GUANLAN_MCP_TOKEN: "owner-secret-not-for-chat",
        },
        loadPort: async () => {
          portLoads += 1;
          return port();
        },
      }),
      startResearchFn,
      readRunFn: fakeReadRun().readRunFn,
    });
    const result = await runner.runResearch({ topic: "owner private news" });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "runtime_unavailable");
    assert.equal(calls.length, 0);
    assert.equal(portLoads, 0);
  });

  test("an empty topic never reaches startResearch", async () => {
    const { startResearchFn, calls } = fakeResearch();
    const runner = createFeishuResearchRunner({ ...baseOptions(), startResearchFn, readRunFn: fakeReadRun().readRunFn });
    const result = await runner.runResearch({ topic: "   " });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "invalid_request");
    assert.equal(calls.length, 0);
  });

  test("an executor validation error becomes a classified failure, not a crash", async () => {
    const runner = createFeishuResearchRunner({
      ...baseOptions(),
      startResearchFn: async () => {
        throw Object.assign(new Error("unsupported timeRange"), { code: "invalid_request" });
      },
      readRunFn: fakeReadRun().readRunFn,
    });
    const result = await runner.runResearch({ topic: "AI" });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "invalid_request");
    assert.equal(result.runId, null);
  });

  test("the runtime port is loaded lazily once across runs", async () => {
    let loads = 0;
    const { startResearchFn } = fakeResearch();
    const runner = createFeishuResearchRunner({
      ...baseOptions({
        researchDeps: { toolLayer: { tools: [] } },
        loadPort: async () => {
          loads += 1;
          return port();
        },
      }),
      startResearchFn,
      readRunFn: fakeReadRun().readRunFn,
    });
    await runner.runResearch({ topic: "one" });
    await runner.runResearch({ topic: "two" });
    assert.equal(loads, 1);
  });
});

describe("AGT-032 T2: AbortSignal propagation", () => {
  test("an already-aborted signal never starts a run", async () => {
    const { startResearchFn, calls } = fakeResearch();
    const runner = createFeishuResearchRunner({ ...baseOptions(), startResearchFn, readRunFn: fakeReadRun().readRunFn });
    const controller = new AbortController();
    controller.abort();
    const result = await runner.runResearch({ topic: "AI", signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(calls.length, 0);
  });

  test("the caller signal reaches the executor and a cancelled run keeps its real status", async () => {
    const { startResearchFn, calls } = fakeResearch({
      onCall: ({ deps, runId }) =>
        new Promise((resolve) => {
          const finish = () => resolve({ status: "cancelled", runId, durationMs: 3, errors: [{ code: "aborted" }] });
          if (deps.signal.aborted) finish();
          else deps.signal.addEventListener("abort", finish, { once: true });
        }),
    });
    const runner = createFeishuResearchRunner({ ...baseOptions(), startResearchFn, readRunFn: fakeReadRun().readRunFn });
    const controller = new AbortController();
    const running = runner.runResearch({ topic: "AI", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls[0].deps.signal.aborted, false);
    controller.abort();
    const result = await running;
    assert.equal(result.status, "cancelled");
    assert.equal(result.runId, "r-20260101T000001-abcdef");
    assert.equal(result.error.code, "aborted");
    assert.equal(runner.activeRunCount, 0);
  });

  test("a report read failure does not turn a completed run into a failure", async () => {
    const { startResearchFn } = fakeResearch();
    const runner = createFeishuResearchRunner({
      ...baseOptions(),
      startResearchFn,
      readRunFn: async () => {
        throw new Error("report is corrupt");
      },
    });
    const result = await runner.runResearch({ topic: "AI" });
    assert.equal(result.status, "completed");
    assert.equal(result.report, null);
    assert.equal(result.reportUnavailable, true);
  });
});

describe("AGT-032 T2: cross-chat concurrency cap", () => {
  function gatedResearch() {
    let active = 0;
    let maxActive = 0;
    const gates = [];
    const calls = [];
    const startResearchFn = async (request) => {
      calls.push(request);
      const gate = deferred();
      gates.push(gate);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const index = calls.length;
      const runId = `r-20260101T00000${index}-abcdef`;
      const done = (async () => {
        try {
          await gate.promise;
          return { status: "completed", runId, durationMs: 1, errors: [] };
        } finally {
          active -= 1;
        }
      })();
      return { runId, done };
    };
    return { startResearchFn, gates, calls, maxActive: () => maxActive };
  }

  test("default cap serializes research across chats", async () => {
    const gated = gatedResearch();
    const runner = createFeishuResearchRunner({
      ...baseOptions(),
      startResearchFn: gated.startResearchFn,
      readRunFn: fakeReadRun().readRunFn,
    });
    assert.equal(runner.maxConcurrent, 1);

    const first = runner.runResearch({ topic: "first" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = runner.runResearch({ topic: "second" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(gated.calls.length, 1, "the second chat waits for its slot");
    gated.gates[0].resolve();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gated.calls.length, 2);
    gated.gates[1].resolve();
    await second;
    assert.equal(gated.maxActive(), 1);
    assert.equal(runner.activeRunCount, 0);
  });

  test("a run aborted while waiting for a slot never starts", async () => {
    const gated = gatedResearch();
    const runner = createFeishuResearchRunner({
      ...baseOptions(),
      startResearchFn: gated.startResearchFn,
      readRunFn: fakeReadRun().readRunFn,
    });

    const first = runner.runResearch({ topic: "first" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const controller = new AbortController();
    const second = runner.runResearch({ topic: "second", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));

    controller.abort();
    const cancelled = await second;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(gated.calls.length, 1, "the aborted waiter must not start");

    gated.gates[0].resolve();
    await first;
    assert.equal(gated.calls.length, 1);
    assert.equal(runner.activeRunCount, 0);
  });

  test("a configured cap is clamped to the safe ceiling", () => {
    const runner = createFeishuResearchRunner({ ...baseOptions(), maxConcurrent: 99 });
    assert.equal(runner.maxConcurrent, 4);
  });

  test("a disposed runner fails closed", async () => {
    const { startResearchFn, calls } = fakeResearch();
    const runner = createFeishuResearchRunner({ ...baseOptions(), startResearchFn, readRunFn: fakeReadRun().readRunFn });
    await runner.dispose();
    const result = await runner.runResearch({ topic: "AI" });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "runtime_unavailable");
    assert.equal(calls.length, 0);
  });
});
