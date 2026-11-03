/**
 * Deterministic fixtures shared by the AGT-032 tests and the local live-evidence
 * driver. These replace only the model/network boundary: the Feishu adapter, the
 * research command contract, `startResearch()` and the run store stay real.
 */
import { ERROR_CODE, TOOL } from "../src/research/contracts.mjs";
import { RUNTIME_PORT_VERSION } from "../src/research/port.mjs";

export const REPORT_TEXT = [
  "## 摘要",
  "",
  "飞书临时研究完成，这是一份用于确定性验证的报告正文。",
  "",
  "## 关键进展",
  "",
  "- 飞书通道调用了现有 AGT-028 research 入口并持久化了运行记录。",
  "- 回复内容来自 run store 中的报告，而不是 Feishu adapter 自己生成。",
  "",
  "## 不确定性/失败项",
  "",
  "- 本报告来自 fixture runtime，不代表真实模型或网络结果。",
].join("\n");

export const LONG_REPORT_TEXT = `${REPORT_TEXT}\n\n${"很长的报告段落。".repeat(4_000)}`;

export function usage() {
  return {
    inputTokens: 120,
    outputTokens: 480,
    totalTokens: 600,
    modelId: "fixture-model",
    providerId: "fixture",
    source: "provider",
  };
}

function hit(url) {
  return {
    title: `Fixture source ${url}`,
    url,
    snippet: "fixture snippet",
    publishedAt: null,
    siteName: "example.com",
    dateSource: "none",
    dateConfidence: "none",
  };
}

export function searchResult(urls) {
  return {
    content: [{ type: "text", text: `search returned ${urls.length} results` }],
    details: {
      status: urls.length > 0 ? "ok" : "empty",
      provider: "fixture",
      timeRange: "any",
      timeRangeApplied: "provider_hint",
      query: "fixture query",
      results: urls.map((url) => hit(url)),
      count: urls.length,
      pagesFetched: 1,
      injectionSignals: [],
    },
    isError: false,
  };
}

export function pageOk(url) {
  return {
    content: [{ type: "text", text: "page ok" }],
    details: {
      status: "ok",
      url,
      finalUrl: url,
      httpStatus: 200,
      contentType: "text/html",
      bytes: 512,
      charset: "utf-8",
      title: "Fixture page",
      siteName: "example.com",
      publishedAt: null,
      dateSource: "none",
      dateConfidence: "none",
      accessedAt: new Date(0).toISOString(),
      excerpt: "fixture excerpt",
      contentChars: 200,
      truncated: false,
      redirects: [],
      extractor: "readability",
      injectionSignals: [],
    },
    isError: false,
  };
}

export function pageFailed(url, code = ERROR_CODE.HTTP_ERROR) {
  return {
    content: [{ type: "text", text: `page ${code}` }],
    details: {
      status: "error",
      url,
      finalUrl: url,
      httpStatus: 403,
      contentType: null,
      bytes: 0,
      redirects: [],
      elapsedMs: 5,
      injectionSignals: [],
      error: { code, message: "fixture page failure", retryable: false },
    },
    isError: true,
  };
}

/** Fixture research tool layer: deterministic details, no network. */
export function fixtureToolLayer({
  search = (params) => searchResult([`https://example.com/${params.query ?? "query"}`]),
  read = (params) => pageOk(params.url),
} = {}) {
  return {
    tools: [
      {
        name: TOOL.SEARCH,
        label: "Fixture search",
        description: "fixture",
        parameters: { type: "object", properties: {} },
        async execute(_id, params) {
          return search(params ?? {});
        },
      },
      {
        name: TOOL.READ_PAGE,
        label: "Fixture read",
        description: "fixture",
        parameters: { type: "object", properties: {} },
        async execute(_id, params) {
          return read(params ?? {});
        },
      },
    ],
  };
}

/** Scripted runtime port: the script calls the injected wrapped tools itself. */
export function scriptedPort(handler) {
  return {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent(spec) {
      const byName = new Map(spec.customTools.map((tool) => [tool.name, tool]));
      const toolCalls = [];
      const call = async (name, params = {}) => {
        const tool = byName.get(name);
        if (!tool) throw new Error(`scripted runtime: tool ${name} was not exposed`);
        const callId = `${name}-${toolCalls.length + 1}`;
        const result = await tool.execute(callId, params, spec.signal, undefined, {});
        toolCalls.push({
          callId,
          name,
          status: result?.isError ? "error" : "ok",
          durationMs: 1,
          isError: Boolean(result?.isError),
        });
        return result;
      };
      return handler({ spec, call, toolCalls });
    },
  };
}

export function completedPort({ text = REPORT_TEXT, onRun } = {}) {
  return scriptedPort(async ({ toolCalls }) => {
    onRun?.();
    return { status: "completed", text, usage: usage(), toolCalls, error: null };
  });
}

/** Reports one failed tool call, so the executor ends in completed_with_errors. */
export function partialPort({ onRun } = {}) {
  return scriptedPort(async ({ call, toolCalls }) => {
    onRun?.();
    await call(TOOL.SEARCH, { query: "partial" });
    await call(TOOL.READ_PAGE, { url: "https://example.com/broken" });
    return { status: "completed", text: REPORT_TEXT, usage: usage(), toolCalls, error: null };
  });
}

/**
 * A port that never finishes on its own. It rejects with AbortError when the
 * caller aborts, which is how the real AGT-027 adapter behaves.
 */
export function hangingPort() {
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const port = {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent(spec) {
      startedResolve(spec);
      await new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error("client cancelled");
          error.name = "AbortError";
          reject(error);
        };
        if (spec.signal?.aborted) abort();
        else spec.signal?.addEventListener("abort", abort, { once: true });
      });
      return { status: "cancelled", text: "", usage: usage(), toolCalls: [], error: null };
    },
  };
  return { port, started };
}
