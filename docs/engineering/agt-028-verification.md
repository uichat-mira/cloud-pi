# AGT-028 · Independent verification report

Status: **verification PASS on confirmation HEAD `47fb5b7`**, with one new
integration finding (F10) and accepted residual risks. This document records what
an independent verifier actually ran against the AGT-028 working tree, what
passed, what failed, and what remains unproven. It is not acceptance: the live
evidence in [docs/evidence/agt-028/](../evidence/agt-028/README.md) was produced
by the team, not independently re-run here, and the Issue owner decides.

- Audited worktree: `/Users/tao/Desktop/workspace/cloud-pi-agt-028`
  (the main `cloud-pi` checkout was not modified).
- Audited at: 2026-11-02 17:30–18:00 +08:00 (first pass) and 18:17–18:30
  (confirmation pass on HEAD `47fb5b7`).
- Environment: Node.js v22.23.2, npm 10.9.8, macOS; no proxy env vars set.
- No git command was used to change or inspect code content; a single read-only
  `git rev-parse HEAD` confirmed the confirmation-pass revision `47fb5b7`. File
  content is pinned below by SHA-256.
- T4 completed during this audit. Its excerpt-from-body and `extract_failed`
  behavior (`src/research/tools/read-page.mjs`, modified 17:43) was present for
  the final runs; the checks marked *(t4)* below were re-run against that final
  file.
- The team produced three live runs at 18:01–18:04, committed (redacted) under
  `docs/evidence/agt-028/runs/`; this audit checked their presence/shape, not
  their truth. That is **not** independent live evidence from this audit; see
  “Not proven”.

## Audited artifacts (SHA-256)

```
# confirmation HEAD 47fb5b7
20b9012e127a4d223c65bcfab4de2d63080b708827f39924e801d4b26fa567eb  src/research/execute.mjs
88188b5a662d338991e8506c8cdac7d667c0e698615ba423de964dadc49bb313  src/research/port.mjs
9e74f1dae04ec0bb5b96e6c5df6ad1ecefd33be26c01502d65e84154d7c9da0d  src/research/runtime/agt-027.mjs
df9aa74d730311e5ad0bc5551a1edb5c6a595555460bcbcd8a8f7205cb707d3c  src/research/prompt.mjs
c560efad35aea11a55a0c6ec27fa40bfe89abbe0100c67226d8d94f8ee687e8a  src/research/contracts.mjs
960cc8bed318306e4e922a66219d81da5fe5e134a31e0adb93d2a932cf6db2c3  src/research/tools/read-page.mjs
7eae8ab174214ccc690e1c420cb5f26930258b23025344abf2fff6f870ec79ef  src/research/tools/search.mjs
```

## 1. What was added by this verification

| File | Purpose |
| --- | --- |
| `tests/helpers/session-harness.mjs` | real Pi session + faux model; scripted tool steps; Pi pipeline test port (`createPiPipelinePort`); outbound-connection guard covering `Socket#connect`, `net.connect`/`createConnection` and `tls.connect` (undici path), with a child-process self-test |
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
| `npm test` (full suite, ten runs before triage) | **8 green / 2 red**: 278/278 pass (×2), 277/277 pass (×2), 276/276 pass (×3), 275/275 pass (×1); two runs ended **260 pass + 18 cancelled, 0 fail, exit 1** and **257 pass + 18 cancelled, 0 fail, exit 1**. The red runs were the flaky test finding **F2**, not a product assertion. |
| `npm test` (confirmation HEAD `47fb5b7`, five consecutive runs) | **279/279 pass, 0 fail, 0 cancelled, exit 0, all five runs** |
| `node --test --test-name-pattern "external abort" tests/research-execute.test.mjs` (×20) | **20/20 pass** (flake-fix stress) |
| `node --test --test-name-pattern "maxTotalPageChars refuses further page reads|external abort" tests/research-execute.test.mjs` | **2 tests, 2 pass** (F2 + F4 fixes) |

The verifier suites total **70 tests**; all pass on their own, before and after
the confirmation changes (adapter 14/14, artifacts 10/10 re-run on `47fb5b7`).

`npm test` scripts: `pretest` = `node scripts/prepare-guanlan-fixture.mjs`
(cached fixture reused), `test` = `node --test "tests/**/*.test.mjs"`.

