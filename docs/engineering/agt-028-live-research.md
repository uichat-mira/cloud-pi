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

**Selected provider: Bing RSS (primary), Bing HTML (fallback), optional SearXNG**
(`RESEARCH_SEARXNG_URL`), which is the standard self-hosted metasearch API and
the only listed provider with native time-range filtering.

Bing ignores `filters=ex1:"ez1|ez2|ez3"` on the RSS endpoint (verified: identical
body). Therefore time filtering is applied **client-side on item `pubDate`**
against the requested window, and the run record states `timeRangeApplied:
"client_pubdate"`. When too few in-window items are returned, the tool fetches
subsequent result pages (`&first=11`, 21, …) up to `maxSearchPages`.

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

`run.json` is written when the run starts (`status: running`) and rewritten at
every state transition, so a crash leaves evidence rather than silence.
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
| `RESEARCH_SEARCH_PROVIDER` | `auto` (default), `bing-rss`, `bing-html`, `searxng` |
| `RESEARCH_SEARXNG_URL` | base URL of an operator-provided SearXNG instance |
| `RESEARCH_HTTPS_PROXY` | HTTP(S) proxy for tool traffic (falls back to `HTTPS_PROXY`) |
| `RESEARCH_AGENT_RUNTIME_MODULE` | AGT-027 runtime module specifier (temporary integration shim) |

No secret is read, logged or persisted by this feature.

## 10. Live acceptance (pending AGT-027)

Blocked until AGT-027 is on `dev`. Procedure:

1. Rebase this branch on `dev`, delete temporary runtime shims, wire the official port.
2. Run the business topic **three independent times**:
   「研究最近 48 小时值得《见π》关注的 AI Agent 工程进展」
   with different run IDs / query angles.
3. For each run keep: run ID, timestamps, model ID (redacted), usage, tool-call
   counts, failures, report path, source ledger path.
4. Spot-check ≥3 substantive claims per report: open the final URL, confirm the
   body supports the claim, mark unsupported claims as pending verification.
5. Record failures (rate limits, unreachable pages, timeouts) verbatim.

No live claim may be made from fixture or scripted results.
