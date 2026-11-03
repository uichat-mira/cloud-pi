/**
 * Adversarial verification of AGT-028 artifacts, provenance and the live
 * boundary (verifier-owned).
 *
 * Uses the real run store, report builder and executor with loopback fixture
 * tools. No model, no external network: the runtime port is a scripted test
 * double, exactly as in T2. The point here is adversarial input, not a happy
 * path.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendHtml, startFixtureServer } from "./helpers/fixture-server.mjs";
import { assertNoNetworkEgress } from "./helpers/session-harness.mjs";
import { executeResearch } from "../src/research/execute.mjs";
import { listResearchRuns, readResearchRun } from "../src/research/index.mjs";
import { RUNTIME_PORT_VERSION, RuntimeUnavailableError, loadAgentRuntimePort } from "../src/research/port.mjs";
import { RunStoreError, createRunStore } from "../src/research/run-store.mjs";
import { ERROR_CODE, RUN_STATUS, TOOL } from "../src/research/contracts.mjs";
import { createReadPageTool } from "../src/research/tools/read-page.mjs";
import { createWebSearchTool } from "../src/research/tools/search.mjs";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../scripts/research.mjs", import.meta.url));
const RUN_ID = "r-20261102T090000-abcdef";

const dummyTool = (name) => ({
  name,
  label: name,
  description: "dummy adapter tool",
  parameters: {},
  async execute() {
    return { content: [{ type: "text", text: "dummy" }], isError: false };
  },
});

const REPORT = [
  "## 摘要",
  "",
  "- 来源给出了一项事实 [S1]。",
  "",
  "## 关键进展",
  "",
  "- 细节说明 [S1]。",
  "",
  "## 来源与证据",
  "",
  "- [S1] 支撑摘要。",
  "",
  "## 不确定性/失败项",
  "",
  "- 无。",
].join("\n");

let fixture;
let baseUrl;

before(async () => {
  fixture = await startFixtureServer({
    "/article": (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>Agent article</title><meta property="article:published_time" content="2026-11-01T10:00:00Z"></head><body><article><h1>Agent article</h1>${Array.from(
          { length: 12 },
          (_, index) =>
            `<p>Paragraph ${index + 1}. Agent engineering details, evaluation notes and release evidence. Careful analysis of tool use and limits.</p>`,
        ).join("")}</article></body></html>`,
      );
    },
    "/secret-headers": (req, res) => {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "session=SECRET-SET-COOKIE; HttpOnly",
        authorization: "Bearer SECRET-RESPONSE-AUTH",
        "x-api-key": "SECRET-RESPONSE-APIKEY",
      });
      res.end(
        `<!doctype html><html><head><title>Headers</title></head><body><article><h1>Headers</h1>${Array.from(
          { length: 12 },
          (_, index) => `<p>Paragraph ${index + 1}. Agent engineering details and release evidence for the header test.</p>`,
        ).join("")}</article></body></html>`,
      );
    },
    "/meta": (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>Meta versus body</title><meta name="description" content="META-DESCRIPTION-MARKER ${"m".repeat(200)}"></head><body><article><h1>Meta versus body</h1>${Array.from(
          { length: 8 },
          (_, index) => `<p>BODY-MARKER paragraph ${index + 1}. The ledger excerpt must come from the read body, not the page meta description.</p>`,
        ).join("")}</article></body></html>`,
      );
    },
    "/hn": (req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          hits: [
            {
              objectID: "1",
              title: "Agent story",
              url: `${baseUrl}/article`,
              created_at: "2026-11-01T10:00:00.000Z",
              author: "fixture",
              points: 1,
              num_comments: 0,
            },
          ],
        }),
      );
    },
  });
  baseUrl = fixture.url;
});

after(async () => {
  await fixture?.close();
  assertNoNetworkEgress();
});

function makeTools() {
  return {
    search: createWebSearchTool({
      provider: "hackernews",
      endpoints: { hackernews: `${baseUrl}/hn` },
      env: {},
      proxyUrl: null,
      retryTransient: false,
    }),
    read: createReadPageTool({
      allowLoopback: true,
      env: {},
      proxyUrl: null,
      retryTransient: false,
    }),
  };
}

/** Scripted runtime port: calls the executor's wrapped tools itself. */
function scriptedPort(handler) {
  return {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent(spec) {
      const byName = new Map(spec.customTools.map((tool) => [tool.name, tool]));
      const toolCalls = [];
      const call = async (name, params = {}) => {
        const tool = byName.get(name);
        if (!tool) throw new Error(`scripted runtime: ${name} is not exposed`);
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
      return handler({ call, toolCalls });
    },
  };
}

const USAGE = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  modelId: "scripted",
  providerId: "scripted",
  source: "provider",
};

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "cloud-pi-t3-art-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function artifactText(rootDir, runId) {
  const files = await readdir(join(rootDir, runId));
  const entries = [];
  for (const file of files.sort()) {
    entries.push([file, await readFile(join(rootDir, runId, file), "utf8")]);
  }
  return entries;
}