### 2.1 Confirmation pass on HEAD `47fb5b7`

Triage addressed F2 (abort-race fix in the t2 scripted port), F4
(`maxTotalPageChars` enforcement) and F8 (design-doc drift). Re-ran after the
triage:

- F2: five consecutive full-suite runs were 279/279 green with **0 cancelled**
  (previously 2 of 10 runs died with 18 cancelled); the aborted-signal test alone
  passed 20/20. **Fixed.**
- F4: focused test passes; the executor now refuses further page reads with
  `budget_exceeded` once `counters.pageChars >= maxTotalPageChars`
  (`src/research/execute.mjs:316`). **Fixed**, with two low-severity nuances: the
  check happens before the next read, so a run may overshoot the cap by up to one
  page (`contentChars` of the last allowed read); and the *initial* `run.json`
  still contains `tools.counters.pageChars: 0` even though the final record omits
  it.
- F8: design doc now lists `runtime/agt-027.mjs`, says `run.json` is written at
  start and finalisation, and replaces the stale live-acceptance block with the
  three real runs in `docs/evidence/agt-028/`. **Fixed**, except the §11 claim
  that the port loader auto-resolves `src/index.mjs` — contradicted by **F10**.
- F3/F5/F6/F7: owner rationale accepted (see each finding); no code change.

**New finding F10 (medium)**: the new default-module fallback in
`src/research/port.mjs:112` imports the wrong variable.

Historical note: before the F1 fix landed at 17:51, the full suite was red with
exactly one failing assertion — the verification test that detects credential
tokens in `sources.json` / `sources.md`. That is the only failing product check
this audit saw; it now passes.

## 3. Verdict by area

| Area | Verdict | Evidence |
| --- | --- | --- |
| T3 real Pi pipeline | **PASS** | 8 real-session tests: exactly the two research tools exposed, scripted `tool_call`/`tool_result` through Pi, validation rejects bad args before execute and before any socket, timed-out tool becomes a failed tool result, `session.abort()` cancels an in-flight tool, executor maps completed/timeout/cancelled |
| Network / SSRF | **PASS** | 19-URL matrix plus DNS rebinding, multi-address answers, ENOTFOUND, redirect-to-metadata/RFC1918, URL credentials; connection guard records zero non-fixture egress in every run |
| Untrusted content | **PASS** | exactly one fence emitted; embedded close fence, forged role tags and search-title payloads escaped; zero-width/bidi/control stripped; hidden-text signal recorded and hidden text dropped; oversized text capped; *(t4)* excerpt source is body text, not meta description |
| Limits / failure taxonomy | **PASS** | gzip bomb and 2.5 MB body → `too_large`; slow → `timeout` (no retry); 429/5xx → classified and retried exactly once; PDF/CSS → `unsupported_content_type`; *(t4)* empty/JS shell → `extract_failed`; all codes come from `ERROR_CODE`. **F4 fixed** on `47fb5b7` (`maxTotalPageChars` now refuses further reads); F5 accepted/documented |
| Executor / artifacts / provenance | **PASS** | citation audit for unfetched/unresolved ids; fabricated model URL never enters the ledger; unknown/corrupt/tampered runs → `not_found`/`invalid_run_id`/`parse_error`; tampered `paths` cannot read arbitrary files; live path fails closed with no run directory; cancelled/timeout statuses map correctly |
| Secret hygiene | **PASS after F1 fix** | token-bearing URL no longer reaches `sources.json`/`sources.md`; runtime error bearer/sk token redacted in `run.json`; no `authorization`/`cookie`/`x-api-key` sent by tools; proxy credential never persisted. **F7** is a low residual: raw model text in `report.md` can echo a credential-looking URL |
| AGT-027 adapter | **PASS (interface), F10 integration risk** | real Pi session built from the options the adapter passes: research policy is prepended in the **model-visible** system prompt and the runtime's own prompt survives; cwd is an empty temp dir outside the repo and is removed on success and on throw; `maxToolCalls` 8 → 28 override; `timeoutMs` reaches `run()`; status/usage/tool-call/error mapping; official `createAgentRuntimePort` wins over the adapter; module without either export fails closed. The real AGT-027 sibling module was loaded through the explicit `moduleSpecifier` path (not executed). **F10**: the sibling auto-discovery path is broken |
| Prompt policy | **PASS** | 检索策略 present in the brief (HN short keywords, quoted Bing phrases, no repeated navigational queries); system prompt keeps “only cite actually-read pages”, forbids fabricated URLs, adds recall-quality rule; no topic, URL, source id or web content interpolated into the system prompt; deterministic for the same clock |
| Repository audit | **PASS** | no second runtime/provider/config/credential loading/MCP/client in `src/research`; only `defineTool`/`Type` imported from Pi; one contracts module and one port module; no free-form error codes or statuses; docs/CLI scope consistent after F8 fix (F10 is a code/doc mismatch) |
| Live acceptance | **NOT VERIFIED HERE** | no live network or model run was performed by this audit; three redacted runs exist in `docs/evidence/agt-028/` (numeric provider usage, `completed`/`completed_with_errors`, 2–3 fetched sources each) and were shape-checked, not re-executed |

