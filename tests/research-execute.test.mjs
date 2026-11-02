/**
 * Executor tests (AGT-028, offline): a fixture tool layer plus a scripted
 * runtime port, no network and no model. Covers the full status matrix, budget
 * enforcement, usage/provenance persistence, secret redaction and the offline
 * `--read` CLI path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeResearch,
  normalizeResearchRequest,
  startResearch,
  RunValidationError,
  ResearchConfigError,
} from "../src/research/execute.mjs";
import { readResearchRun, listResearchRuns } from "../src/research/index.mjs";
import { parseArgs } from "../scripts/research.mjs";
import { RUNTIME_PORT_VERSION, RuntimeUnavailableError } from "../src/research/port.mjs";
import { createRunStore } from "../src/research/run-store.mjs";
import { ERROR_CODE, RUN_STATUS, TOOL } from "../src/research/contracts.mjs";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../scripts/research.mjs", import.meta.url));
const RUN_ID_PATTERN = /^r-\d{8}T\d{6}-[0-9a-f]{6}$/;

const LONG_REPORT = [
  "## 摘要",
  "",
  "- AI Agent 工程在 48 小时内发布了框架更新 [S1]。",
  "",
  "## 关键进展",
  "",
  "- 框架新增流式工具执行能力 [S1]。",
  "",
  "## 来源与证据",
  "",
  "- [S1] 官方发布说明支撑上述事实。",
  "",
  "## 不确定性/失败项",
  "",
  "- 无。",
].join("\n");

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "cloud-pi-exec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function hit(url, overrides = {}) {
  return {
    title: overrides.title ?? `Source ${url}`,
    url,
    snippet: "Snippet text.",
    publishedAt: overrides.publishedAt ?? null,
    siteName: "example.com",
    dateSource: overrides.dateSource ?? (overrides.publishedAt ? "provider" : "none"),
    dateConfidence: overrides.dateConfidence ?? (overrides.publishedAt ? "unverified" : "none"),
  };
}

function searchToolResult(results) {
  return {
    content: [{ type: "text", text: `search returned ${results.length} results` }],
    details: {
      status: results.length > 0 ? "ok" : "empty",
      provider: "fixture",
      timeRange: "48h",
      timeRangeApplied: "provider_hint",
      query: "fixture query",
      results,
      count: results.length,
      pagesFetched: 1,
      injectionSignals: [],
    },
    isError: false,
  };
}

function pageToolResult(details) {
  return {
    content: [{ type: "text", text: `page ${details.status}` }],
    details,
    isError: details.status === "error",
  };
}

function pageOk(url, finalUrl = url) {
  return pageToolResult({
    status: "ok",
    url,
    finalUrl,
    httpStatus: 200,
    contentType: "text/html",
    bytes: 1234,
    charset: "utf-8",
    title: "Fixture page",
    siteName: "example.com",
    publishedAt: "2026-11-01T08:00:00.000Z",
    dateSource: "page",
    dateConfidence: "verified",
    accessedAt: "2026-11-02T09:00:05.000Z",
    excerpt: "Fixture excerpt supporting the claim.",
    contentChars: 321,
    truncated: false,
    redirects: [],
    extractor: "readability",
    injectionSignals: [],
  });
}

function pageFailed(url, code = ERROR_CODE.HTTP_ERROR, message = "HTTP 403") {
  return pageToolResult({
    status: "error",
    url,
    finalUrl: url,
    httpStatus: 403,
    contentType: null,
    bytes: 0,
    redirects: [],
    elapsedMs: 12,
    injectionSignals: [],
    error: { code, message, retryable: false },
  });
}

/**
 * Fixture tool layer: deterministic details, no network. `behavior` decides
 * what one call returns based on its params.
 */
function fixtureToolLayer({ search = (params) => searchToolResult([hit(`https://example.com/${params.query}`)]), read = (params) => pageOk(params.url) } = {}) {
  return {
    tools: [
      {
        name: TOOL.SEARCH,
        label: "Fixture search",
        description: "fixture",
        parameters: {},
        async execute(_id, params) {
          return search(params ?? {});
        },
      },
      {
        name: TOOL.READ_PAGE,
        label: "Fixture read",
        description: "fixture",
        parameters: {},
        async execute(_id, params) {
          return read(params ?? {});
        },
      },
    ],
  };
}

