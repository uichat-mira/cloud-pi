/**
 * Report + source-ledger tests (AGT-028, offline). The ledger must be built from
 * tool provenance only, citations must resolve against it, and duplicate final
 * URLs must collapse into one source with aliases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReportMarkdown,
  buildSourcesMarkdown,
  collectCitations,
  createSourceLedger,
  extractReportBody,
  resolveCitations,
  summarizeSources,
} from "../src/research/report.mjs";
import { SOURCE_STATUS } from "../src/research/contracts.mjs";

const RUN_ID = "r-20261102T090000-abcdef";

const SEARCH_DETAILS = {
  status: "ok",
  provider: "bing-rss",
  timeRange: "48h",
  timeRangeApplied: "provider_hint",
  query: "AI agent engineering",
  results: [
    {
      title: "Agent framework 1.0",
      url: "https://publisher.example/agent-framework",
      snippet: "Release notes with dates.",
      publishedAt: "2026-11-01T08:00:00.000Z",
      siteName: "publisher.example",
      dateSource: "provider",
      dateConfidence: "unverified",
    },
    {
      title: "Undated analysis",
      url: "https://analysis.example/undated",
      snippet: "No date.",
      publishedAt: null,
      siteName: "analysis.example",
      dateSource: "none",
      dateConfidence: "none",
    },
  ],
  count: 2,
  pagesFetched: 1,
  injectionSignals: [],
};

const PAGE_OK = {
  status: "ok",
  url: "https://publisher.example/agent-framework",
  finalUrl: "https://publisher.example/agent-framework?ref=rss",
  httpStatus: 200,
  contentType: "text/html",
  bytes: 42_000,
  charset: "utf-8",
  title: "Agent framework 1.0 released",
  siteName: "publisher.example",
  publishedAt: "2026-11-01T08:00:00.000Z",
  dateSource: "page",
  dateConfidence: "verified",
  accessedAt: "2026-11-02T09:00:05.000Z",
  excerpt: "The framework now supports streamed tool execution.",
  contentChars: 1200,
  truncated: false,
  redirects: [],
  extractor: "readability",
  injectionSignals: [],
};

const PAGE_FAILED = {
  status: "error",
  url: "https://analysis.example/undated",
  finalUrl: "https://analysis.example/undated",
  httpStatus: 403,
  contentType: null,
  bytes: 0,
  redirects: [],
  elapsedMs: 250,
  injectionSignals: [],
  error: { code: "http_error", message: "HTTP 403", retryable: false },
};

test("extractReportBody rejects missing/empty/thin text and unwraps one fence", () => {
  assert.equal(extractReportBody(undefined), null);
  assert.equal(extractReportBody(""), null);
  assert.equal(extractReportBody("   \n\t "), null);
  assert.equal(extractReportBody("done"), null);
  assert.equal(
    extractReportBody("这是一段没有任何 Markdown 结构的普通文本，长度足够但不满足报告格式。"),
    null,
  );
  assert.equal(
    extractReportBody("## 摘要\n\n- 一条有引用的事实 [S1]\n\n## 关键进展\n\n正文足够长。"),
    "## 摘要\n\n- 一条有引用的事实 [S1]\n\n## 关键进展\n\n正文足够长。",
  );
  assert.equal(
    extractReportBody(
      "```markdown\n## 摘要\n\n这是一份用围栏包裹的、内容足够长的报告正文，用于验证解包逻辑。\n```",
    ),
    "## 摘要\n\n这是一份用围栏包裹的、内容足够长的报告正文，用于验证解包逻辑。",
  );
});

test("collectCitations counts duplicates in first-appearance order", () => {
  assert.deepEqual(collectCitations("x [S2] y [S1] z [S2] [S10]"), [
    { id: "S2", count: 2 },
    { id: "S1", count: 1 },
    { id: "S10", count: 1 },
  ]);
  assert.deepEqual(collectCitations("no citations"), []);
});

test("ledger is built from tool details: fetched / failed / not_fetched", () => {
  const ledger = createSourceLedger();
  const annotations = ledger.addSearch(SEARCH_DETAILS);
  assert.deepEqual(
    annotations.map((entry) => [entry.id, entry.url]),
    [
      ["S1", "https://publisher.example/agent-framework"],
      ["S2", "https://analysis.example/undated"],
    ],
  );

  const fetched = ledger.addPage(PAGE_OK);
  assert.equal(fetched.id, "S1");
  assert.equal(fetched.status, SOURCE_STATUS.FETCHED);

  const failed = ledger.addPage(PAGE_FAILED);
  assert.equal(failed.id, "S2");
  assert.equal(failed.status, SOURCE_STATUS.FAILED);

  const sources = ledger.snapshot();
  assert.equal(sources.length, 2);
  assert.equal(sources[0].id, "S1");
  assert.equal(sources[0].status, SOURCE_STATUS.FETCHED);
  assert.equal(sources[0].finalUrl, "https://publisher.example/agent-framework?ref=rss");
  assert.equal(sources[0].httpStatus, 200);
  assert.equal(sources[0].contentChars, 1200);
  assert.equal(sources[0].publishedAtConfidence, "verified");
  assert.deepEqual(sources[0].aliases, ["https://publisher.example/agent-framework?ref=rss"]);
  assert.equal(sources[1].status, SOURCE_STATUS.FAILED);
  assert.equal(sources[1].error.code, "http_error");
});

test("a page read without a search hit creates its own source", () => {
  const ledger = createSourceLedger();
  const annotation = ledger.addPage({
    ...PAGE_OK,
    url: "https://direct.example/read",
    finalUrl: "https://direct.example/read",
  });
  assert.equal(annotation.id, "S1");
  const [source] = ledger.snapshot();
  assert.equal(source.kind, "page");
  assert.equal(source.status, SOURCE_STATUS.FETCHED);
  assert.equal(source.publishedAtConfidence, "verified");
});

test("identical final URLs collapse into one source with aliases", () => {
  const ledger = createSourceLedger();
  ledger.addPage({
    ...PAGE_OK,
    url: "https://a.example/start",
    finalUrl: "https://canonical.example/article",
  });
  ledger.addPage({
    ...PAGE_OK,
    url: "https://b.example/start",
    finalUrl: "https://canonical.example/article",
  });
  const sources = ledger.snapshot();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "S1");
  assert.equal(sources[0].finalUrl, "https://canonical.example/article");
  // The first observed URL stays the source url; every other URL is an alias.
  assert.equal(sources[0].url, "https://a.example/start");
  assert.ok(sources[0].aliases.includes("https://b.example/start"));
  assert.ok(sources[0].aliases.includes("https://canonical.example/article"));
});

test("citation resolution flags unknown and unfetched references", () => {
  const ledger = createSourceLedger();
  ledger.addSearch(SEARCH_DETAILS);
  ledger.addPage(PAGE_OK);
  const sources = ledger.snapshot();
  const citations = resolveCitations(
    "事实 [S1] 与 [S2]，另有不存在 [S9] 和重复 [S1]。",
    sources,
  );
  assert.deepEqual(citations.references, [
    { id: "S1", count: 2 },
    { id: "S2", count: 1 },
    { id: "S9", count: 1 },
  ]);
  assert.deepEqual(citations.unresolved, [{ id: "S9", count: 1 }]);
  assert.deepEqual(
    citations.resolved.map((entry) => [entry.id, entry.status]),
    [
      ["S1", SOURCE_STATUS.FETCHED],
      ["S2", SOURCE_STATUS.NOT_FETCHED],
    ],
  );
  assert.deepEqual(citations.unfetched.map((entry) => entry.id), ["S2"]);
});

test("model-claimed URLs never become sources", () => {
  const ledger = createSourceLedger();
  ledger.addSearch(SEARCH_DETAILS);
  const sources = ledger.snapshot();
  const body = "报告提到一个编造来源 [S1] 与 https://fake.example/invented [S9]。";
  const citations = resolveCitations(body, sources);
  assert.ok(!JSON.stringify(sources).includes("fake.example"));
  assert.deepEqual(citations.unresolved, [{ id: "S9", count: 1 }]);
});

test("report.md gets a citation audit and a provenance footer", () => {
  const ledger = createSourceLedger();
  ledger.addSearch(SEARCH_DETAILS);
  ledger.addPage(PAGE_FAILED);
  const sources = ledger.snapshot();
  const body = "## 摘要\n\n- 一条事实 [S1]，一条无法解析 [S9]。";
  const citations = resolveCitations(body, sources);
  const markdown = buildReportMarkdown({
    body,
    runId: RUN_ID,
    generatedAt: "2026-11-02T09:01:00.000Z",
    sources,
    citations,
    failures: [{ code: "http_error" }],
  });
  assert.match(markdown, /^## 摘要/);
  assert.match(markdown, /## Citation audit/);
  assert.match(markdown, /S9×1/);
  assert.match(markdown, new RegExp(RUN_ID));
  assert.match(markdown, /2026-11-02T09:01:00\.000Z/);
  assert.match(markdown, /来源: 共 2 条，已读取 0，读取失败 1，仅搜索命中 1/);
  assert.match(markdown, /失败项: 2 项/);
});

test("clean report has no citation audit section but keeps the footer", () => {
  const ledger = createSourceLedger();
  ledger.addSearch(SEARCH_DETAILS);
  ledger.addPage(PAGE_OK);
  const sources = ledger.snapshot();
  const body = "## 摘要\n\n- 一条事实 [S1]。";
  const citations = resolveCitations(body, sources);
  const markdown = buildReportMarkdown({
    body,
    runId: RUN_ID,
    generatedAt: "2026-11-02T09:01:00.000Z",
    sources,
    citations,
    failures: [],
  });
  assert.doesNotMatch(markdown, /Citation audit/);
  assert.match(markdown, /来源: 共 2 条/);
  assert.match(markdown, /失败项: 无/);
});

test("sources.md labels unverified dates and failed fetches honestly", () => {
  const ledger = createSourceLedger();
  ledger.addSearch(SEARCH_DETAILS);
  ledger.addPage(PAGE_FAILED);
  const sources = ledger.snapshot();
  const summary = summarizeSources(sources);
  assert.deepEqual(
    { total: summary.total, fetched: summary.fetched, failed: summary.failed, not_fetched: summary.not_fetched },
    { total: 2, fetched: 0, failed: 1, not_fetched: 1 },
  );
  const markdown = buildSourcesMarkdown({
    sources,
    runId: RUN_ID,
    generatedAt: "2026-11-02T09:01:00.000Z",
    failures: [],
  });
  assert.match(markdown, /发布时间（来源方自报，未核验）/);
  assert.match(markdown, /仅搜索命中（未读取）/);
  assert.match(markdown, /\[http_error\] HTTP 403/);
  assert.match(markdown, /仅用于发现线索，正文未读取/);
});