## 4. Findings

Severity: `blocker` > `major` > `minor` > `low`. “Fixed” means fixed in the
working tree during this audit and re-verified here.

### F1 · major · FIXED — credential-bearing URLs were persisted in `sources.json` / `sources.md`

- Found at 17:30: a source URL containing `?access_token=…` appeared verbatim in
  `sources.json` and `sources.md`; only `run.json` passed through `redactDeep`.
- Fix landed at 17:51: `redactSourceRecord()` (`src/research/execute.mjs:201-217`)
  redacts `url`, `finalUrl`, `title`, `siteName`, `excerpt`, `aliases` and
  `error.message`, and is applied to the ledger before artifacts are written
  (`src/research/execute.mjs:681`, write block `:812-829`).
- Re-verified: the regression test
  `tests/research-verify-artifacts.test.mjs` “a token in a model-supplied URL
  must not be persisted into the source ledger” passes; a manual probe found the
  marker in none of `sources.json`, `sources.md`, `run.json`, `transcript.md`,
  `report.md`.
- Do not regress this: the test asserts on all five artifacts, not just one.

### F2 · medium · FIXED on `47fb5b7` — full `npm test` was flaky (18 tests cancelled, exit 1)

- Original reproduction: 2 of 10 full-suite runs failed with
  `failureType: 'cancelledByParent'`, `18` cancelled, `0` assertion failures;
  the failure started at `tests/research-execute.test.mjs:329`
  (“external abort → cancelled”) and cancelled its 17 siblings.
- Root cause: the test double registered the abort listener **after** the run had
  already been aborted under load (`setTimeout(..., 10)` vs the run-store's first
  write), so the listener never fired and the promise stayed pending.
- Fix: the scripted port now checks `spec.signal.aborted` and rejects before
  `addEventListener` (`tests/research-execute.test.mjs:337-340`).
- Re-verified: five consecutive `npm test` runs were **279/279 pass, 0 cancelled**;
  the abort test alone passed 20/20. The final run was 279/279 green.

### F3 · low · ACCEPTED (owner decision) — an already-aborted external signal still invokes the runtime

- `src/research/execute.mjs:593-603` aborts the internal controller when the
  caller's signal is already aborted, but still calls `runtimePort.runAgent`
  (`:623-662`). A port that ignores the signal and returns text will produce a
  `cancelled` run that nonetheless persists `report.md` (`:824-833`).
- The verifier test pins this behavior: status `cancelled`, `aborted` in errors,
  and the port sees `signal.aborted === true`.
- Owner rationale accepted: passing the already-aborted signal is the observable
  port contract; skipping the port would change behavior this audit pinned. The
  contract relies on the port aborting promptly. A one-line port-contract note
  (“a port must return cancelled if `signal.aborted` on entry”) would make that
  obligation explicit; not required for this delivery.
- Residual: a non-compliant port can leave a model-authored `report.md` under a
  `cancelled` run.

### F4 · low · FIXED on `47fb5b7` — `LIMITS.maxTotalPageChars` was dead configuration

- Original: `src/research/contracts.mjs:123` defined
  `{default: 120_000, max: 240_000}`, but nothing read it; a run could read up to
  `maxPages × maxCharsPerPage` (default 800 000 chars).