describe("adversarial: run store and tampered artifacts", () => {
  test("unknown, invalid and corrupt runs are classified, never guessed", async (t) => {
    const rootDir = await tempRoot(t);
    const store = createRunStore({ rootDir });

    await assert.rejects(readResearchRun(RUN_ID, { rootDir }), (error) => {
      assert.ok(error instanceof RunStoreError);
      assert.equal(error.code, "not_found");
      return true;
    });
    for (const invalid of ["", "../etc", "r-2026-abc", "r-20261102T090000-ABCDEF"]) {
      await assert.rejects(readResearchRun(invalid, { rootDir }), (error) => {
        assert.equal(error.code, "invalid_run_id");
        return true;
      });
    }

    // Corrupt JSON and a tampered but syntactically valid record.
    const dir = join(rootDir, RUN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), "{ not json");
    await assert.rejects(readResearchRun(RUN_ID, { rootDir }), (error) => {
      assert.equal(error.code, "parse_error");
      return true;
    });

    const tampered = [
      ["wrong run id", { contractVersion: 1, runId: "r-20261102T090000-999999", status: "completed", createdAt: "2026-11-02T09:00:00.000Z", request: { topic: "x" }, paths: {}, errors: [] }],
      ["unknown status", { contractVersion: 1, runId: RUN_ID, status: "done", createdAt: "2026-11-02T09:00:00.000Z", request: { topic: "x" }, paths: {}, errors: [] }],
      ["missing version", { runId: RUN_ID, status: "completed", createdAt: "2026-11-02T09:00:00.000Z", request: { topic: "x" }, paths: {}, errors: [] }],
      ["bad createdAt", { contractVersion: 1, runId: RUN_ID, status: "completed", createdAt: "yesterday", request: { topic: "x" }, paths: {}, errors: [] }],
      ["missing topic", { contractVersion: 1, runId: RUN_ID, status: "completed", createdAt: "2026-11-02T09:00:00.000Z", request: {}, paths: {}, errors: [] }],
      ["missing errors", { contractVersion: 1, runId: RUN_ID, status: "completed", createdAt: "2026-11-02T09:00:00.000Z", request: { topic: "x" }, paths: {} }],
    ];
    for (const [label, record] of tampered) {
      await writeFile(join(dir, "run.json"), JSON.stringify(record));
      await assert.rejects(readResearchRun(RUN_ID, { rootDir }), (error) => {
        assert.equal(error.code, "parse_error", label);
        return true;
      }, label);
    }

    // Valid tampered paths must not turn readResearchRun into a file-disclosure primitive.
    await writeFile(
      join(dir, "run.json"),
      JSON.stringify({
        contractVersion: 1,
        runId: RUN_ID,
        status: "completed",
        createdAt: "2026-11-02T09:00:00.000Z",
        request: { topic: "x" },
        paths: { report: "../../../../etc/passwd", sources: "/etc/passwd" },
        errors: [],
      }),
    );
    const { report, sources } = await readResearchRun(RUN_ID, { rootDir });
    assert.equal(report, null, "paths are display metadata; artifacts are read by fixed name");
    assert.equal(sources, null);

    // A corrupt run directory must not hide a healthy one from listResearchRuns.
    await writeFile(join(dir, "run.json"), "{ corrupt");
    await store.createRun({
      contractVersion: 1,
      runId: "r-20261102T100000-111111",
      status: "completed",
      createdAt: "2026-11-02T10:00:00.000Z",
      request: { topic: "healthy" },
      paths: {},
      errors: [],
    });
    const listed = await listResearchRuns({ rootDir });
    assert.deepEqual(listed.map((run) => run.runId), ["r-20261102T100000-111111"]);
  });

  test("corrupt sources.json is parse_error, not an empty provenance list", async (t) => {
    const rootDir = await tempRoot(t);
    const store = createRunStore({ rootDir });
    await store.createRun({
      contractVersion: 1,
      runId: RUN_ID,
      status: "completed",
      createdAt: "2026-11-02T09:00:00.000Z",
      request: { topic: "sources" },
      paths: {},
      errors: [],
    });
    await writeFile(join(rootDir, RUN_ID, "sources.json"), '{"sources": {"not": "an array"}}');
    await assert.rejects(readResearchRun(RUN_ID, { rootDir }), (error) => error.code === "parse_error");
    await writeFile(join(rootDir, RUN_ID, "sources.json"), "[]broken");
    await assert.rejects(readResearchRun(RUN_ID, { rootDir }), (error) => error.code === "parse_error");
  });
});