/** Scripted runtime port: the script calls the injected wrapped tools itself. */
function scriptedPort(handler) {
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

const USAGE = {
  inputTokens: 120,
  outputTokens: 480,
  totalTokens: 600,
  modelId: "fixture-model",
  providerId: "fixture-provider",
  source: "provider",
};

function delays(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("completed run persists report, ledger, usage and ledger paths", async (t) => {
  const rootDir = await tempRoot(t);
  const port = scriptedPort(async ({ call, toolCalls }) => {
    const searchResult = await call(TOOL.SEARCH, { query: "agent-framework", timeRange: "48h" });
    assert.match(searchResult.content.at(-1).text, /S1:/);
    await call(TOOL.READ_PAGE, { url: "https://example.com/agent-framework" });
    return { status: "completed", text: LONG_REPORT, usage: USAGE, toolCalls };
  });
  const record = await executeResearch(
    { topic: "AI Agent 工程进展", goal: "梳理 48 小时内的进展", timeRange: "48h" },
    {
      runtimePort: port,
      toolLayer: fixtureToolLayer({
        search: () =>
          searchToolResult([
            hit("https://example.com/agent-framework"),
            hit("https://example.com/secondary"),
          ]),
      }),
      rootDir,
      now: new Date("2026-11-02T09:00:00.000Z"),
    },
  );

  assert.match(record.runId, RUN_ID_PATTERN);
  assert.equal(record.status, RUN_STATUS.COMPLETED);
  assert.equal(record.request.topic, "AI Agent 工程进展");
  assert.equal(record.request.timeRange, "48h");
  assert.equal(record.paths.report, "report.md");
  assert.equal(record.paths.sources, "sources.json");
  assert.equal(record.paths.sourcesMarkdown, "sources.md");
  assert.ok(!record.paths.run.includes(rootDir), "artifact paths must be relative");

  const { run, report, sources } = await readResearchRun(record.runId, { rootDir });
  assert.equal(run.status, RUN_STATUS.COMPLETED);
  assert.match(report, /^## 摘要/);
  assert.match(report, /来源: 共 2 条，已读取 1，读取失败 0，仅搜索命中 1/);
  assert.ok(!report.includes("Citation audit"));
  assert.equal(sources.length, 2);
  assert.equal(sources[0].status, "fetched");
  assert.equal(sources[0].finalUrl, "https://example.com/agent-framework");
  assert.equal(sources[0].publishedAtConfidence, "verified");
  assert.equal(sources[1].status, "not_fetched");
  assert.deepEqual(run.citations.resolved.map((entry) => entry.id), ["S1"]);
  assert.deepEqual(run.citations.unresolved, []);
  assert.deepEqual(run.runtime.usage, USAGE);
  assert.equal(run.tools.counters.searches, 1);
  assert.equal(run.tools.counters.pages, 1);
  assert.equal(run.tools.calls.length, 2);
  assert.ok(run.tools.calls.every((call) => !("args" in call) && !("params" in call)));

  const files = (await readdir(join(rootDir, run.runId))).sort();
  assert.deepEqual(files, ["report.md", "run.json", "sources.json", "sources.md", "transcript.md"]);

  const listed = await listResearchRuns({ rootDir });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].runId, record.runId);
});

test("failed page fetch → completed_with_errors and a failed source", async (t) => {
  const rootDir = await tempRoot(t);
  const url = "https://example.com/broken";
  const port = scriptedPort(async ({ call, toolCalls }) => {
    await call(TOOL.SEARCH, { query: "broken" });
    await call(TOOL.READ_PAGE, { url });
    return { status: "completed", text: LONG_REPORT, usage: USAGE, toolCalls };
  });
  const record = await executeResearch(
    { topic: "failed fetch" },
    {
      runtimePort: port,
      toolLayer: fixtureToolLayer({
        search: () => searchToolResult([hit(url)]),
        read: () => pageFailed(url),
      }),
      rootDir,
    },
  );

  assert.equal(record.status, RUN_STATUS.COMPLETED_WITH_ERRORS);
  assert.equal(record.paths.report, "report.md");
  const { sources } = await readResearchRun(record.runId, { rootDir });
  assert.equal(sources[0].status, "failed");
  assert.equal(sources[0].error.code, ERROR_CODE.HTTP_ERROR);
  assert.ok(record.errors.some((error) => error.code === ERROR_CODE.HTTP_ERROR));
  assert.ok(record.errors.some((error) => error.phase === "tools"));
});

test("runtime failure → failed with no report", async (t) => {
  const rootDir = await tempRoot(t);
  const port = scriptedPort(async ({ toolCalls }) => ({
    status: "failed",
    text: "",
    usage: { ...USAGE, source: "unknown" },
    toolCalls,
    error: { code: "model_error", message: "provider rejected the request" },
  }));
  const record = await executeResearch(
    { topic: "runtime failure" },
    { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir },
  );
  assert.equal(record.status, RUN_STATUS.FAILED);
  assert.equal(record.paths.report, null);
  assert.equal(record.runtime.error.code, ERROR_CODE.MODEL_ERROR);
  const { run, report } = await readResearchRun(record.runId, { rootDir });
  assert.equal(run.status, RUN_STATUS.FAILED);
  assert.equal(report, null);
  // The source ledger is still persisted even when the report is not.
  assert.equal(run.paths.sources, "sources.json");
});

test("completed runtime without a report body → failed with model_error", async (t) => {
  const rootDir = await tempRoot(t);
  const port = scriptedPort(async ({ toolCalls }) => ({
    status: "completed",
    text: "done",
    usage: USAGE,
    toolCalls,
  }));
  const record = await executeResearch(
    { topic: "no report" },
    { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir },
  );
  assert.equal(record.status, RUN_STATUS.FAILED);
  assert.equal(record.paths.report, null);
  assert.ok(record.errors.some((error) => error.code === ERROR_CODE.MODEL_ERROR && error.phase === "report"));
});

test("external abort → cancelled", async (t) => {
  const rootDir = await tempRoot(t);
  const controller = new AbortController();
  const port = {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent(spec) {
      return new Promise((_resolve, reject) => {
        spec.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("client cancelled");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    },
  };
  setTimeout(() => controller.abort(), 10);
  const record = await executeResearch(
    { topic: "cancel me" },
    { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir, signal: controller.signal },
  );
  assert.equal(record.status, RUN_STATUS.CANCELLED);
  assert.equal(record.paths.report, null);
  assert.ok(record.errors.some((error) => error.code === ERROR_CODE.ABORTED));
});

test("global deadline → timeout", async (t) => {
  const rootDir = await tempRoot(t);
  const port = {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent() {
      await delays(150);
      return { status: "completed", text: LONG_REPORT, usage: USAGE, toolCalls: [] };
    },
  };
  const record = await executeResearch(
    { topic: "deadline", limits: { maxRuntimeMs: 25 } },
    { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir },
  );
  assert.equal(record.status, RUN_STATUS.TIMEOUT);
  assert.ok(record.errors.some((error) => error.code === ERROR_CODE.TIMEOUT));
});

test("budget exhaustion refuses calls and records budget_exceeded", async (t) => {
  const rootDir = await tempRoot(t);
  const port = scriptedPort(async ({ call, toolCalls }) => {
    await call(TOOL.SEARCH, { query: "one" });
    await call(TOOL.SEARCH, { query: "two" });
    await call(TOOL.READ_PAGE, { url: "https://example.com/one" });
    await call(TOOL.READ_PAGE, { url: "https://example.com/two" });
    return { status: "completed", text: LONG_REPORT, usage: USAGE, toolCalls };
  });
  const record = await executeResearch(
    { topic: "budget", limits: { maxSearches: 1, maxPages: 1 } },
    { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir },
  );

  assert.equal(record.status, RUN_STATUS.COMPLETED_WITH_ERRORS);
  assert.equal(record.tools.counters.searches, 1);
  assert.equal(record.tools.counters.pages, 1);
  assert.equal(record.tools.counters.refused, 2);
  assert.equal(record.tools.counters.toolCalls, 2);
  const refused = record.tools.calls.filter((call) => call.status === "refused");
  assert.equal(refused.length, 2);
  assert.ok(refused.every((call) => call.errorCode === ERROR_CODE.BUDGET_EXCEEDED));
  assert.ok(record.errors.some((error) => error.code === ERROR_CODE.BUDGET_EXCEEDED));
  // Only successfully executed calls contribute sources.
  const { sources } = await readResearchRun(record.runId, { rootDir });
  assert.deepEqual(sources.map((source) => source.url), ["https://example.com/one"]);
});

test("limits are clamped and rootDir precedence is explicit > env", async (t) => {
  const rootDir = await tempRoot(t);
  const envRoot = await tempRoot(t);
  const port = scriptedPort(async ({ toolCalls }) => ({
    status: "completed",
    text: LONG_REPORT,
    usage: USAGE,
    toolCalls,
  }));
  const record = await executeResearch(
    { topic: "clamp", limits: { maxSearches: 999, maxPages: 0 } },
    {
      runtimePort: port,
      toolLayer: fixtureToolLayer(),
      rootDir,
      env: { RESEARCH_RUNS_DIR: envRoot },
    },
  );
  assert.equal(record.limits.maxSearches, 12);
  assert.equal(record.limits.maxPages, 10);
  assert.equal(record.runId && (await readdir(join(rootDir, record.runId))).length > 0, true);
  assert.equal((await readdir(envRoot)).length, 0);
});

test("model-claimed URLs never reach the source ledger", async (t) => {
  const rootDir = await tempRoot(t);
  const port = scriptedPort(async ({ call, toolCalls }) => {
    await call(TOOL.SEARCH, { query: "real" });
    await call(TOOL.READ_PAGE, { url: "https://example.com/real" });
    return {
      status: "completed",
      text: `${LONG_REPORT}\n\n编造来源：https://fake.example/invented [S9]。`,
      usage: USAGE,
      toolCalls,
    };
  });
  const record = await executeResearch(
    { topic: "provenance" },
    { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir },
  );
  assert.equal(record.status, RUN_STATUS.COMPLETED);
  const { report, sources } = await readResearchRun(record.runId, { rootDir });
  // The model's text may contain the invented URL, but it must never become a source.
  assert.ok(!JSON.stringify(sources).includes("fake.example"));
  assert.deepEqual(record.citations.unresolved.map((entry) => entry.id), ["S9"]);
  assert.match(report, /## Citation audit/);
  assert.match(report, /S9×1/);
});

test("credential-looking strings never reach run.json", async (t) => {
  const rootDir = await tempRoot(t);
  const port = {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent() {
      throw Object.assign(new Error("auth failed with Bearer sk-live-SECRET1234567890 and api_key=SECRETKEY123456"), {
        code: ERROR_CODE.MODEL_ERROR,
      });
    },
  };
  const record = await executeResearch(
    { topic: "secrets" },
    { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir },
  );
  assert.equal(record.status, RUN_STATUS.FAILED);
  const raw = await readFile(join(rootDir, record.runId, "run.json"), "utf8");
  assert.ok(!raw.includes("sk-live-SECRET1234567890"));
  assert.ok(!raw.includes("SECRETKEY123456"));
  assert.match(raw, /\[redacted\]/);
});

test("URL credentials are redacted from the persisted source ledger", async (t) => {
  const rootDir = await tempRoot(t);
  const marker = "TEST-URL-TOKEN-1a2b3c";
  const tokenUrl = `https://example.com/article?access_token=${marker}`;
  const port = scriptedPort(async ({ call, toolCalls }) => {
    await call(TOOL.SEARCH, { query: "token url" });
    await call(TOOL.READ_PAGE, { url: tokenUrl });
    return { status: "completed", text: LONG_REPORT, usage: USAGE, toolCalls };
  });
  const record = await executeResearch(
    { topic: "url token" },
    {
      runtimePort: port,
      toolLayer: fixtureToolLayer({ search: () => searchToolResult([hit(tokenUrl)]), read: () => pageOk(tokenUrl) }),
      rootDir,
    },
  );
  assert.equal(record.status, RUN_STATUS.COMPLETED);
  for (const name of ["run.json", "report.md", "sources.json", "sources.md", "transcript.md"]) {
    const text = await readFile(join(rootDir, record.runId, name), "utf8");
    assert.ok(!text.includes(marker), `${name} leaked a URL credential`);
  }
  assert.match(
    await readFile(join(rootDir, record.runId, "sources.json"), "utf8"),
    /access_token=\[redacted\]/,
  );
});

test("usage is persisted honestly when the runtime reports none", async (t) => {
  const rootDir = await tempRoot(t);
  const port = scriptedPort(async ({ toolCalls }) => ({
    status: "completed",
    text: LONG_REPORT,
    usage: undefined,
    toolCalls,
  }));
  const record = await executeResearch(
    { topic: "usage unknown" },
    { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir },
  );
  assert.deepEqual(record.runtime.usage, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    modelId: null,
    providerId: null,
    source: "unknown",
  });
});

test("request validation rejects bad input with invalid_request", async () => {
  const toolLayer = fixtureToolLayer();
  const port = scriptedPort(async ({ toolCalls }) => ({ status: "completed", text: LONG_REPORT, usage: USAGE, toolCalls }));
  const deps = { runtimePort: port, toolLayer, rootDir: join(tmpdir(), "unused-validation") };

  for (const request of [
    {},
    { topic: "" },
    { topic: "   " },
    { topic: "x".repeat(2001) },
    { topic: "ok", timeRange: "1y" },
    { topic: "ok", goal: 42 },
    { topic: "ok", limits: "nope" },
  ]) {
    await assert.rejects(executeResearch(request, deps), (error) => {
      assert.ok(error instanceof RunValidationError, `expected RunValidationError for ${JSON.stringify(request)}`);
      assert.equal(error.code, ERROR_CODE.INVALID_REQUEST);
      return true;
    });
  }
  assert.throws(() => normalizeResearchRequest({ topic: 42 }), /topic is required/);
});

test("missing runtime fails closed and a malformed tool layer is a config error", async (t) => {
  const rootDir = await tempRoot(t);
  await assert.rejects(
    executeResearch({ topic: "no runtime" }, { toolLayer: fixtureToolLayer(), rootDir }),
    (error) => {
      assert.ok(error instanceof RuntimeUnavailableError);
      assert.equal(error.code, ERROR_CODE.RUNTIME_UNAVAILABLE);
      return true;
    },
  );
  const port = scriptedPort(async ({ toolCalls }) => ({ status: "completed", text: LONG_REPORT, usage: USAGE, toolCalls }));
  for (const toolLayer of [{ tools: [] }, { tools: [{ name: "broken" }] }]) {
    await assert.rejects(
      executeResearch({ topic: "no tools" }, { runtimePort: port, rootDir, toolLayer }),
      (error) => {
        assert.ok(error instanceof ResearchConfigError);
        assert.equal(error.code, ERROR_CODE.CONFIG_ERROR);
        return true;
      },
    );
  }
  assert.deepEqual(await readdir(rootDir), []);
});

test("startResearch returns the run id while run.json says running", async (t) => {
  const rootDir = await tempRoot(t);
  let release;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const port = {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent() {
      started();
      return new Promise((resolve) => {
        release = () => resolve({ status: "completed", text: LONG_REPORT, usage: USAGE, toolCalls: [] });
      });
    },
  };
  const { runId, done } = await startResearch(
    { topic: "start async" },
    { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir },
  );
  assert.match(runId, RUN_ID_PATTERN);
  const store = createRunStore({ rootDir });
  const running = await store.readRun(runId);
  assert.equal(running.status, RUN_STATUS.RUNNING);
  await startedPromise;
  release();
  const finished = await done;
  assert.equal(finished.status, RUN_STATUS.COMPLETED);
  assert.equal((await store.readRun(runId)).status, RUN_STATUS.COMPLETED);
});

test("listResearchRuns returns newest first", async (t) => {
  const rootDir = await tempRoot(t);
  const port = scriptedPort(async ({ toolCalls }) => ({
    status: "completed",
    text: LONG_REPORT,
    usage: USAGE,
    toolCalls,
  }));
  const first = await executeResearch(
    { topic: "older" },
    { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir, now: new Date("2026-11-01T09:00:00.000Z") },
  );
  const second = await executeResearch(
    { topic: "newer" },
    {
      runtimePort: port,
      toolLayer: fixtureToolLayer({
        search: () =>
          searchToolResult([
            hit("https://example.com/agent-framework"),
            hit("https://example.com/secondary"),
          ]),
      }),
      rootDir,
      now: new Date("2026-11-02T09:00:00.000Z"),
    },
  );
  const runs = await listResearchRuns({ rootDir });
  assert.deepEqual(runs.map((run) => run.runId), [second.runId, first.runId]);
});

test("readResearchRun classifies unknown and corrupt runs", async (t) => {
  const rootDir = await tempRoot(t);
  await assert.rejects(readResearchRun("r-20261102T090000-abcdef", { rootDir }), (error) => {
    assert.equal(error.code, "not_found");
    return true;
  });
  const store = createRunStore({ rootDir });
  const runId = "r-20261102T090000-abcdef";
  await store.createRun({
    contractVersion: 1,
    runId,
    status: "running",
    createdAt: "2026-11-02T09:00:00.000Z",
    request: { topic: "corrupt" },
    paths: {},
    errors: [],
  });
  await writeFile(join(rootDir, runId, "run.json"), "{broken", "utf8");
  await assert.rejects(readResearchRun(runId, { rootDir }), (error) => {
    assert.equal(error.code, "parse_error");
    return true;
  });
});

test("the real research tool layer is accepted by the executor (no tool call, no network)", async (t) => {
  const rootDir = await tempRoot(t);
  const [{ createWebSearchTool }, { createReadPageTool }] = await Promise.all([
    import("../src/research/tools/search.mjs"),
    import("../src/research/tools/read-page.mjs"),
  ]);
  const toolLayer = {
    tools: [createWebSearchTool({ limits: {} }), createReadPageTool({ limits: {} })],
  };
  const port = scriptedPort(async ({ spec, toolCalls }) => {
    assert.deepEqual(spec.customTools.map((tool) => tool.name).sort(), [TOOL.READ_PAGE, TOOL.SEARCH].sort());
    return { status: "completed", text: LONG_REPORT, usage: USAGE, toolCalls };
  });
  const record = await executeResearch({ topic: "real tool definitions" }, { runtimePort: port, toolLayer, rootDir });
  assert.equal(record.status, RUN_STATUS.COMPLETED);
  assert.equal(record.tools.calls.length, 0);
});

test("CLI --read is offline and reports run id, status and artifact paths", async (t) => {
  const rootDir = await tempRoot(t);
  const port = scriptedPort(async ({ call, toolCalls }) => {
    await call(TOOL.SEARCH, { query: "cli-read" });
    await call(TOOL.READ_PAGE, { url: "https://example.com/cli-read" });
    return { status: "completed", text: LONG_REPORT, usage: USAGE, toolCalls };
  });
  const record = await executeResearch(
    { topic: "CLI read" },
    { runtimePort: port, toolLayer: fixtureToolLayer(), rootDir },
  );

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI,
    "--read",
    record.runId,
    "--runs-dir",
    rootDir,
  ]);
  assert.equal(stderr, "");
  assert.match(stdout, new RegExp(`run_id: ${record.runId}`));
  assert.match(stdout, /status: completed/);
  assert.match(stdout, new RegExp(`report: .*${record.runId}.*report\\.md`));
  assert.match(stdout, new RegExp(`sources: .*${record.runId}.*sources\\.json`));

  await assert.rejects(
    execFileAsync(process.execPath, [CLI, "--read", "r-20261102T090000-abcdef", "--runs-dir", rootDir]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /not_found/);
      return true;
    },
  );
});

