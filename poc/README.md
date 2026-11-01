# Cloud Pi P0 — real Pi SDK session over the native MCP extension

This POC answers exactly one question:

> Can an actual Pi SDK `AgentSession` safely call Cloud Guanlan's read-only MCP
> tools through Pi's **native MCP extension**?

It does not build a fallback, a scheduler, a Feishu integration, a console,
Cloud Auth issuance or a production deployment. The subject on the other side is
the real `uichat-mira/cloud-mcp-guanlan` workerd worker, running on Miniflare
with a real D1 database, the repository's own migrations, its fixture-token
verifier and its actual `guanlan_whoami` / `guanlan_news_recent` tools.

## Pinned inputs

| Input | Pin | Evidence |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | `1.4.0` | `package.json` + `package-lock.json`; asserted by the suite |
| `@earendil-works/pi-ai` | `1.4.0` | same |
| Node.js | `>=22.19.0` (`v24.9.0` used for the recorded run) | `engines` in `package.json` |
| Guanlan fixture | commit `3362ef9254be154694cb786fc35921884c62b792` | `scripts/prepare-guanlan-fixture.mjs` |
| Miniflare / workerd | `4.20260730.0` / `1.20260730.1` | resolved from the pinned Guanlan checkout's lockfile |
| MCP protocol negotiated | `2025-11-25` | `initialize` request and SSE response captured by the fixture bridge |

Pi's MCP client supports `2025-11-25`, `2025-06-18`, `2025-03-26` and
`2024-11-05`; it does not offer Guanlan's modern `2026-07-28`. Guanlan answers
`2025-11-25` through its documented stateless legacy path. This is recorded as a
real compatibility fact, not hidden.

## Run it

```bash
npm ci
npm run prepare:guanlan   # clone + npm ci + build the pinned Guanlan checkout
npm test                  # node --test "tests/**/*.test.mjs"
```

`prepare:guanlan` clones and builds into the OS temp directory
(`cloud-pi-guanlan`, e.g. `%TEMP%\cloud-pi-guanlan`), so the fixture checkout and
its `node_modules` never pollute this repository. Set `GUANLAN_DIR` to reuse an
existing checkout, or pass `--force` to rebuild. `pretest` runs it automatically
and skips when the pinned build is already present.

## What is real, and what is scripted

- Real: `createAgentSession`, `DefaultResourceLoader`, `session.bindExtensions`,
  the built-in `createMcpExtension()`, the real streamable-HTTP MCP client and
  transport, Pi's tool registry, `tool_call` / `tool_result` extension events,
  the permission gate, the Guanlan workerd worker, its D1 database and its MCP
  server implementation.
- Scripted: only the LLM. `fauxProvider()` from the SDK's own test provider
  selects a tool with fixed arguments. Tool selection is deterministic; tool
  execution is not mocked.
- Test-only harness: Miniflare has no TCP listener, so `poc/guanlan-fixture.mjs`
  runs a transparent Node HTTP bridge that forwards each request to
  `mf.dispatchFetch` byte for byte (preserving host `127.0.0.1`, path `/mcp` and
  headers) and streams the response back. Its only injection is response
  latency, applied **after** the real worker produced its response, for the
  timeout/cancel cases.

## Evidence map

Recorded with `node --test "tests/**/*.test.mjs"`: **12 tests, 12 passed,
0 failed** (≈25 s on the recorded machine).

