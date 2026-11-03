/**
 * Deterministic fixtures shared by the scheduler tests and the local POC
 * evidence script. These replace the model/network boundary only: the real
 * AGT-028 `startResearch()`/`executeResearch()` path and the run store are
 * always exercised by T3.
 */
import { RUNTIME_PORT_VERSION } from "../../src/research/port.mjs";
import { TOOL } from "../../src/research/contracts.mjs";

export const REPORT_TEXT = [
  "## 摘要",
  "",
  "定时研究执行完成，这是一份用于确定性验证的报告正文。",
  "",
  "## 关键进展",
  "",
  "- Scheduler 在明确的触发时刻调用了现有研究执行入口。",
  "",
  "## 不确定性/失败项",
  "",
  "- 本报告来自 fixture runtime，不代表真实模型或网络结果。",
].join("\n");

export function createFakeClock(initial) {
  let ms = new Date(initial).getTime();
  const now = () => new Date(ms);
  now.set = (value) => {
    ms = value instanceof Date ? value.getTime() : Date.parse(value);
  };
  now.advance = (deltaMs) => {
    ms += deltaMs;
  };
  now.iso = () => new Date(ms).toISOString();
  return now;
}

export function fixtureToolLayer() {
  return {
    tools: [
      {
        name: TOOL.SEARCH,
        label: "fixture search",
        description: "fixture search tool; scheduler tests do not call it",
        parameters: { type: "object", properties: {} },
        async execute() {
          throw new Error("fixture search must not be called by the scheduler fixture");
        },
      },
      {
        name: TOOL.READ_PAGE,
        label: "fixture read page",
        description: "fixture read tool; scheduler tests do not call it",
        parameters: { type: "object", properties: {} },
        async execute() {
          throw new Error("fixture read-page must not be called by the scheduler fixture");
        },
      },
    ],
  };
}

export function scriptedRuntimePort(handler) {
  return {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent(spec) {
      return handler(spec);
    },
  };
}

function usage() {
  return {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    modelId: "fixture-model",
    providerId: "fixture",
    source: "provider",
  };
}

export function completedPort({ text = REPORT_TEXT, onRun } = {}) {
  return scriptedRuntimePort(async (spec) => {
    onRun?.(spec);
    return { status: "completed", text, usage: usage(), toolCalls: [], error: null };
  });
}

export function failedPort({ onRun } = {}) {
  return scriptedRuntimePort(async (spec) => {
    onRun?.(spec);
    return {
      status: "failed",
      text: "",
      usage: usage(),
      toolCalls: [],
      error: { code: "model_error", message: "fixture runtime failure" },
    };
  });
}

/** Resolve only when the executor's deadline aborts; keeps running past it. */
export function slowPort({ delayMs = 80, onRun } = {}) {
  return scriptedRuntimePort(async (spec) => {
    onRun?.(spec);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { status: "completed", text: REPORT_TEXT, usage: usage(), toolCalls: [], error: null };
  });
}

/** Resolve as cancelled when the caller aborts the injected signal. */
export function cancellablePort({ onRun } = {}) {
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const port = scriptedRuntimePort(
    (spec) =>
      new Promise((resolve) => {
        onRun?.(spec);
        startedResolve(spec);
        const finish = () => resolve({ status: "cancelled", text: "", usage: usage(), toolCalls: [], error: null });
        if (spec.signal?.aborted) finish();
        else spec.signal?.addEventListener("abort", finish, { once: true });
      }),
  );
  return { port, started };
}

/**
 * A controllable port: `started` resolves when runAgent is called and
 * `finish()` resolves the run. Used to observe the lease while a run is active.
 */
export function deferredPort() {
  let release;
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const port = scriptedRuntimePort(
    (spec) =>
      new Promise((resolve) => {
        startedResolve(spec);
        release = (status = "completed") =>
          resolve({
            status,
            text: status === "completed" ? REPORT_TEXT : "",
            usage: usage(),
            toolCalls: [],
            error: status === "failed" ? { code: "model_error", message: "fixture failure" } : null,
          });
      }),
  );
  return { port, started, finish: (status) => release?.(status) };
}

export function researchDeps({ rootDir, port }) {
  return { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir, env: {} };
}
