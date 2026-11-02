/**
 * T3 — Pi pipeline verification (AGT-028, verifier-owned).
 *
 * These tests drive a real `createAgentSession` whose model is the SDK's
 * `fauxProvider` and whose `customTools` are the real `research_web_search` /
 * `research_read_page` definitions, against a loopback fixture server. They
 * prove the parts T1/T2 cannot: that the research tools execute *through Pi's
 * tool pipeline* (argument validation, `tool_call`/`tool_result` events,
 * abort propagation) and that the executor maps a real Pi run into persisted
 * artifacts correctly.
 *
 * What this is NOT: live research evidence. There is no real model, no real
 * search provider and no real page. `tests/helpers/session-harness.mjs` installs
 * a socket guard; any non-loopback connection fails the test file.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServer } from "./helpers/fixture-server.mjs";
import {
  PI_CODING_AGENT_VERSION,
  assertNoNetworkEgress,
  createPiPipelinePort,
  createResearchSession,
  spyOnTool,
  textStep,
  toolCallStep,
  toolResultText,
  transcriptToolResults,
} from "./helpers/session-harness.mjs";
import { executeResearch } from "../src/research/execute.mjs";
import { readResearchRun } from "../src/research/index.mjs";
import { ERROR_CODE, RUN_STATUS, TOOL } from "../src/research/contracts.mjs";
import { createWebSearchTool } from "../src/research/tools/search.mjs";
import { createReadPageTool } from "../src/research/tools/read-page.mjs";

const REPORT = [
  "## 摘要",
  "",
  "- 框架新增了流式工具执行能力 [S1]。",
  "",
  "## 关键进展",
  "",
  "- 发布说明描述了持久化运行状态 [S1]。",
  "",
  "## 来源与证据",
  "",
  "- [S1] 官方发布说明支撑上述事实。",
  "",
  "## 不确定性/失败项",
  "",
  "- 无。",
].join("\n");

let fixture;
let baseUrl;

const ARTICLE_HTML = `<!doctype html><html><head><title>Agent release</title>
<meta property="article:published_time" content="2026-11-01T10:00:00Z"></head>
<body><article><h1>Agent release</h1><p>${"The framework added streaming tool execution and durable run state. ".repeat(12)}</p></article></body></html>`;

before(async () => {
  fixture = await startFixtureServer({
    "/hn": (req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          hits: [
            {
              objectID: "1",
              title: "Agent framework release",
              url: `${baseUrl}/article`,
              created_at: "2026-11-01T10:00:00.000Z",
              author: "fixture",
              points: 12,
              num_comments: 3,
            },
          ],
        }),
      );
    },
    "/article": (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ARTICLE_HTML);
    },
    "/slow": async (req, res) => {
      await sleep(5000);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<article><h1>Late</h1><p>late page</p></article>");
    },
  });
  baseUrl = fixture.url;
});

after(async () => {
  await fixture?.close();
  assertNoNetworkEgress();
});

function makeTools({ requestTimeoutMs } = {}) {
  const search = createWebSearchTool({
    provider: "hackernews",
    endpoints: { hackernews: `${baseUrl}/hn` },
    env: {},
    proxyUrl: null,
    retryTransient: false,
  });
  const read = createReadPageTool({
    allowLoopback: true,
    env: {},
    proxyUrl: null,
    retryTransient: false,
    ...(requestTimeoutMs ? { limits: { requestTimeoutMs } } : {}),
  });
  return { search, read };
}

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "cloud-pi-t3-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("T3: real Pi session + real research tools (fixture network)", () => {
  test("the pinned Pi SDK exposes exactly the two research tools and a scripted call runs through the pipeline", async () => {
    const { search, read } = makeTools();
    const searchSpy = spyOnTool(search);
    const readSpy = spyOnTool(read);
    const handle = await createResearchSession({ tools: [searchSpy.definition, readSpy.definition] });
    try {
      const pkg = JSON.parse(
        await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"),
      );
      assert.equal(pkg.version, PI_CODING_AGENT_VERSION);
      const aiPkg = JSON.parse(
        await readFile(new URL("../node_modules/@earendil-works/pi-ai/package.json", import.meta.url), "utf8"),
      );
      assert.equal(aiPkg.version, PI_CODING_AGENT_VERSION);

      assert.deepEqual(handle.activeToolNames(), [TOOL.READ_PAGE, TOOL.SEARCH].sort());
      assert.deepEqual(
        handle.session.getAllTools().map((tool) => tool.name).sort(),
        [TOOL.READ_PAGE, TOOL.SEARCH].sort(),
        "no built-in read/bash/edit/write tool may be exposed to the research model",
      );

      const before = fixture.requests.length;
      await handle.run([
        toolCallStep(TOOL.SEARCH, { query: "agent release" }, { id: "call-search" }),
        textStep("scripted-done"),
      ]);

      // The tool really executed: the spy ran with Pi's toolCallId and validated args.
      assert.equal(searchSpy.calls.length, 1);
      assert.equal(searchSpy.calls[0].toolCallId, "call-search");
      assert.deepEqual(searchSpy.calls[0].params, { query: "agent release" });

      // Pi's extension events carry the call and the result.
      assert.equal(handle.capture.toolCalls.length, 1);
      assert.deepEqual(
        {
          toolName: handle.capture.toolCalls[0].toolName,
          toolCallId: handle.capture.toolCalls[0].toolCallId,
        },
        { toolName: TOOL.SEARCH, toolCallId: "call-search" },
      );
      assert.deepEqual(handle.capture.toolCalls[0].input, { query: "agent release" });

      assert.equal(handle.capture.toolResults.length, 1);
      const event = handle.capture.toolResults[0];
      assert.equal(event.toolName, TOOL.SEARCH);
      assert.equal(event.toolCallId, "call-search");
      assert.equal(event.isError, false);
      assert.equal(event.details.status, "ok");
      assert.equal(event.details.count, 1);
      assert.match(toolResultText(event), /<untrusted_web_content source="web_search:agent release">/);

      // The transcript holds the same result; the model then produced its text.
      const result = handle.lastToolResult(TOOL.SEARCH);
      assert.equal(result.isError, false);
      assert.equal(result.toolCallId, "call-search");
      assert.match(toolResultText(result), /Agent framework release/);
      assert.equal(handle.session.getLastAssistantText(), "scripted-done");

      // The only network traffic was the loopback search request.
      const requests = fixture.requests.slice(before);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].path, "/hn");
      assert.equal(requests[0].query.query, "agent release");
      assert.equal(requests[0].query.tags, "story");
      assert.equal(fixture.requests.length, before + 1, "the search tool must not fetch the result pages");
    } finally {
      handle.dispose();
    }
  });

  test("schema validation rejects bad arguments before execute; no request leaves the process", async () => {
    const { search, read } = makeTools();
    const searchSpy = spyOnTool(search);
    const readSpy = spyOnTool(read);
    const handle = await createResearchSession({ tools: [searchSpy.definition, readSpy.definition] });
    try {
      const before = fixture.requests.length;
      await handle.run([
        toolCallStep(TOOL.READ_PAGE, {}, { id: "bad-missing-url" }),
        toolCallStep(TOOL.SEARCH, { query: "x", maxResults: 99 }, { id: "bad-max-results" }),
        toolCallStep(TOOL.SEARCH, { query: "x", timeRange: "1y" }, { id: "bad-window" }),
        textStep("validation-done"),
      ]);

      const results = transcriptToolResults(handle.session);
      assert.equal(results.length, 3);
      assert.deepEqual(
        results.map((result) => result.toolCallId),
        ["bad-missing-url", "bad-max-results", "bad-window"],
      );
      assert.ok(results.every((result) => result.isError === true));
      assert.match(results[0].text, /Validation failed for tool "research_read_page"/);
      assert.match(results[0].text, /url/);
      assert.match(results[1].text, /maxResults/);
      assert.match(results[1].text, /must be <= 12/);
      assert.match(results[2].text, /timeRange/);

      // Validation runs before Pi's tool hook, so neither tool_call nor execute happens.
      assert.equal(readSpy.calls.length, 0);
      assert.equal(searchSpy.calls.length, 0);
      assert.equal(handle.capture.toolCalls.length, 0);
      assert.equal(handle.capture.toolResults.length, 0);
      assert.equal(fixture.requests.length, before, "an invalid call must not reach the network");
      assert.equal(handle.session.getLastAssistantText(), "validation-done");
    } finally {
      handle.dispose();
    }
  });

  test("a timed-out tool surfaces a failed tool result instead of throwing out of the turn", async () => {
    const { read } = makeTools({ requestTimeoutMs: 250 });
    const handle = await createResearchSession({ tools: [read] });
    try {
      const before = fixture.requests.length;
      const started = Date.now();
      await handle.run([
        toolCallStep(TOOL.READ_PAGE, { url: `${baseUrl}/slow` }, { id: "slow-call" }),
        textStep("after-timeout"),
      ]);
      const elapsed = Date.now() - started;

      const result = handle.lastToolResult(TOOL.READ_PAGE);
      assert.equal(result.isError, true);
      assert.match(toolResultText(result), /\[timeout\]/);
      assert.match(toolResultText(result), /timed out/i);
      assert.ok(elapsed < 4000, `the tool timeout must stop the request early (elapsed ${elapsed}ms)`);
      assert.ok(Number.isFinite(result.durationMs) && result.durationMs < 4000);

      const event = handle.capture.toolResults.at(-1);
      assert.equal(event.toolName, TOOL.READ_PAGE);
      assert.equal(event.isError, true);
      assert.equal(event.details.status, "error");
      assert.equal(event.details.error.code, ERROR_CODE.TIMEOUT);
      assert.equal(event.details.error.retryable, true);

      // The turn continues after the tool failure: the model still sees a result message.
      assert.equal(handle.session.getLastAssistantText(), "after-timeout");
      assert.equal(fixture.requests.slice(before).filter((request) => request.path === "/slow").length, 1);
    } finally {
      handle.dispose();
    }
  });

  test("abort() cancels an in-flight tool and the transcript records the cancellation", async () => {
    const { read } = makeTools({ requestTimeoutMs: 15_000 });
    const handle = await createResearchSession({ tools: [read] });
    try {
      handle.faux.setResponses([
        toolCallStep(TOOL.READ_PAGE, { url: `${baseUrl}/slow` }, { id: "abort-call" }),
        textStep("should-not-arrive"),
      ]);
      const prompt = handle.session.prompt("abort this");
      await sleep(300);
      const started = Date.now();
      await handle.session.abort();
      await prompt.catch(() => {});
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 3000, `abort must not wait for the tool (${elapsed}ms)`);
      const result = handle.lastToolResult(TOOL.READ_PAGE);
      assert.equal(result.isError, true);
      assert.match(toolResultText(result), /abort/i);
      assert.notEqual(handle.session.getLastAssistantText(), "should-not-arrive");
    } finally {
      handle.dispose();
    }
  });
});

describe("T3: executor mapping over a real Pi pipeline", () => {
  test("a completed Pi run maps to report.md, sources.json, usage and the tool ledger", async (t) => {
    const rootDir = await tempRoot(t);
    const { search, read } = makeTools();
    const port = createPiPipelinePort({
      responses: [
        toolCallStep(TOOL.SEARCH, { query: "agent release" }, { id: "exec-search" }),
        toolCallStep(TOOL.READ_PAGE, { url: `${baseUrl}/article` }, { id: "exec-read" }),
        textStep(REPORT),
      ],
    });
    try {
      const before = fixture.requests.length;
      const record = await executeResearch(
        { topic: "AI Agent 工程进展", goal: "48 小时内的进展", timeRange: "48h" },
        {
          runtimePort: port,
          toolLayer: { tools: [search, read] },
          rootDir,
          now: new Date("2026-11-02T09:00:00.000Z"),
        },
      );

      assert.equal(record.status, RUN_STATUS.COMPLETED);
      assert.equal(record.errors.length, 0);
      assert.equal(record.runtime.status, "completed");
      assert.equal(record.runtime.usage.source, "provider");
      assert.ok(record.runtime.usage.totalTokens > 0);
      assert.equal(record.runtime.usage.modelId, "research-scripted");

      assert.deepEqual(
        record.tools.calls.map((call) => [call.seq, call.callId, call.name, call.status]),
        [
          [1, "exec-search", TOOL.SEARCH, "ok"],
          [2, "exec-read", TOOL.READ_PAGE, "ok"],
        ],
      );
      assert.deepEqual(record.tools.counters, { searches: 1, pages: 1, toolCalls: 2, refused: 0 });
      assert.deepEqual(record.citations.resolved, [{ id: "S1", count: 3, status: "fetched" }]);
      assert.deepEqual(record.citations.unfetched, []);
      assert.deepEqual(record.citations.unresolved, []);

      const { run, report, sources } = await readResearchRun(record.runId, { rootDir });
      assert.equal(run.status, RUN_STATUS.COMPLETED);
      assert.match(report, /^## 摘要/);
      assert.match(report, /来源: 共 1 条，已读取 1/);
      assert.equal(sources.length, 1);
      assert.equal(sources[0].id, "S1");
      assert.equal(sources[0].status, "fetched");
      assert.equal(sources[0].httpStatus, 200);
      assert.equal(sources[0].finalUrl, `${baseUrl}/article`);
      assert.ok(sources[0].publishedAt, "the page date is carried into the ledger");
      assert.equal(sources[0].publishedAtConfidence, "verified");

      const transcript = await readFile(join(rootDir, record.runId, "transcript.md"), "utf8");
      assert.match(transcript, /research_web_search/);
      assert.match(transcript, /research_read_page/);

      // Exactly one search and one page request reached the fixture.
      const requests = fixture.requests.slice(before);
      assert.deepEqual(
        requests.map((request) => request.path).sort(),
        ["/article", "/hn"],
      );

      // The Pi session that ran is inspectable, and its own transcript matches.
      assert.equal(port.sessions.length, 1);
      assert.deepEqual(
        transcriptToolResults(port.sessions[0].session).map((entry) => entry.toolCallId),
        ["exec-search", "exec-read"],
      );
    } finally {
      port.disposeAll();
    }
  });

  test("a Pi tool timeout maps to completed_with_errors, a failed source and an unfetched citation", async (t) => {
    const rootDir = await tempRoot(t);
    const { read } = makeTools({ requestTimeoutMs: 250 });
    const reportWithCitation = REPORT.replaceAll("[S1]", "[S1]");
    const port = createPiPipelinePort({
      responses: [
        toolCallStep(TOOL.READ_PAGE, { url: `${baseUrl}/slow` }, { id: "timeout-read" }),
        textStep(reportWithCitation),
      ],
    });
    try {
      const record = await executeResearch(
        { topic: "timeout mapping" },
        { runtimePort: port, toolLayer: { tools: [read] }, rootDir },
      );

      assert.equal(record.status, RUN_STATUS.COMPLETED_WITH_ERRORS);
      assert.equal(record.paths.report, "report.md");
      assert.equal(record.tools.calls[0].status, "error");
      assert.equal(record.tools.calls[0].errorCode, ERROR_CODE.TIMEOUT);
      assert.equal(record.sourcesSummary.failed, 1);
      assert.deepEqual(record.sourcesSummary.failures, [{ id: "S1", code: ERROR_CODE.TIMEOUT }]);
      assert.deepEqual(record.citations.unfetched, [{ id: "S1", count: 3, status: "failed" }]);
      assert.ok(record.errors.some((error) => error.code === ERROR_CODE.TIMEOUT && error.phase === "sources"));
      assert.ok(record.errors.some((error) => error.code === ERROR_CODE.TIMEOUT && error.phase === "tools"));

      const { report, sources } = await readResearchRun(record.runId, { rootDir });
      assert.match(report, /## Citation audit/);
      assert.match(report, /引用了未成功读取的来源: S1×3/);
      assert.equal(sources[0].status, "failed");
      assert.equal(sources[0].error.code, ERROR_CODE.TIMEOUT);
    } finally {
      port.disposeAll();
    }
  });

  test("an external abort maps to cancelled and stops an in-flight Pi tool", async (t) => {
    const rootDir = await tempRoot(t);
    const { read } = makeTools({ requestTimeoutMs: 15_000 });
    const port = createPiPipelinePort({
      responses: [
        toolCallStep(TOOL.READ_PAGE, { url: `${baseUrl}/slow` }, { id: "cancel-read" }),
        textStep(REPORT),
      ],
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    t.after(() => clearTimeout(timer));
    try {
      const started = Date.now();
      const record = await executeResearch(
        { topic: "abort mapping" },
        { runtimePort: port, toolLayer: { tools: [read] }, rootDir, signal: controller.signal },
      );
      const elapsed = Date.now() - started;

      assert.equal(record.status, RUN_STATUS.CANCELLED);
      assert.equal(record.paths.report, null);
      assert.ok(elapsed < 5000, `cancellation must not wait for the slow tool (${elapsed}ms)`);
      assert.ok(record.errors.some((error) => error.code === ERROR_CODE.ABORTED && error.phase === "cancel"));
      assert.equal(record.tools.calls[0].status, "error");
      assert.equal(record.tools.calls[0].errorCode, ERROR_CODE.ABORTED);
      const { run } = await readResearchRun(record.runId, { rootDir });
      assert.equal(run.status, RUN_STATUS.CANCELLED);
    } finally {
      port.disposeAll();
    }
  });
});