- Fix: the executor now tracks `counters.pageChars` from each successful page's
  `details.contentChars` and refuses further page reads with
  `budget_exceeded` once the total is at/above the limit
  (`src/research/execute.mjs:316`, `:403`); test at
  `tests/research-execute.test.mjs:405` passes.
- Two low-severity nuances: (a) the check runs **before** the next read, so the
  total can overshoot by the `contentChars` of the last allowed page (bounded by
  `maxCharsPerPage`); it is a stop-future-reads budget, not a hard clamp. (b) The
  initial `run.json` still contains `tools.counters.pageChars: 0`
  (`execute.mjs:496`) even though the final record's `deriveCounters()` omits it;
  “not persisted in run.json counters” is therefore true only for the final
  state. Neither affects the enforced behavior or `assertRunShape`.

### F5 · low · ACCEPTED (owner decision, verified against the real module) — adapter drops `maxTurns` / `maxTotalTokens`

- The port contract lists `maxTurns` and `maxTotalTokens`
  (`src/research/port.mjs:32-34`); the executor forwards them
  (`src/research/execute.mjs:634-639`), but the adapter only maps
  `limits.maxToolCalls` into `config` and `limits.timeoutMs` into `run()`.
  Nothing in the executor enforces turns or total tokens itself.
- Owner rationale accepted: AGT-027 has no such knobs
  (`DEFAULT_LIMITS`/`CONFIG_KEYS` expose only `runTimeoutMs`, `maxOutputTokens`
  and `maxToolCalls`), so faking enforcement would be worse than documenting them
  as advisory.
- The earlier `loadConfig` risk is **closed**: the real AGT-027 module exports
  `loadConfig` and `createAgentRuntime`, and `loadConfig` defaults
  `maxToolCalls` to 8; the adapter's `{...baseConfig, maxToolCalls: 28}` override
  therefore applies. Confirmed by importing
  `/Users/tao/Desktop/workspace/cloud-pi-agt-027/src/index.mjs` through
  `loadAgentRuntimePort({moduleSpecifier})`: port loads, `loadConfig` and
  `createAgentRuntime` are functions, default `maxToolCalls` is 8.

### F6 · low · ACCEPTED (verified against the real module) — usage is labelled `provider`

- `src/research/runtime/agt-027.mjs:57-64` always returns `source: "provider"`.
- Owner rationale verified: AGT-027's `buildRunRecord()` always builds
  `usage` from `session.getSessionStats().tokens` (numeric, 0 when absent) and
  always includes `model.providerId` / `model.modelId`; the three live runs in
  `docs/evidence/agt-028/` carry real numbers (e.g. 7,993/3,500/23,909,
  `mira-ai` / `deepseek-v4.1-flash-od`). `provider` is therefore accurate for
  this runtime. A record that violated that contract would be mislabelled, but
  that is outside the documented AGT-027 shape.

### F7 · low · ACCEPTED residual — raw model prose in `report.md` can echo a credential-looking URL

- `report.md` is written from the model's text without redaction
  (`src/research/execute.mjs:830-838`), while the ledger and `run.json` are
  redacted. A deterministic probe where the model quotes
  `https://example.com/x?access_token=…` leaves the token in `report.md`.
- This is model-authored content, not a tool/ledger leak, and the report is a
  local artifact; severity is low. Owner accepted the residual: the prompt
  forbids reproducing credentials and persisted ledgers are redacted.
- Defense in depth remains available (pass the persisted body through
  `redactSecrets()` while keeping the in-memory body for citation parsing) if a
  future requirement treats reports as shareable evidence.

### F8 · minor · FIXED on `47fb5b7` (except the §11 claim, see F10) — design doc drift

`docs/engineering/agt-028-live-research.md` is captain-owned; these were
accuracy gaps, not implementation bugs:

- `run.json` wording now says “written when the run starts … and again when the
  run finalises”, matching `execute.mjs:580`/`:863`.
- Module layout now lists `runtime/agt-027.mjs` with its role.
- The live-acceptance section describes the three real runs and points at
  `docs/evidence/agt-028/`; the stale “blocked until AGT-027 is on dev” line is
  gone and §11 describes post-merge integration.