describe("adversarial: citations and fabricated provenance", () => {
  test("a citation to a source that was never fetched is audited, not treated as evidence", async (t) => {
    const rootDir = await tempRoot(t);
    const { search } = makeTools();
    const port = scriptedPort(async ({ call, toolCalls }) => {
      // Search only: the model cites S1 without ever reading the page.
      await call(TOOL.SEARCH, { query: "agent" });
      return {
        status: "completed",
        text: `${REPORT}\n\n- 另一处引用了不存在的来源 [S9]。`,
        usage: USAGE,
        toolCalls,
      };
    });
    const record = await executeResearch(
      { topic: "unfetched citation" },
      { runtimePort: port, toolLayer: { tools: [search] }, rootDir },
    );

    assert.equal(record.status, RUN_STATUS.COMPLETED_WITH_ERRORS);
    assert.ok(record.errors.some((error) => error.phase === "citations"));
    assert.equal(record.sourcesSummary.not_fetched, 1);
    assert.deepEqual(record.citations.unfetched, [{ id: "S1", count: 3, status: "not_fetched" }]);
    assert.deepEqual(record.citations.unresolved, [{ id: "S9", count: 1 }]);

    const { report, sources } = await readResearchRun(record.runId, { rootDir });
    assert.equal(sources[0].status, "not_fetched");
    assert.match(report, /## Citation audit/);
    assert.match(report, /未解析引用（来源清单中不存在）: S9×1/);
    assert.match(report, /引用了未成功读取的来源: S1×3/);
    const sourcesMarkdown = await readFile(join(rootDir, record.runId, "sources.md"), "utf8");
    assert.match(sourcesMarkdown, /仅用于发现线索，正文未读取，不可作为事实依据/);
  });

  test("the persisted ledger excerpt is the read body, not the page meta description (t4)", async (t) => {
    const rootDir = await tempRoot(t);
    const read = createReadPageTool({ allowLoopback: true, env: {}, proxyUrl: null, retryTransient: false });
    const port = scriptedPort(async ({ call, toolCalls }) => {
      await call(TOOL.READ_PAGE, { url: `${baseUrl}/meta` });
      return { status: "completed", text: REPORT, usage: USAGE, toolCalls };
    });
    const record = await executeResearch(
      { topic: "excerpt provenance" },
      { runtimePort: port, toolLayer: { tools: [read] }, rootDir },
    );
    assert.equal(record.status, RUN_STATUS.COMPLETED);
    assert.equal(record.sourcesSummary.fetched, 1);
    const persisted = JSON.parse(await readFile(join(rootDir, record.runId, "sources.json"), "utf8"));
    assert.match(persisted.sources[0].excerpt, /BODY-MARKER/);
    assert.ok(!persisted.sources[0].excerpt.includes("META-DESCRIPTION-MARKER"));
    const sourcesMarkdown = await readFile(join(rootDir, record.runId, "sources.md"), "utf8");
    assert.match(sourcesMarkdown, /摘要: .*BODY-MARKER/);
    assert.ok(!sourcesMarkdown.includes("META-DESCRIPTION-MARKER"));
  });

  test("a URL the model merely wrote in its text never becomes a source", async (t) => {
    const rootDir = await tempRoot(t);
    const port = scriptedPort(async () => ({
      status: "completed",
      text: `${REPORT.replaceAll("[S1]", "")}\n\n- 参考 [伪造来源](https://fabricated.example/secret-report)。`,
      usage: USAGE,
      toolCalls: [],
    }));
    const record = await executeResearch(
      { topic: "fabricated url" },
      { runtimePort: port, toolLayer: { tools: [dummyTool("research_web_search")] }, rootDir },
    );

    assert.equal(record.status, RUN_STATUS.COMPLETED);
    assert.deepEqual(record.sourcesSummary, {
      total: 0,
      fetched: 0,
      failed: 0,
      not_fetched: 0,
      failures: [],
    });
    const { report, sources } = await readResearchRun(record.runId, { rootDir });
    assert.deepEqual(sources, [], "no tool returned a source, so the ledger is empty");
    assert.match(report, /fabricated\.example/, "the model's text is preserved for review");
    assert.match(report, /来源: 共 0 条/);
    const record_a = await readFile(join(rootDir, record.runId, "sources.json"), "utf8");
    assert.ok(!record_a.includes("fabricated.example"), "a model-written URL must not enter the ledger");
    const run = await readFile(join(rootDir, record.runId, "run.json"), "utf8");
    assert.ok(!run.includes("fabricated.example"), "a model-written URL must not enter run.json");
  });
});

describe("adversarial: secrets and the live boundary", () => {
  test("credentials in HTTP request/response headers never reach persisted artifacts", async (t) => {
    const rootDir = await tempRoot(t);
    const read = createReadPageTool({
      allowLoopback: true,
      env: { RESEARCH_HTTPS_PROXY: "http://user:PROXY-SECRET@127.0.0.1:9" },
      proxyUrl: null,
      retryTransient: false,
    });
    const before = fixture.requests.length;
    const port = scriptedPort(async ({ call, toolCalls }) => {
      await call(TOOL.READ_PAGE, { url: `${baseUrl}/secret-headers` });
      return { status: "completed", text: REPORT, usage: USAGE, toolCalls };
    });
    const record = await executeResearch(
      { topic: "header hygiene" },
      { runtimePort: port, toolLayer: { tools: [read] }, rootDir },
    );
    assert.equal(record.status, RUN_STATUS.COMPLETED);

    const request = fixture.requests.slice(before).find((entry) => entry.path === "/secret-headers");
    assert.ok(request, "the fixture page was requested");
    for (const header of ["authorization", "cookie", "x-api-key", "proxy-authorization"]) {
      assert.equal(request.headers?.[header], undefined, `the tool must not send ${header}`);
    }

    const markers = ["SECRET-SET-COOKIE", "SECRET-RESPONSE-AUTH", "SECRET-RESPONSE-APIKEY", "PROXY-SECRET"];
    for (const [file, text] of await artifactText(rootDir, record.runId)) {
      for (const marker of markers) {
        assert.ok(!text.includes(marker), `${file} must not contain ${marker}`);
      }
    }
  });

  test("credential-looking runtime error text is redacted in run.json", async (t) => {
    const rootDir = await tempRoot(t);
    const marker = "sk-live-VERIFIER-SECRET-1234567890";
    const port = scriptedPort(async () => ({
      status: "failed",
      text: "",
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: "unknown" },
      toolCalls: [],
      error: { code: ERROR_CODE.MODEL_ERROR, message: `provider rejected ${marker} and token=TOPSECRETVALUE` },
    }));
    const record = await executeResearch(
      { topic: "runtime redaction" },
      { runtimePort: port, toolLayer: { tools: [dummyTool("research_web_search")] }, rootDir },
    );
    assert.equal(record.status, RUN_STATUS.FAILED);
    assert.equal(record.paths.report, null);
    for (const [file, text] of await artifactText(rootDir, record.runId)) {
      assert.ok(!text.includes(marker), `${file} must not contain the provider credential`);
      assert.ok(!text.includes("TOPSECRETVALUE"), `${file} must not contain the token value`);
    }
    assert.ok(record.errors.some((error) => error.message.includes("[redacted]")));
  });

  test("a token in a model-supplied URL must not be persisted into the source ledger", async (t) => {
    const rootDir = await tempRoot(t);
    const marker = "VERIFIER-URL-TOKEN-9f3c2a1b";
    const read = createReadPageTool({ allowLoopback: true, env: {}, proxyUrl: null, retryTransient: false });
    const port = scriptedPort(async ({ call, toolCalls }) => {
      await call(TOOL.READ_PAGE, { url: `${baseUrl}/article?access_token=${marker}` });
      return { status: "completed", text: REPORT, usage: USAGE, toolCalls };
    });
    const record = await executeResearch(
      { topic: "url token" },
      { runtimePort: port, toolLayer: { tools: [read] }, rootDir },
    );
    assert.equal(record.status, RUN_STATUS.COMPLETED);

    const leaks = [];
    for (const [file, text] of await artifactText(rootDir, record.runId)) {
      if (text.includes(marker)) leaks.push(file);
    }
    assert.deepEqual(leaks, [], `a token-bearing URL reached persisted artifacts: ${leaks.join(", ")}`);
  });

  test("an already-aborted external signal is visible to the runtime and the run is cancelled", async (t) => {
    const rootDir = await tempRoot(t);
    const controller = new AbortController();
    controller.abort();
    let sawAbortedSignal = null;
    const port = {
      portVersion: RUNTIME_PORT_VERSION,
      async runAgent(spec) {
        sawAbortedSignal = spec.signal?.aborted === true;
        return { status: "completed", text: REPORT, usage: USAGE, toolCalls: [] };
      },
    };
    const record = await executeResearch(
      { topic: "pre-aborted" },
      { runtimePort: port, toolLayer: { tools: [dummyTool("research_web_search")] }, rootDir, signal: controller.signal },
    );
    assert.equal(sawAbortedSignal, true, "the runtime must receive an already-aborted signal");
    assert.equal(record.status, RUN_STATUS.CANCELLED);
    assert.ok(record.errors.some((error) => error.code === ERROR_CODE.ABORTED));
    // The executor still invokes the port once even when the caller aborted
    // before start; a runtime that ignores the signal can therefore leave a
    // report artifact under a cancelled status (low-risk observation, see doc).
  });

  test("the live path fails closed without an AGT-027 runtime module and creates no run", async (t) => {
    const rootDir = await tempRoot(t);

    await assert.rejects(executeResearch({ topic: "no runtime" }, { rootDir }), (error) => {
      assert.ok(error instanceof RuntimeUnavailableError);
      assert.equal(error.code, ERROR_CODE.RUNTIME_UNAVAILABLE);
      return true;
    });
    assert.deepEqual(await readdir(rootDir), [], "a failed-closed run must not create a run directory");

    await assert.rejects(loadAgentRuntimePort({}), (error) => error.code === ERROR_CODE.RUNTIME_UNAVAILABLE);
    await assert.rejects(
      loadAgentRuntimePort({ moduleSpecifier: join(rootDir, "missing-runtime.mjs") }),
      (error) => error.code === ERROR_CODE.RUNTIME_UNAVAILABLE,
    );

    const env = { ...process.env };
    delete env.RESEARCH_AGENT_RUNTIME_MODULE;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI, "--topic", "live fail closed", "--runs-dir", rootDir],
      { env, cwd: dirname(CLI) },
    ).catch((error) => error);
    assert.equal(stdout ?? "", "");
    assert.match(stderr, /runtime_unavailable/);
    assert.equal(await readdir(rootDir).then((entries) => entries.length), 0);
  });
});
