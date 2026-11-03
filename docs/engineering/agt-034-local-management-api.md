# AGT-034 · Cloud Agent local management API

Status: local POC complete; Draft PR to `dev`; no merge, deployment or public
listener.
Owning Issue: [#16](https://github.com/uichat-mira/cloud-pi/issues/16).
Base: `origin/dev` at `fad03f8` (AGT-030 Scheduler and AGT-028 Research merged;
AGT-033 delivery is **not** in this baseline).
Branch: `feat/agt-034-local-management-api`.
Draft PR: [#19](https://github.com/uichat-mira/cloud-pi/pull/19) → `dev`
(head `d553123`). CI on that head: `test` pass, SonarCloud pass, CodeRabbit
skipped; checks are evidence, not merge authority.

This document records what the API actually does, how it stays a thin control
plane, the exact local smoke evidence, and what remains unproven. It does not
claim Cloud Auth integration, a public service, production persistence or a
live model run.

## 1. Scope and intent

Cloud Auth's `/account/services` console (later card) needs to create, edit,
pause, run and inspect scheduled research. The business state must stay owned by
Cloud Pi, not copied into Cloud Auth. This card therefore adds a versioned JSON
HTTP facade that:

- listens **only** on the literal loopback addresses `127.0.0.1` or `::1`;
- calls the existing Scheduler and Research public modules for every read/write;
- has no task database, cache or index of its own;
- never edits `${SCHEDULER_STATE_DIR}/schedules/*.json` or
  `${RESEARCH_RUNS_DIR}/*` from the HTTP layer;
- has no account, token, session or CORS design — Cloud Auth delegation is a
  separate, not-yet-frozen contract.

It is a local development/internal boundary. Rebinding it to `0.0.0.0`, `::`,
a LAN address or a hostname is refused before a socket exists.

## 2. Conditional delivery closure (read this before reviewing endpoints)

Issue #16 says delivery detail is exposed **only if AGT-033 is already present
in the implementation baseline**. It is not: `origin/dev` at `fad03f8` contains
no `src/delivery/`, no `deliveryTargets` schedule contract and no delivery
store. AGT-033's Draft PR is separate and unmerged.

This card therefore:

- does **not** copy AGT-033 code, contract or state;
- does **not** implement `/v1/runs/:runId/delivery`, a delivery store or a
  `deliveryTargets` field;
- returns a stable documented `404 not_found` for the delivery route with an
  explicit reason, and reports `capabilities.deliveryStatus: false` in
  `/v1/status`;
- does not stack on the AGT-033 branch.

When AGT-033 lands, a follow-up card can add the delivery read route and the
`deliveryTargets` write field against its final contract. Until then, absence is
intentional and visible to a console, not a silently missing field.

## 3. Ownership and module layout

```
src/api/
  contracts.mjs   version, error classes, HTTP status map, limits
  policy.mjs      loopback host/port policy, listen-address formatting
  views.mjs       reviewed projections (schedule/run/report/source)
  controller.mjs  thin use cases → Scheduler / Research public modules
  router.mjs      route table, query/body schema, error mapping
  server.mjs      node:http server, JSON body cap, start/stop lifecycle
  index.mjs       public exports
src/scheduler/
  scheduler.mjs   + updateSchedule(), deleteSchedule() only
  index.mjs       documentation of the two new operations
scripts/agt-034/
  api-smoke.mjs   reproducible local HTTP smoke (fixture model boundary)
tests/
  agt-034-api-t1.test.mjs
  agt-034-api-t2.test.mjs
  agt-034-api-t3.test.mjs
  agt-034-api-lifecycle.test.mjs
  agt-034-helpers.mjs
```

No dependency was added. The API uses Node built-in `node:http`, `fetch` is only
used by tests/scripts, and the repository still has no web framework.

### Scheduler ownership

`updateSchedule()` and `deleteSchedule()` were added to `scheduler.mjs` and
documented in `scheduler/index.mjs`. `contracts.mjs`, `schedule.mjs` and
`store.mjs` were **not** modified, so AGT-033's scheduler contract surface is
untouched. No status machine, timer, lease or dedupe rule was rewritten.

## 4. Endpoint summary (`/v1`)

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| GET | `/v1/health` | process liveness, API version | 200 |
| GET | `/v1/status` | schedule counts, active runs, run count, capability flags | 200 |
| GET | `/v1/schedules` | list schedules (reviewed projection) | 200 |
| POST | `/v1/schedules` | create once/recurring schedule | 201 + `Location` |
| GET | `/v1/schedules/:id` | schedule detail + bounded recent triggers | 200 |
| PATCH | `/v1/schedules/:id` | update business fields only | 200 |
| DELETE | `/v1/schedules/:id` | delete definition + persisted file | 200 |
| POST | `/v1/schedules/:id/pause` | pause | 200 |
| POST | `/v1/schedules/:id/enable` | enable and recompute next run | 200 |
| POST | `/v1/schedules/:id/run-now` | trigger one run | 200 |
| POST | `/v1/schedules/:id/cancel` | abort the active run | 200 |
| GET | `/v1/runs` | list runs (`limit`, optional `scheduleId`) | 200 |
| GET | `/v1/runs/:runId` | run detail | 200 |
| GET | `/v1/runs/:runId/report` | report text + bounded source ledger | 200 |
| GET | `/v1/runs/:runId/delivery` | conditional closure: documented 404 | 404 |

Notes:

- Query parameters are validated per route. `/v1/runs` accepts only `limit`
  (1–100, default 50) and `scheduleId`; everything else is `invalid_request`.
- Request bodies must be `application/json`, a JSON object, and at most 64 KiB.
- Trailing slashes are accepted; malformed percent-encoding is `invalid_request`.
- Unknown path → `not_found`; known path with a different method →
  `method_not_allowed` plus an `Allow` header.
- A schedule's recent trigger history is bounded to 20 entries in a detail view;
  full history remains in the Scheduler's own bounded store.
- `run-now` is synchronous for the trigger outcome: the request returns after the
  triggered run reaches a terminal state, so the console receives the real
  `runId`/`status` rather than an optimistic acknowledgement. The run is bounded
  by the schedule's own `request.limits.maxRuntimeMs` (AGT-028), not by an HTTP
  timeout. `api.stop()` bounds how long it waits for that request; it does not
  abort the scheduler run (use `cancel` or `scheduler.stop` for that).

### Response envelopes

Success:

```json
{ "ok": true, "data": { "...": "..." } }
```

Failure:

```json
{ "ok": false, "error": { "code": "conflict", "message": "..." } }
```

Every response carries `x-request-id`, `cache-control: no-store` and
`x-content-type-options: nosniff`. No CORS header is emitted.

## 5. Error contract

| `code` | HTTP | Typical cause |
| --- | --- | --- |
| `invalid_request` | 400 | schema, query, JSON, invalid schedule/request field |
| `not_found` | 404 | unknown route, schedule, run, artifact; delivery closure |
| `conflict` | 409 | completed schedule paused, update/delete during an active run, cancel with no active run |
| `busy` | 503 | scheduler already has an active run; server shutting down |
| `internal_error` | 500 | unexpected failure; message is always `"internal error"` |
| `method_not_allowed` | 405 | known path, unsupported method |
| `unsupported_media_type` | 415 | non-JSON body |
| `payload_too_large` | 413 | body over 64 KiB |

Internal errors never return a stack, absolute host path, environment value or
raw internal message. Unexpected diagnostics are logged as only
`api: internal error (<ErrorName>)`. Request logs contain method, **route
template**, status, duration and request id — never a body, header, query value
or report content.

## 6. Loopback-only policy

- Allowed hosts: literal `127.0.0.1` and `::1` only.
- Refused before listening: `0.0.0.0`, `::`, `localhost`, LAN addresses,
  hostnames, empty values. Hostnames are not resolved, because `/etc/hosts` or
  DNS must not be able to widen the listener.
- Default: `127.0.0.1:8787`; a caller may pass port `0` for an ephemeral local
  port (tests and the smoke do).
- The actual bound address is read back from the socket and formatted with IPv6
  brackets when needed.
- There is no authentication, authorization, TLS, proxy trust or public bind in
  this card. A local process with access to the loopback port is trusted; Cloud
  Auth delegation is a later card.

## 7. Start/stop lifecycle

- `start()` creates the HTTP server, binds the validated address and returns
  `{ host, family, port, url }`. A listen failure (for example `EADDRINUSE`)
  rejects and is not retried under another port.
- `stop()` sets a closing flag, calls `server.close()` (no new connections),
  closes idle keep-alive sockets, waits up to `shutdownTimeoutMs` (default 2 s)
  for in-flight requests, then calls `closeAllConnections()` if work remains.
  It is idempotent and returns `{ stopped, forced }`.
- A request that reaches an already-closing server gets `503 busy` with
  `Connection: close`.
- A stopped instance refuses `start()` with `409 conflict`; create a new
  instance. The API does not own the Scheduler's lifetime: the caller should
  also call `scheduler.stop()`/`dispose()`.

## 8. Sensitive-field filtering

Responses are built by explicit whitelists in `views.mjs`; stored records are
never spread verbatim.

Never returned: absolute state/run paths, `paths` object, transcript, raw
environment, API keys, Feishu credentials, Cloud Session, Authorization headers,
model base URL, request headers, HTTP bodies, full internal errors/stacks.

Returned for a schedule: id, name, kind, timezone, cron/once, reviewed research
request (`topic`, `goal`, `timeRange`, limits), status, next/completed times,
`lastRun`, `activeTrigger`, stats and bounded recent triggers.

Returned for a run: id, status/timestamps/duration, reviewed request + limits,
runtime status/usage token counts/model id, tool counters, source summary,
citation counts, classified errors, artifact availability. Report text and
source provenance come from the research run store; source URLs are restricted
to http/https and have embedded userinfo removed. The report can contain public
web content, which is the configured research deliverable; it is not a private
message body.

The smoke and tests seed secret-looking environment values and assert they never
appear in responses or captured logs.

## 9. Minimal `updateSchedule()` / `deleteSchedule()` contract

### update

Accepted fields only: `name`, `timezone`, `kind`, `cron`, `at`, `request`,
`enabled`. Unknown or internal fields (`scheduleId`, `status`, `triggers`,
`activeTrigger`, `nextRunAt`, `stats`, `lastRun`, delivery fields) are
`invalid_request`. An empty patch is refused.

- **In-flight fail closed:** if the schedule has a persisted `activeTrigger` or
  a live execution controller, update returns `conflict`. Writing a definition
  under a running execution would let the execution release a lease against a
  stale object or start a duplicate trigger; this is refused instead.
- **Timing changes** (`kind`, `timezone`, `cron`, `at`) re-normalise the
  definition with the Scheduler's existing validator and recompute `nextRunAt`
  strictly after `now`.
- **Non-timing changes** (name/request/`enabled`) keep the current
  `nextRunAt`/status unless `enabled` is explicitly supplied. A due-but-not-yet-
  claimed occurrence therefore cannot be silently skipped by a rename.
- **Paused** stays paused across a name/request update; `enabled: false` pauses,
  `enabled: true` activates a paused schedule.
- **Completed** schedules are immutable except together with a new future
  `at`/`cron`, which intentionally starts a fresh activation and clears
  `completedAt`; trigger history and stats are retained as audit.
- History/stats/leases are preserved; only `updatedAt` is refreshed by the normal
  save path.

### delete

- Refused with `conflict` while the schedule has an `activeTrigger` or a live
  controller, so no execution can release into a deleted record.
- Otherwise removes the file through `store.fileFor()` and then the in-memory
  entry, inside the Scheduler's state lock. The HTTP layer never touches a file.
- Deleting a plan does **not** delete research run history: runs are owned by
  the AGT-028 run store and remain readable by id.
- Cross-process concurrency is still the documented AGT-030 POC limit: one
  scheduler process per state directory. The API does not add a distributed
  lock.

## 10. Research read path

`GET /v1/runs` and `/v1/runs/:runId` call the existing
`listResearchRuns()`/`readResearchRun()`. Run filtering by `scheduleId` uses the
schedule's own persisted trigger `runId`s as the linkage; the run store stays the
single source of run records. There is no API-side run index, and a run created
by another caller/process appears automatically.

`GET /v1/runs/:runId/report` returns the report text plus a bounded (100)
projection of `sources.json` and its summary. Missing run → 404; malformed run
id → 400; corrupt local artifact → generic 500 (no path/stack).

## 11. Tests and commands

All commands below were executed in this worktree on Node `v22.23.2`.

| Layer | File | Count | Proves |
| --- | --- | --- | --- |
| T1 contract | `tests/agt-034-api-t1.test.mjs` | 11 | envelopes, 404/405, schema/body/query limits, loopback refusal, delivery closure, secret/path/stack filtering |
| T2 integration | `tests/agt-034-api-t2.test.mjs` | 7 | API↔Scheduler state equality, active-run conflict, busy slot, pause/enable/completed, cancel→executor, research reads, restart consistency |
| T3 chain | `tests/agt-034-api-t3.test.mjs` | 1 | real HTTP create → run-now → run/report → pause/enable/update → restart → delete, run history retention |
| Lifecycle | `tests/agt-034-api-lifecycle.test.mjs` | 4 | idempotent stop, bounded graceful drain, forced close after bound, no restart after stop, start/stop race |

```bash
node --test tests/agt-034-*.test.mjs
# 23 tests, 23 pass, 0 fail

npm test
# 422 tests, 422 pass, 0 fail, 0 skipped (baseline 399 + 23 AGT-034)
```

T3/T2 use the real Scheduler `startResearch()` executor and real run store; only
the AGT-027 runtime port and research tool layer are deterministic fixtures.
No test replaces `startResearch`, the executor or the run store.

## 12. Local smoke evidence

Command:

```bash
node scripts/agt-034/api-smoke.mjs   # npm run api:smoke
```

It creates a temporary state directory, starts the real loopback server and
fixture-model research executor, and prints JSON Lines. Captured run
(`result.ok = true`, exit 0):

```json
{"event":"bind-policy","requestedHost":"0.0.0.0","rejected":true,"code":"invalid_request"}
{"event":"listen","host":"127.0.0.1","family":"IPv4","port":58014,"url":"http://127.0.0.1:58014/v1"}
{"event":"request","label":"health","method":"GET","path":"/health","status":200}
{"event":"request","label":"status","method":"GET","path":"/status","status":200}
{"event":"request","label":"create","method":"POST","path":"/schedules","status":201}
{"event":"schedule","scheduleId":"smoke-daily","nextRunAt":"2026-11-03T01:00:00.000Z","status":"active"}
{"event":"request","label":"list","method":"GET","path":"/schedules","status":200}
{"event":"request","label":"get","method":"GET","path":"/schedules/smoke-daily","status":200}
{"event":"request","label":"update","method":"PATCH","path":"/schedules/smoke-daily","status":200}
{"event":"request","label":"run-now","method":"POST","path":"/schedules/smoke-daily/run-now","status":200}
{"event":"run-now","scheduleId":"smoke-daily","triggerStatus":"succeeded","researchStatus":"completed","runId":"r-20261103T000000-d971d9"}
{"event":"request","label":"runs","method":"GET","path":"/runs?scheduleId=smoke-daily","status":200}
{"event":"request","label":"run","method":"GET","path":"/runs/r-20261103T000000-d971d9","status":200}
{"event":"request","label":"report","method":"GET","path":"/runs/r-20261103T000000-d971d9/report","status":200}
{"event":"report","runId":"r-20261103T000000-d971d9","reportChars":244,"sourcesTotal":0}
{"event":"request","label":"delivery","method":"GET","path":"/runs/r-20261103T000000-d971d9/delivery","status":404,"code":"not_found"}
{"event":"request","label":"pause","method":"POST","path":"/schedules/smoke-daily/pause","status":200}
{"event":"request","label":"enable","method":"POST","path":"/schedules/smoke-daily/enable","status":200}
{"event":"listen","phase":"restart","host":"127.0.0.1","port":58017,"url":"http://127.0.0.1:58017/v1"}
{"event":"request","label":"get-after-restart","method":"GET","path":"/schedules/smoke-daily","status":200}
{"event":"restart-consistency","before":{"scheduleId":"smoke-daily","nextRunAt":"2026-11-03T01:00:00.000Z","lastRunId":"r-20261103T000000-d971d9","triggerCount":1},"after":{"scheduleId":"smoke-daily","nextRunAt":"2026-11-03T01:00:00.000Z","lastRunId":"r-20261103T000000-d971d9","triggerCount":1},"consistent":true}
{"event":"request","label":"run-after-restart","method":"GET","path":"/runs/r-20261103T000000-d971d9/report","status":200}
{"event":"request","label":"delete","method":"DELETE","path":"/schedules/smoke-daily","status":200}
{"event":"request","label":"get-after-delete","method":"GET","path":"/schedules/smoke-daily","status":404,"code":"not_found"}
{"event":"request","label":"runs-after-delete","method":"GET","path":"/runs","status":200}
{"event":"stop","drained":true}
{"event":"result","ok":true,"requests":18}
```

The smoke records listener address/port, status codes, schedule id and run id; it
does not record credentials, request bodies, report content or environment
values. Ports are ephemeral and differ per run.

## 13. Explicitly unverified / not implemented

- **No Cloud Auth integration.** No service identity, delegated token, account
  mapping or session; any local process that can reach the loopback port is
  trusted. Do not expose this listener through a proxy/public bind.
- **No public listener, TLS, CORS, rate limiting or hardening.** Only the 64 KiB
  body cap, list limit and scheduler's own concurrency limit apply.
- **No delivery endpoint/state.** Conditional closure described in §2.
- **No real model/network live run** in this card's evidence. The smoke/API
  integration uses the repository's deterministic runtime/tool fixture; the real
  AGT-028 executor and run store are exercised, but not a live provider.
- **`run-now` is request-synchronous** as described in §4; there is no async job
  acknowledgement queue in this card.
- **Single process per state directory.** No cross-process lock, distributed
  exactly-once, or multi-instance coordination.
- **`GET /v1/status` scans the run directory** to count runs. Fine for the local
  POC; a future production store should provide a bounded summary query.
- **No browser console**, UI route or Cloud Auth page.
- **No merge, Issue closure or deployment.** The PR is a Draft to `dev`.
