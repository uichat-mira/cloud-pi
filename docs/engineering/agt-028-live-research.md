# AGT-028 · Live web research

Status: implementation in progress (branch `feat/agt-028-live-research`, target `dev`).
Owning Issue: [#6](https://github.com/uichat-mira/cloud-pi/issues/6).
Dependency: [#5 / AGT-027](https://github.com/uichat-mira/cloud-pi/issues/5) supplies the real model runtime.

This document is the working design and evidence index. It must not claim live
acceptance before the AGT-027 runtime is on `dev` and real runs have happened.

## 1. Scope and ownership

AGT-028 owns, in this order:

1. **Research tools** — two model-callable, read-only Pi tools: real web search and
   real page reading, with timeouts, cancellation, limits and classified failures.
2. **Research execution** — a single-run executor that drives one Pi session through
   the AGT-027 runtime port and turns the transcript into artifacts.
3. **Artifacts** — Markdown report, independent source ledger, run record, usage;
   persisted locally and readable by run ID.
4. **Execution interface** — a stable call boundary (`executeResearch` /
   `readResearchRun`) for a future scheduler and Feishu delivery. No scheduler,
   no Feishu, no publishing in this Issue.

Out of scope: model provider, Pi session assembly, credentials, MCP, scheduling,
Feishu, Cloud Auth delegation, deployment, article publication.

**Never duplicate AGT-027.** The executor depends on an injected port
(`src/research/port.mjs`). If the port is absent the live path fails closed with
`runtime_unavailable`; tests inject a scripted port.

## 2. Module layout

```
src/research/
  contracts.mjs      frozen enums, limits, error taxonomy, env names (this team)
  port.mjs           AGT-027 runtime port contract + loader
  runtime/agt-027.mjs thin adapter: official createAgentRuntime().run() → port
                     (system prompt via before_agent_start, isolated cwd, budgets)
  tools/search.mjs   research_web_search (Pi ToolDefinition)
  tools/read-page.mjs research_read_page (Pi ToolDefinition)
  net/http.mjs       bounded HTTP: proxy, timeout, redirects, size cap, abort
  net/url-safety.mjs URL validation + private-address blocking (SSRF)
  net/rss.mjs        minimal RSS/Atom item parser
  extract/html.mjs   HTML → title/text/date extraction (linkedom + Readability)
  untrusted.mjs      untrusted-content fencing/sanitising + injection detection
  prompt.mjs         research system prompt + brief + report instructions
  execute.mjs        executeResearch(request, deps) orchestration
  run-store.mjs      run directory persistence and read-by-id
  report.mjs         report/source materialisation, citation validation
  index.mjs          public API for scheduler/Feishu integration
scripts/research.mjs CLI: live run + read
```

Tests live in `tests/`; fixtures in `tests/helpers/`.

## 3. Real search source

Verified by live probes on 2026-11-02 (host proxy `127.0.0.1:1080`):

| Endpoint | Result |
| --- | --- |
| `https://www.bing.com/search?q=…&format=rss` | 200, 10 items, title/link/description/**pubDate**, direct publisher URLs |
| `https://www.bing.com/search?q=…` (HTML) | 200, 10 `b_algo` results; URLs wrapped in `bing.com/ck/a?…u=a1<base64url>` |
| `https://news.google.com/rss/search?q=…` | 200, 100 items, dates, but links are JS-wrapped Google redirects → not fetchable |
| `https://html.duckduckgo.com/html/…` | 202 antibot challenge |
| public SearXNG instances | antibot challenge |
| Brave / Tavily / Serper | API key required (none provided) |

**Selected providers.** `auto` runs **Hacker News (Algolia)** and **Bing RSS**,
merges and de-duplicates the result sets, then falls back to Bing HTML and to an
operator-provided **SearXNG** instance (`RESEARCH_SEARXNG_URL`) when needed.

| Provider | Why | Date trust |
| --- | --- | --- |
| `hackernews` | public Algolia API, keyless, real ISO `created_at`, direct publisher URLs, real engineering signal for "最近 48 小时" | **verified** (`dateSource: "provider"`, HN submission time) |
| `bing-rss` | general web, direct publisher URLs, `pubDate` present | **unverified hint** (`dateConfidence: "unverified"`) |
| `bing-html` | same engine without RSS; parsed `li.b_algo`, `ck/a` links decoded | mostly absent |
| `searxng` | operator-run metasearch JSON, native `time_range` | provider |

**Date honesty is mandatory.** Live probing showed Bing RSS `pubDate` on
evergreen pages equals a recent crawl date (e.g. `en.wikipedia.org/wiki/Anthropic`
→ today), so a provider date is never presented as a publication date. The tool
marks every result with `dateSource`/`dateConfidence`; only page metadata read by
`research_read_page` is treated as verified (`dateSource: "page"`).

**Time window.** HN uses an epoch cutoff (`numericFilters=created_at_i>…`). Bing
ignores `filters=ex1:"ez1|ez2|ez3"` (verified: identical body), so its window is
applied client-side over the provider hint and stated as
`timeRangeApplied: "provider_hint"`. Undated hits are **not silently dropped**:
they are retained with `publishedAt: null`, `dateConfidence: "none"` and counted
(`undatedIncluded` / `undatedDropped`); the call then reports
`timeRangeApplied: "partial"`. When too few in-window items are returned the tool
pages further (`&first=11`, 21, …) up to `maxSearchPages`.

Honesty rule: a search result is discovery evidence only. A claim may only be
cited as fact when its page body was actually fetched; unfetched hits are
`not_fetched` in the source ledger.

## 4. Real page reading

- Scheme allow-list `http:`/`https:`; block credentials in URL, `localhost`,
  `*.local`, `*.internal`, and all private/loopback/link-local IPv4+IPv6 ranges,
  including addresses resolved via DNS (rebinding check).
- Manual redirect chain (≤5), record **final URL**, status, content type, bytes.
- Cap response bytes (2 MB) and extracted characters (`maxCharsPerPage`).
- `text/html`, `text/plain`, `application/xhtml+xml` are read; PDF/binary return
  `unsupported_content_type` rather than a fake body.
- Extraction: `linkedom` DOM + `@mozilla/readability` for main content; fallback to
  body text. Record title, site name, published time when visible, excerpt.
- Every failure is `{code, message}` from the frozen taxonomy; never silently empty.

### Untrusted content policy

Search snippets and page text are data. They are fenced in
`<untrusted_web_content source="…">…</untrusted_web_content>`, with fence
sequences escaped, control/zero-width/bidi characters stripped, and length
capped. Obvious injection patterns are recorded in `details.injectionSignals`
for audit but the content is still passed through for evaluation. The system
prompt states the policy explicitly; the tool set contains no write, shell,
network-write or publishing capability.

## 5. Artifacts

Root: `RESEARCH_RUNS_DIR` or `.work/research-runs/<runId>/` (gitignored).

```
run.json        request, status, timings, model, usage, limits, error list,
                tool-call ledger, paths, contract version
report.md       final Markdown report (model output, served from the transcript)
sources.json    source ledger: id, kind, title, url, finalUrl, status,
                httpStatus, publishedAt, accessedAt, excerpt, error
sources.md      human-readable source list
transcript.md   sanitised tool/assistant trace (no secrets)
```

`run.json` is written when the run starts (`status: running`) and again when the
run finalises (with `statusHistory`), so a crash mid-run still leaves evidence.
`readResearchRun(runId, {rootDir})` returns `{run, report, sources}` and fails
with a classified error for unknown/corrupt runs.

Statuses: `running → completed | completed_with_errors | failed | cancelled | timeout`.
A report with failed tool calls is `completed_with_errors`, never `completed`.

## 6. AGT-027 runtime port

See `src/research/port.mjs`. Executor calls exactly one method:

```js
runAgent({ systemPrompt, prompt, customTools, limits, signal, onEvent, metadata })
  → { status, text, usage, toolCalls, error? }
```

Requirements recorded here for AGT-027 sync: tools are Pi `ToolDefinition`
objects passed as `customTools`; per-tool execution must honour the tool's own
`signal`; token usage must be reported or explicitly `unknown`; runtime errors
must map to `model_error`/`timeout`/`cancelled`. The executor does not read
provider env, keys or model names.

## 7. Execution interface (for scheduler / Feishu)

```js
import { executeResearch, readResearchRun, startResearch } from "./src/research/index.mjs";

const record = await executeResearch({ topic, goal, timeRange, limits }, deps);
const { run, report, sources } = readResearchRun(runId, { rootDir });
```

`deps` = `{ runtimePort, toolLayer?, store?, now?, logger?, signal? }`.
All external effects are injectable; the default wiring is production (real
network + real runtime) and tests use fixtures.

## 8. Test layers

- **T1** unit: RSS/HTML parsing, URL safety, limits, citation validation, store
  round-trip, status transitions.
- **T2** negative: timeout, abort, DNS/connect failure, HTTP error, oversized
  body, unsupported content type, SSRF attempts, injection fencing, budget
  exhaustion, corrupt run directory.
- **T3** Pi pipeline: real `createAgentSession` + `fauxProvider` scripted model
  calling the real custom tools against a local fixture server; asserts the tool
  executes through the SDK (`tool_call`/`tool_result`), cancellation and error
  mapping. Test-only; not live evidence.
- **Live gate** (never in CI): `node scripts/research.mjs --topic …` against real
  search + real pages + real AGT-027 runtime.

## 9. Environment

| Variable | Meaning |
| --- | --- |
| `RESEARCH_RUNS_DIR` | artifact root (default `.work/research-runs`) |
| `RESEARCH_SEARCH_PROVIDER` | `auto` (default), `hackernews`, `bing-rss`, `bing-html`, `searxng` |
| `RESEARCH_SEARXNG_URL` | base URL of an operator-provided SearXNG instance |
| `RESEARCH_HTTPS_PROXY` | HTTP(S) proxy for tool traffic (falls back to `HTTPS_PROXY`) |
| `RESEARCH_AGENT_RUNTIME_MODULE` | AGT-027 runtime module path; after AGT-027 lands on `dev`, `src/index.mjs` is used automatically |

No secret is read, logged or persisted by this feature.

## 10. Live acceptance

Status: **done against AGT-027's runtime branch** (PR #8, `feat/agt-027-live-agent`);
the only remaining step is the post-merge rebase described in §11.

Procedure (executed 2026-11-02, see `docs/evidence/agt-028/README.md`):

1. Wire the official runtime through `src/research/runtime/agt-027.mjs` (no shim
   session, no provider, no credential code).
2. Run the business topic three independent times:
   「研究最近 48 小时值得《见π》关注的 AI Agent 工程进展」, 48h window,
   different budgets and run IDs.
3. Keep per run: run ID, timings, model ID, real usage, tool-call counts,
   failures, report and source-ledger paths.
4. Spot-check substantive claims per report against the live page.
5. Record failures (403, unreachable pages, timeouts) verbatim.

No live claim may be made from fixture or scripted results.

## 11. Post-merge integration

Once AGT-027 is on `dev`, its runtime entry is the sibling `src/index.mjs`; the
port loader resolves it automatically (explicit `RESEARCH_AGENT_RUNTIME_MODULE`
or `--runtime-module` still wins). Then: rebase this branch, re-run
`npm test`, run one live smoke run per the commands in `docs/evidence/agt-028/README.md`,
and hand the PR to Mira for final acceptance and merge.