- Remaining inaccuracy: §11 says the loader resolves sibling `src/index.mjs`
  automatically — false because of **F10**. The absolute sentence “No secret is
  read, logged or persisted” is also broader than reality: AGT-028 does not read
  credentials, but the AGT-027 runtime reads the model key from the host
  environment in memory; consider narrowing it.

### F9 · info — ledger excerpt escapes invisibles but not fence sequences

`details.excerpt` is `sanitizeUntrustedText(...)` (`read-page.mjs:285`), which
strips invisible/control characters but does not `escapeFence`. A page can
therefore put a literal `</untrusted_web_content>` into the persisted excerpt.
The excerpt is never re-fed into a model prompt (it is only shown in
`sources.md` / `sources.json`), so this is inert today; escape it if the ledger
is ever reused as prompt input.

### F10 · medium · OPEN — the default AGT-027 module fallback imports the wrong variable

- In `47fb5b7`: `src/research/port.mjs:102-112` resolves a default sibling
  `src/index.mjs`, but the import uses `moduleSpecifier` instead of the resolved
  `specifier`:
  ```js
  const specifier = requested ?? (existsSync(fileURLToPath(fallback)) ? fallback.href : null);
  if (!specifier) throw new RuntimeUnavailableError(...);
  try {
    mod = await import(moduleSpecifier);   // should be `specifier`
  }
  ```
  When no explicit module is configured (`moduleSpecifier` is `undefined`), the
  fallback is selected but `import(undefined)` fails (`Cannot find package
  'undefined'`), so the loader still throws `RuntimeUnavailableError`.
- Impact: the post-merge zero-config path promised by
  `docs/engineering/agt-028-live-research.md` §11 (“the port loader resolves it
  automatically”) and the `RESEARCH_AGENT_RUNTIME_MODULE` table note
  (“`src/index.mjs` is used automatically”) cannot work. The current live
  evidence is unaffected because it passes `--runtime-module` explicitly, and
  the fail-closed test passes only because `src/index.mjs` does not exist yet.
  After AGT-027 is merged, `node scripts/research.mjs --topic …` without
  `--runtime-module` will exit 3 instead of running.
- Fix: `mod = await import(specifier);` (one line). Also update
  `tests/research-verify-artifacts.test.mjs`'s fail-closed expectation when the
  sibling file actually exists, and add a loader test for the default fallback.
- Verified statically and with `import(undefined)`; the explicit
  `moduleSpecifier` path loads the real AGT-027 `src/index.mjs` successfully
  (`portVersion: 1`, `loadConfig`/`createAgentRuntime` functions, default
  `maxToolCalls: 8`). This audit did not modify `port.mjs` (not verifier-owned).

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
- **The real AGT-027 runtime was not executed.** The sibling checkout at
  `/Users/tao/Desktop/workspace/cloud-pi-agt-027` exists; this audit imported its
  `src/index.mjs` through `loadAgentRuntimePort({moduleSpecifier})` and confirmed
  the adapter's assumptions (`loadConfig`, `createAgentRuntime`, the documented
  options, default `maxToolCalls: 8`), but did not run a model or network call.
  Runtime behavior still to confirm on `dev`: `dispose()` semantics,
  `before_agent_start` ordering against the runtime's own handlers, and whether
  `run()` honors `signal`/`timeoutMs` as expected (the code paths look correct).
- **Live evidence was shape-checked, not accepted.** Three redacted runs exist
  under `docs/evidence/agt-028/runs/` with numeric provider usage, statuses
  `completed`/`completed_with_errors`, and 2–3 fetched sources each; this audit
  did not re-execute them or repeat the README's `curl` spot-checks. The earlier
  captain run `r-20261102T093914-e90abe` was not inspected. Acceptance remains
  with the Issue owner.
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

# Full repository gate (F2 fixed on 47fb5b7; five consecutive green runs)
npm test

# Focused fixes
node --test --test-name-pattern "external abort|maxTotalPageChars refuses further page reads" tests/research-execute.test.mjs
```

F2 no longer reproduces (5×279/279, 20/20 abort stress). If
`cancelledByParent` reappears, treat it as a new flake with the same signature,
not as a product failure; the verifier suites are deterministic.