test("CLI accepts the hackernews search provider and rejects unknown ones", () => {
  assert.equal(parseArgs(["--topic", "x", "--search-provider", "hackernews"]).searchProvider, "hackernews");
  assert.throws(() => parseArgs(["--topic", "x", "--search-provider", "nope"]), /--search-provider expects one of/);
});

test("omitting toolLayer wires the production tool layer lazily", async (t) => {
  const rootDir = await tempRoot(t);
  const port = scriptedPort(async ({ spec, toolCalls }) => {
    assert.deepEqual(spec.customTools.map((tool) => tool.name).sort(), [TOOL.READ_PAGE, TOOL.SEARCH].sort());
    return { status: "completed", text: LONG_REPORT, usage: USAGE, toolCalls };
  });
  const record = await executeResearch({ topic: "default tools" }, { runtimePort: port, rootDir });
  assert.equal(record.status, RUN_STATUS.COMPLETED);
});

test("CLI usage errors exit 2 and missing runtime exits 3", async (t) => {
  const rootDir = await tempRoot(t);
  await assert.rejects(execFileAsync(process.execPath, [CLI]), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /--topic is required/);
    return true;
  });
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, "--topic", "x", "--max-pages", "0", "--runs-dir", rootDir]),
    (error) => {
      assert.equal(error.code, 2);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [CLI, "--topic", "x", "--runs-dir", rootDir, "--runtime-module", "/nonexistent/runtime.mjs"],
      { env: { ...process.env, RESEARCH_AGENT_RUNTIME_MODULE: "" } },
    ),
    (error) => {
      assert.equal(error.code, 3);
      assert.match(error.stderr, /runtime_unavailable/);
      return true;
    },
  );
});