| Requirement | Test | Observed result |
| --- | --- | --- |
| Real SDK version and Extension API | `the installed Pi SDK is pinned…` | `1.4.0` installed; `createMcpExtension` exported; `initialize` request carries `protocolVersion: "2025-11-25"` and Guanlan answers `"protocolVersion":"2025-11-25"`, `serverInfo.name = "cloud-guanlan"` |
| Tools discovered over the wire | same | exactly `mcp__guanlan__guanlan_news_recent` and `mcp__guanlan__guanlan_whoami`; `tools/list` response carries both names and input schemas |
| Calls go through Pi's tool pipeline | `whoami and news execute through Pi's tool pipeline…` | `tool_call` and `tool_result` events fire; `details = {server:"guanlan", tool:"guanlan_whoami"}`; the bridge sees the matching `tools/call` with the model's arguments |
| Structured results and URL fidelity | same | `tool_result.structuredContent.structuredContent` is the Guanlan page; a 3 000+ character URL round-trips byte for byte; text content is the rendered Markdown |
| Identity cannot be selected by arguments | same | spoofed `accountId`/`consumerId`/`scopes` reach the tool unchanged but the result stays `account-a` / `consumer-1` / `["guanlan.read"]` |
| Account isolation | `accounts and stable consumers are isolated…` | `fixture-account-b` sees `account-b` / `consumer-b`; no subscription yields a positive empty page (`items: []`, `nextCursor: null`), not "all sources" |
| Stable-consumer isolation | same | `consumer-2` sees all three main items as `unread`; `consumer-1` sees its adopted row only when asking for `status: ["adopted"]` |
| Cursor binding | `a cursor is bound to the verified identity…` | a foreign cursor, a changed filter set and a tampered cursor all return `isError: true` with `guanlan_news_cursor_invalid` |
| Pagination exactness | `pagination is exact and a scan-budget-limited page…` | 12 items returned exactly once in `ingested_at DESC` order across pages; budget exhaustion on 420 adopted rows returns `items: []` **with** a continuation cursor, and the next page ends with `nextCursor: null`; an unsubscribed `sourceId` is an empty page, not an error |
| Permission isolation at execution | `a permission extension blocks execution…` | the tool stays declared to the model; a `tool_call` handler returning `{block:true}` produces an `isError` tool result and the bridge sees **zero** `tools/call`; an undeclared `mcp__guanlan__guanlan_delete` is rejected before the server too |
| Timeout | `a timed-out MCP call is an explicit tool error…` | with a 1 s server timeout and 2.5 s injected response latency, the call fails in ~1.0 s with `MCP request timed out after 1000ms`; the client sends `notifications/cancelled` with the matching `requestId` and reason `Request timed out` |
| Cancel | `aborting the agent cancels an in-flight MCP call` | `session.abort()` yields `MCP request aborted` and `notifications/cancelled` with the matching `requestId` |
| Reconnect | `an interrupted transport reconnects on the next call` | after `dropConnections()` the next call is an `isError` (`fetch failed`), the following call succeeds; stopping the listener and restarting it behaves the same |
| Test-credential update | `rotating the test credential changes the verified identity in place` | replacing the registration with `fixture-consumer-2` reconnects in place; the next `whoami` reports `consumer-2`, no session rebuild |
| Bad credentials | `invalid credentials never expose tools…` | wrong scope, expired and missing-consumer tokens: no MCP tools declared, `initialize` rejected with HTTP ≥ 400, zero `tools/call` |
| Error is not empty success | `a failed news read is never downgraded…` | dropping `poc_news` makes the news call `isError: true` with `guanlan_news_unavailable: the news index could not be read`; `whoami` still works |

## Findings worth carrying forward

1. **`structuredContent` survives only on the extension event.** Pi's transcript
   `ToolResultMessage` keeps `content`, `details` and `isError`, but not
   `structuredContent`. The `tool_result` extension event carries the whole
   `CallToolResult` (`{content, structuredContent, isError}`), so structured
   consumers and audit hooks must read the event, not the transcript. This is
   the single most important integration detail found.
2. **The native extension is sufficient for Plan A.** No substantive blocker
   was found. Auth, identity binding, per-consumer state, pagination, structured
   output, permission gating, timeout, cancel, reconnect and credential rotation
   all work through the public SDK surface.
3. **A dropped connection costs one failed call.** The first call after a
   transport interruption returns `isError` (`fetch failed`); the next call
   reconnects. Production callers should retry once on that error rather than
   treat it as a permanent failure.
4. **Blocked calls produce no `tool_result` event.** The transcript still has the
   blocked tool result, but the extension event does not fire. Audit/telemetry
   must not depend on `tool_result` alone.
5. **Protocol ceiling is Pi's, not Guanlan's.** Pi offers at most `2025-11-25`
   and Guanlan serves its legacy stateless path for it. If Guanlan later drops
   legacy protocol versions, Pi's client will need a newer protocol version.
6. **Miniflare is in-process only.** The HTTP bridge is test scaffolding; it is
   not production transport and does not change the MCP client or server.

## Deliberately not executed

- Cloud Auth real credential issuance and key rotation.
- Production deployment, production D1, real network egress to a deployed
  Guanlan endpoint.
- Feishu, scheduler, console, Cloud Pi product surfaces.
- A Plan B MCP integration.
- Merging PR #1 or changing Guanlan source. The Guanlan checkout is read-only
  for this POC; only its pinned build output is consumed.

The fixture tokens (`fixture-consumer-1`, …) are Guanlan's trusted test-host
strings, not production credentials. No token value is written to the model
prompt, tool arguments, transcript or captured evidence.
