# AGT-028 · Independent verification report

Status: **verification complete, with open findings**. This document records what
an independent verifier actually ran against the AGT-028 working tree, what
passed, what failed, and what remains unproven. It is not acceptance: the live
acceptance procedure in [agt-028-live-research.md](./agt-028-live-research.md#10-live-acceptance-pending-agt-027)
still needs real runs, and the Issue owner decides.

- Audited worktree: `/Users/tao/Desktop/workspace/cloud-pi-agt-028`
  (the main `cloud-pi` checkout was not modified).
- Audited at: 2026-11-02 17:30–18:00 +08:00.
- Environment: Node.js v22.23.2, npm 10.9.8, macOS; no proxy env vars set.
- No git command was run (per task constraints). The audited file content is
  pinned below by SHA-256 instead.
- T4 completed during this audit. Its excerpt-from-body and `extract_failed`
  behavior (`src/research/tools/read-page.mjs`, modified 17:43) was present for
  the final runs; the checks marked *(t4)* below were re-run against that final
  file.
- The captain reported a successful live run (`r-20261102T093914-e90abe`, 26
  sources, 3 fetched). That is **not** independent evidence from this audit; see
  “Not proven”.

## Audited artifacts (SHA-256)

```
c04987cb87b67e2f78f027b5e853323712ad0b8b96d073849402cacb78363cbe  src/research/execute.mjs
e4d3ad715617fd44d401007c1267ecbabe43d1f54fe41b138e1761119b4747fc  src/research/port.mjs
df9aa74d730311e5ad0bc5551a1edb5c6a595555460bcbcd8a8f7205cb707d3c  src/research/prompt.mjs
0af2a1f6e13dd43725bebd9ac8a1edfa1ba06bcc63237132c237fd94e87db330  src/research/runtime/agt-027.mjs
c560efad35aea11a55a0c6ec27fa40bfe89abbe0100c67226d8d94f8ee687e8a  src/research/contracts.mjs
960cc8bed318306e4e922a66219d81da5fe5e134a31e0adb93d2a932cf6db2c3  src/research/tools/read-page.mjs
7eae8ab174214ccc690e1c420cb5f26930258b23025344abf2fff6f870ec79ef  src/research/tools/search.mjs
```

## 1. What was added by this verification

| File | Purpose |
| --- | --- |
| `tests/helpers/session-harness.mjs` | real Pi session + faux model; scripted tool steps; Pi pipeline test port (`createPiPipelinePort`); automatic outbound-socket guard (`assertNoNetworkEgress`) |
| `tests/research-verify-pipeline.test.mjs` | T3: real `createAgentSession` + `fauxProvider` + the real research tools through Pi's tool pipeline; validation/timeout/abort/executor mapping |
| `tests/research-verify-adversarial.test.mjs` | SSRF matrix (19 URLs), DNS-rebinding check, redirect re-validation, credential URLs, fence collisions, hidden text, huge/gzip bodies, slow responses, 429/500 retries, unsupported types, t4 empty/JS-only extraction and excerpt provenance |
| `tests/research-verify-artifacts.test.mjs` | tampered/corrupt run store, citation audit, fabricated URLs, header/error secret hygiene, token-in-URL regression (F1), pre-aborted signal, live fail-closed |
| `tests/research-verify-adapter.test.mjs` | AGT-027 adapter through a fake AGT-027-shaped module that builds a **real** Pi session: system-prompt injection, temp-cwd isolation and cleanup, budget pass-through, status/usage/error mapping, port precedence, prompt policy |
| `docs/engineering/agt-028-verification.md` | this report |

No product code, `package.json`, or another member's test file was modified.

## 2. Commands and exact results

All commands were run from the audited worktree.

| Command | Result |
| --- | --- |
| `node --test tests/research-verify-pipeline.test.mjs` | **8 tests, 8 pass, 0 fail**, exit 0 (~6.9 s) |
| `node --test tests/research-verify-adversarial.test.mjs` | **38 tests, 38 pass, 0 fail**, exit 0 (~6.4 s) |
| `node --test tests/research-verify-artifacts.test.mjs` | **10 tests, 10 pass, 0 fail**, exit 0 (~1.0 s) |
| `node --test tests/research-verify-adapter.test.mjs` | **14 tests, 14 pass, 0 fail**, exit 0 (~1.0 s) |
| `npm test` (full suite, ten runs in this window) | **8 green / 2 red**: 278/278 pass (×2), 277/277 pass (×2), 276/276 pass (×3), 275/275 pass (×1); two runs ended **260 pass + 18 cancelled, 0 fail, exit 1** and **257 pass + 18 cancelled, 0 fail, exit 1**. The red runs are the flaky test finding **F2**, not a product assertion. |

The verifier suites total **70 tests**; all pass on their own.

`npm test` scripts: `pretest` = `node scripts/prepare-guanlan-fixture.mjs`
(cached fixture reused), `test` = `node --test "tests/**/*.test.mjs"`.

Historical note: before the F1 fix landed at 17:51, the full suite was red with
exactly one failing assertion — the verification test that detects credential
tokens in `sources.json` / `sources.md`. That is the only failing product check
this audit saw; it now passes.

## 3. Verdict by area

| Area | Verdict | Evidence |
| --- | --- | --- |
| T3 real Pi pipeline | **PASS** | 7 real-session tests: exactly the two research tools exposed, scripted `tool_call`/`tool_result` through Pi, validation rejects bad args before execute and before any socket, timed-out tool becomes a failed tool result, `session.abort()` cancels an in-flight tool, executor maps completed/timeout/cancelled |
| Network / SSRF | **PASS** | 19-URL matrix plus DNS rebinding, multi-address answers, ENOTFOUND, redirect-to-metadata/RFC1918, URL credentials; socket guard records zero non-fixture egress in every run |
| Untrusted content | **PASS** | exactly one fence emitted; embedded close fence, forged role tags and search-title payloads escaped; zero-width/bidi/control stripped; hidden-text signal recorded and hidden text dropped; oversized text capped; *(t4)* excerpt source is body text, not meta description |
| Limits / failure taxonomy | **PASS with findings** | gzip bomb and 2.5 MB body → `too_large`; slow → `timeout` (no retry); 429/5xx → classified and retried exactly once; PDF/CSS → `unsupported_content_type`; *(t4)* empty/JS shell → `extract_failed`; all codes come from `ERROR_CODE`. **F4** dead `maxTotalPageChars`; **F5** adapter does not forward turn/token limits |
| Executor / artifacts / provenance | **PASS** | citation audit for unfetched/unresolved ids; fabricated model URL never enters the ledger; unknown/corrupt/tampered runs → `not_found`/`invalid_run_id`/`parse_error`; tampered `paths` cannot read arbitrary files; live path fails closed with no run directory; cancelled/timeout statuses map correctly |
| Secret hygiene | **PASS after F1 fix** | token-bearing URL no longer reaches `sources.json`/`sources.md`; runtime error bearer/sk token redacted in `run.json`; no `authorization`/`cookie`/`x-api-key` sent by tools; proxy credential never persisted. **F7** is a low residual: raw model text in `report.md` can echo a credential-looking URL |
| AGT-027 adapter | **PASS (interface), residual integration risk** | real Pi session built from the options the adapter passes: research policy is prepended in the **model-visible** system prompt and the runtime's own prompt survives; cwd is an empty temp dir outside the repo and is removed on success and on throw; `maxToolCalls` 8 → 28 override; `timeoutMs` reaches `run()`; status/usage/tool-call/error mapping; official `createAgentRuntimePort` wins over the adapter; module without either export fails closed. Real AGT-027 module is not in this worktree |
| Prompt policy | **PASS** | 检索策略 present in the brief (HN short keywords, quoted Bing phrases, no repeated navigational queries); system prompt keeps “only cite actually-read pages”, forbids fabricated URLs, adds recall-quality rule; no topic, URL, source id or web content interpolated into the system prompt; deterministic for the same clock |
| Repository audit | **PASS** | no second runtime/provider/config/credential loading/MCP/client in `src/research`; only `defineTool`/`Type` imported from Pi; one contracts module and one port module; no free-form error codes or statuses; docs/CLI scope consistent (except F8 doc drift) |
| Live acceptance | **NOT VERIFIED HERE** | no live network or model run was performed by this audit |

## 4. Findings

Severity: `blocker` > `major` > `minor` > `low`. “Fixed” means fixed in the
working tree during this audit and re-verified here.

### F1 · major · FIXED — credential-bearing URLs were persisted in `sources.json` / `sources.md`

- Found at 17:30: a source URL containing `?access_token=…` appeared verbatim in
  `sources.json` and `sources.md`; only `run.json` passed through `redactDeep`.
- Fix landed at 17:51: `redactSourceRecord()` (`src/research/execute.mjs:201-217`)
  redacts `url`, `finalUrl`, `title`, `siteName`, `excerpt`, `aliases` and
  `error.message`, and is applied to the ledger before artifacts are written
  (`src/research/execute.mjs:676`, write block `:809-824`).
- Re-verified: the regression test
  `tests/research-verify-artifacts.test.mjs` “a token in a model-supplied URL
  must not be persisted into the source ledger” passes; a manual probe found the
  marker in none of `sources.json`, `sources.md`, `run.json`, `transcript.md`,
  `report.md`.
- Do not regress this: the test asserts on all five artifacts, not just one.

### F2 · medium · OPEN — full `npm test` is flaky (18 tests cancelled, exit 1)

- Reproduction: 2 of 10 full-suite runs failed with
  `failureType: 'cancelledByParent'`, `18` cancelled, `0` assertion failures;
  the other 8 runs were fully green. The failure starts at
  `tests/research-execute.test.mjs:329` (“external abort → cancelled”),
  then cancels its 17 siblings.
- Root cause: that test double registers the abort listener **after** the run has
  already been aborted under load:
  ```js
  spec.signal.addEventListener("abort", …, { once: true });
  ```
  `setTimeout(() => controller.abort(), 10)` can fire before `runAgent` is
  entered (the run store's first write sometimes takes >10 ms in the parallel
  suite), so the listener never fires and the promise stays pending.
- Impact: the repository's only declared verification command is
  non-deterministic; CI could go red without a product defect, and a genuine
  failure could hide behind cancellations.
- Fix (test-owned): check `if (spec.signal.aborted) throw abortError()` before
  adding the listener; optionally have the executor skip `runAgent` entirely when
  the caller's signal is already aborted (see F3).
- This audit did not modify the test (another member owns it).

### F3 · low · OPEN — an already-aborted external signal still invokes the runtime

- `src/research/execute.mjs:590-600` aborts the internal controller when the
  caller's signal is already aborted, but still calls `runtimePort.runAgent`
  (`:618-647`). A port that ignores the signal and returns text will produce a
  `cancelled` run that nonetheless persists `report.md` (`:824-833`).
- The verifier test documents the current behavior: status is `cancelled`, the
  error list has `aborted`, and the port sees `signal.aborted === true`.
- Suggested hardening: short-circuit before `runAgent` (persist
  `cancelled` + `aborted`) or discard the report when `abortReason` is set.

### F4 · low · OPEN — `LIMITS.maxTotalPageChars` is dead configuration

- `src/research/contracts.mjs:123` defines `{default: 120_000, max: 240_000}`;
  a repository-wide grep finds zero uses outside `contracts.mjs`. A run can read
  up to `maxPages × maxCharsPerPage` (default 20 × 40 000 = 800 000 chars) with
  no per-run total cap.
- Fix: either enforce it in `wrapTools`/the read tool (sum `contentChars` per
  run) or remove it from the contract so callers are not misled.

### F5 · low · OPEN — adapter drops `maxTurns` / `maxTotalTokens` and can lose the tool budget

- The port contract lists `maxTurns` and `maxTotalTokens`
  (`src/research/port.mjs:32-34`); the executor forwards them
  (`src/research/execute.mjs:630-632`), but `src/research/runtime/agt-027.mjs:92-120`
  only maps `limits.maxToolCalls` into `config` and `limits.timeoutMs` into
  `run()`. Nothing in the executor enforces turns or total tokens itself.
- If AGT-027 does not export `loadConfig`, the adapter passes `{ env }` and the
  `maxToolCalls` override (`:99-102`) cannot be applied, so AGT-027's default of
  8 could silently cap a research run.
- Suggested: forward both limits once AGT-027's config shape is confirmed, or
  document them as runtime-owned and remove them from the research contract.

### F6 · low · OPEN — usage is labelled `provider` even when no numbers were reported

- `src/research/runtime/agt-027.mjs:61` always returns `source: "provider"`.
  For a record with `usage: {}` the port result is all-null tokens but
  "provider" provenance; the executor persists that (`run.json`) although it
  cannot be provider-verified.
- Suggested: `source: "unknown"` when `input`/`output`/`total` are all absent.
  (The executor's own `normalizeUsage` already does this for other ports.)

### F7 · low · OPEN — raw model prose in `report.md` can echo a credential-looking URL

- `report.md` is written from the model's text without redaction
  (`src/research/execute.mjs:824-833`), while the ledger and `run.json` are
  redacted. A deterministic probe where the model quotes
  `https://example.com/x?access_token=…` leaves the token in `report.md`.
- This is model-authored content, not a tool/ledger leak, and the report is a
  local artifact; severity is low. Defense in depth: pass the persisted body
  through `redactSecrets()` (keep the in-memory body for citation parsing).

### F8 · minor · OPEN — design doc drift

`docs/engineering/agt-028-live-research.md` is captain-owned; these are
accuracy gaps, not implementation bugs:

- `:134-135` says `run.json` is “rewritten at every state transition”; the code
  writes it at start and at the end (`execute.mjs:586`, `:858`) with a
  `statusHistory`, so a crash leaves `running` evidence but not per-transition
  writes.
- `:34-49` module layout omits the new `runtime/agt-027.mjs` adapter (and
  `tests/research-runtime-adapter.test.mjs`), so the “never duplicate AGT-027”
  story is harder to audit from the doc alone.
- `:194` “No secret is read, logged or persisted” is true for tool/runtime
  secrets after F1, but see F7 for model-authored echoes.
- `:198` “Blocked until AGT-027 is on dev” is stale relative to the captain's
  reported live run; update when the live evidence is recorded.

### F9 · info — ledger excerpt escapes invisibles but not fence sequences

`details.excerpt` is `sanitizeUntrustedText(...)` (`read-page.mjs:285`), which
strips invisible/control characters but does not `escapeFence`. A page can
therefore put a literal `</untrusted_web_content>` into the persisted excerpt.
The excerpt is never re-fed into a model prompt (it is only shown in
`sources.md` / `sources.json`), so this is inert today; escape it if the ledger
is ever reused as prompt input.

### Observations (no action required)

- Unfetched/unresolved citations keep `status: completed`; the report gets a
  `## Citation audit` section and `sources.md` marks search-only hits as
  “不可作为事实依据”. Transparent, but the status is not downgraded — intentional
  or not, callers must read `citations`, not only `status`.
- A model-written URL never enters the ledger; the report text still contains it,
  which is correct for review (“model text is preserved”).
- Search-only hits use the provider summary; the tool set and prompt forbid
  treating them as fact.

## 5. Not proven by this audit

- **No live network run.** All tool traffic was loopback fixtures; the socket
  guard proves no non-fixture host was contacted. Real Bing/HN/SearXNG behavior
  is covered by T1's live probes, not re-run here.
- **No real model run.** The Pi pipeline uses `fauxProvider`; the executor mapping
  uses a scripted port. Nothing here proves a real model follows the prompt or
  produces a good report.
- **The real AGT-027 module is not in this worktree.** The adapter was verified
  against an AGT-027-shaped fake that builds a real Pi session. Interface
  assumptions still to confirm on `dev`: `config` vs `env`, `dispose()` name,
  `allowedTools`/`exposedTools` both accepted, `before_agent_start` ordering
  against the runtime's own handlers, and whether `run()` honors `signal` and
  `timeoutMs`.
- **The captain's live run is not accepted here.** `r-20261102T093914-e90abe` was
  not re-executed or re-inspected by this audit; claim spot-checks belong to the
  acceptance procedure, not to this report.
- **Scheduling/Feishu integration** was not exercised; only the documented
  `executeResearch` / `readResearchRun` boundary exists.
- **CI/typecheck/security scanners** were not run; there is no `typecheck` script
  in `package.json`, and no Sonar/CodeQL/AI review evidence is included.

## 6. How to reproduce

```bash
cd /Users/tao/Desktop/workspace/cloud-pi-agt-028

# Verifier suites (70 tests, all green)
node --test tests/research-verify-pipeline.test.mjs
node --test tests/research-verify-adversarial.test.mjs
node --test tests/research-verify-artifacts.test.mjs
node --test tests/research-verify-adapter.test.mjs

# Full repository gate (watch for F2 flake)
npm test
```

If `npm test` reports `cancelledByParent` in `tests/research-execute.test.mjs`,
re-run once and report F2 rather than treating it as a product failure; the
verifier suites are deterministic.
