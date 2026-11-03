# AGT-030 · Recoverable scheduled research (POC)

Status: local POC complete; Draft PR target `dev`; no merge, deployment or
production scheduler.
Owning Issue: [#10](https://github.com/uichat-mira/cloud-pi/issues/10).
Base: `origin/dev` at `9a8bf1f235bfdd976b314cde8a8c4e4e1351a1a1` (AGT-028/AGT-027
merged). Branch: `feat/agt-030-scheduler-poc`.

This document is the design, contract and evidence index for the POC. It does
not claim a live model run, real network research, distributed scheduling or
production readiness. The concrete local evidence is in
[`docs/evidence/agt-030/restart-recovery.txt`](../evidence/agt-030/restart-recovery.txt).

## 1. What this proves

One Cloud Pi process can load a persisted schedule, fire the **existing**
AGT-028 research executor at a stated IANA wall-clock time, persist the run id,
and still explain what happened after:

- a clean process restart;
- a hard exit in the middle of the executor call;
- a duplicate tick / duplicate callback;
- a research failure, cancellation or timeout.

The intended proof chain is:

```
schedule file
  → due calculation in an explicit IANA timezone
  → stable trigger claim (scheduleId + scheduledFor)
  → existing startResearch() (AGT-028 executor)
  → existing run store (run.json / report.md)
  → persisted trigger outcome + run id
  → readResearchRun() readable result
```

T3 exercises that chain with the real executor and real run store; only the
AGT-027 runtime port and research tool layer are deterministic fixtures.

## 2. Policy and code read first

Before implementation, the current remote material was read rather than copied
from an older plan:

- [Mira Organization AGENTS](https://github.com/uichat-mira/.github/blob/main/AGENTS.md);
- the current organization `execute-work-item` skill and its quality/evidence
  rules;
- [`AGENTS.md`](../../AGENTS.md) in this repository;
- Issue #10 body and comments;
- the current `dev` research/runtime code: `src/research/execute.mjs`,
  `run-store.mjs`, `contracts.mjs`, `index.mjs`, AGT-027 `src/runtime.mjs`, and
  the existing AGT-028 tests.

No production config, credential, `.env` value or remote system was read or
changed.

## 3. Ownership boundary

The scheduler owns only:

1. **When** an occurrence is due (explicit IANA timezone, injected clock).
2. **Which schedule** it belongs to and which occurrence is being claimed.
3. **Allowed?** enable/pause/run-now state.
4. **Repeat?** persisted next fire time.
5. **Recover?** stale lease, missed-run policy and audit trail.
6. **Run id** returned by the existing executor, plus the trigger outcome.

It does **not** own, create or duplicate:

- an Agent Runtime or Pi session (AGT-027 owns that);
- a Provider/model client;
- a Research Executor or report writer (AGT-028 owns those);
- a research run store;
- an MCP client;
- a delivery channel.

### Why `startResearch()` rather than `executeResearch()`

The Issue allows “`executeResearch()` or its public equivalent”. The existing
module exposes two public entry points that share `prepareExecution()`:

- `executeResearch(request, deps)` resolves with the persisted run record, so its
  run id is only observable after completion. A scheduler using it could not
  persist a lease/run id while the run is in flight.
- `startResearch(request, deps)` persists `run.json`, then returns
  `{ runId, done }`; `done` resolves with the same record as `executeResearch`.

The scheduler therefore uses `startResearch()`. This is the non-blocking public
form of the same executor, not a fork or a second executor. T3 imports the real
function and does not inject `startResearchFn`; only T2 uses that hook to test
the executor-call contract.

## 4. Candidate selection

Candidates were checked against the npm registry and their package contents at
implementation time. Versions are pinned where used. “Node” is the declared
`engines.node`; “not declared” means the registry metadata did not state one.

| Candidate | Version / license / Node | Timezone | Persistence & restart | Dedupe / cancellation | Pi/CLI-agent coupling | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| `croner` | `11.0.0`, MIT, `>=18` | IANA via `Intl`; `nextRun`/`nextRuns`/`getOnce` | none; in-memory calculator | none; no host state | none | **Selected for time math only.** Persistence, leases, restart and dedupe are host glue because croner deliberately has none. |
| `node-cron` | `4.6.0`, ISC, `>=20` | IANA | in-memory timers; no durable definitions | none | none | Not used. Same time math plus timers, but still no persistence/recovery; implies a larger scheduler loop we would have to replace. |
| `cron-parser` | `5.10.3`, MIT, `>=18` | IANA via Luxon | none; pure parser | none | none | Not used. Good parser, but adds Luxon and still requires all host state/dedupe. |
| `agenda` | `6.2.7`, MIT, `>=18` | IANA | MongoDB-backed jobs, restart-friendly | job locking, repeat/unique options | none | Not used. Correct shape but requires an external database and a much larger dependency surface; outside the single-process/local-file POC. |
| `pi-scheduler` | `0.3.2`, MIT, node not declared | croner (`^9`) | `.pi/scheduler.json`, reloaded on session start; fires while the Pi extension session runs | task-level only | Pi extension; no AGT-028 run store | Design reference, not a dependency. Its persisted queue is a useful comparison; it does not persist a host run id / recovery decision for an external executor. |
| `@vincentff/pi-scheduler` | `1.0.3`, MIT | timed prompts | extension-scoped | none | Pi extension | Not used. Timed prompt templates, not a host scheduler with run-store linkage. |
| `@zhushanwen/pi-scheduler` | `0.13.0`, license not declared in registry metadata | croner (`^9`) | Pi extension state | extension-level | Pi extension | Not used. Larger extension stack; no evidence of AGT-028 integration. |
| `@amaster.ai/pi-task-scheduler` | `0.1.35`, Apache-2.0 | croner (`^10`) | Pi task tools | extension-level | Pi extension | Not used. LLM-callable task management, not a recoverable host trigger contract. |
| `agents-cron` | `0.16.0`, **AGPL-3.0**, `>=22.19` | croner (`^9`) | isolated agent sessions | task-level | Pi extension | **Excluded.** AGPL-3.0 is incompatible with this dependency policy; read only as a design reference, no code or dependency copied. |
| `@fookhsu/pi-scheduler` | `0.6.2`, MIT, `>=22.19` | — | renamed stub | — | depends on `agents-cron` | **Excluded transitively.** MIT wrapper around an AGPL-3.0 package is not a safe dependency here. |

Conclusion: none of the Pi scheduling plugins both (a) persists an explicit
host-level schedule/lease and (b) integrates with the existing AGT-028 run
store/restart semantics. Adding one would either duplicate the executor
boundary or pull in an unverified extension stack. `croner` is used only as a
pure recurrence calculator; the small amount of persistence, dedupe and
recovery code is the POC’s actual subject.

## 5. Module layout and API

```
src/
  fs/atomic.mjs                    shared atomic file replacement
  scheduler/
    contracts.mjs                  frozen enums, ids, errors, limits, policy
    schedule.mjs                   timezone/once/cron math, normalization, dedupe keys
    store.mjs                      schedule persistence (<stateDir>/schedules/*.json)
    scheduler.mjs                  single-process engine: tick, lease, run-now, recovery
    index.mjs                      public internal API
  research/run-store.mjs           now uses the shared atomic helper (no behaviour change)
scripts/
  scheduler-poc-child.mjs          one process per evidence phase
  scheduler-poc-evidence.mjs       parent: clean restart + hard-exit recovery
tests/
  scheduler-t1.test.mjs            11 unit tests
  scheduler-t2.test.mjs            12 contract/persistence tests
  scheduler-t3.test.mjs            6 real-executor integration tests
  helpers/scheduler-fixture.mjs     deterministic clock/runtime/tool fixtures
  helpers/next-run-child.mjs        process-TZ independence probe
```

Internal API (`createScheduler(options)`):

| Operation | Method | Notes |
| --- | --- | --- |
| create | `createSchedule(input)` | Validates and writes atomically; computes first fire. |
| load | `createScheduler()` / `load()` | **Startup/idle-only.** Loads every definition; no timer starts. Returns `scheduler_busy` while the tick loop runs or a run/tick is in flight instead of hot-reloading the in-memory map. |
| enable | `enable(id)` | Recomputes after `now`; records a `missed` audit trigger if a window was skipped. |
| pause | `pause(id)` | Stops firing; keeps `nextRunAt` for visibility. |
| run-now | `runNow(id)` | Starts one run immediately; works while paused/completed; does not consume the next occurrence. |
| start | `start({tickIntervalMs})` | Recovers stale leases once, then ticks. |
| stop | `stop({abortActive})` | Stops timer; by default aborts and awaits active runs. |
| deterministic tick | `tick()` | Used by tests/evidence; fires all currently due schedules serially. |
| cancel | `cancel(id)` | Aborts the active executor signal for that schedule. |

There is deliberately no HTTP API.

## 6. Persistence contract

State root resolution: explicit `stateDir` option → `SCHEDULER_STATE_DIR` →
`.work/scheduler` (relative to the process cwd). Each schedule is one file:

```
<stateDir>/schedules/<scheduleId>.json
```

Writes use `src/fs/atomic.mjs`: create the directory, write
`.<random>.tmp` in the **same** directory, `rename()` over the target, and clean
up the temp file on failure. This makes a reader see either the old or the new
complete file, not a torn write. There is no `fsync`; a machine power loss can
still lose the latest rename, which would be recovered as a stale/missed lease.

Frozen schedule shape (`contractVersion: 1`):

```json
{
  "contractVersion": 1,
  "scheduleId": "poc-daily",
  "name": "",
  "kind": "recurring",
  "timezone": "Asia/Shanghai",
  "cron": "0 9 * * *",
  "onceAt": null,
  "onceAtUtc": null,
  "request": {
    "topic": "研究最近 48 小时 AI Agent 工程进展",
    "goal": "",
    "timeRange": "48h",
    "limits": { "maxRuntimeMs": 480000, "maxTurns": 36 }
  },
  "status": "active",
  "missedRunPolicy": "coalesce_one",
  "createdAt": "2026-11-03T00:00:00.000Z",
  "updatedAt": "2026-11-03T01:00:00.000Z",
  "nextRunAt": "2026-11-04T01:00:00.000Z",
  "completedAt": null,
  "lastRunId": "r-20261103T010000-b0d7e8",
  "lastRun": {
    "dedupeKey": "poc-daily@2026-11-03T01:00:00.000Z",
    "scheduledFor": "2026-11-03T01:00:00.000Z",
    "runId": "r-20261103T010000-b0d7e8",
    "status": "succeeded",
    "researchStatus": "completed",
    "startedAt": "2026-11-03T01:00:00.000Z",
    "finishedAt": "2026-11-03T01:00:02.100Z",
    "durationMs": 2100
  },
  "activeTrigger": null,
  "triggers": [],
  "stats": {
    "triggers": 1,
    "succeeded": 1,
    "partial": 0,
    "failed": 0,
    "cancelled": 0,
    "timeout": 0,
    "interrupted": 0,
    "missed": 0,
    "duplicatesSkipped": 0
  }
}
```

Trigger entry fields: `dedupeKey`, `scheduledFor`, `triggerAt`, `claimedAt`,
`runId`, `status`, `researchStatus`, `manual`, `catchUp`, `missedCount`,
`missedThrough`, `capped`, `lateByMs`, `finishedAt`, `durationMs`, `error`.
History is bounded to `LIMITS.maxTriggerHistory = 100`; the active entry is never
trimmed. A malformed/foreign JSON file fails the load with `parse_error`; it is
never silently dropped.

### Status model

| Layer | Values |
| --- | --- |
| Schedule | `active`, `paused`, `completed` |
| Trigger while in flight | `scheduled`, `started` |
| Trigger terminal | `succeeded`, `partial`, `failed`, `cancelled`, `timeout`, `interrupted`, `missed` |
| Research run (AGT-028) | `running`, `completed`, `completed_with_errors`, `failed`, `cancelled`, `timeout` |

Mapping: `completed → succeeded`, `completed_with_errors → partial` (never a
clean success), `failed/cancelled/timeout` map to the same trigger names. A
scheduler failure before the executor returns a run id is `failed` with an error
record.

## 7. Time semantics

- `once`: `{kind:"once", timezone:"Asia/Shanghai", at:"2026-11-05T09:00"}`.
  The local wall time is parsed against the named IANA zone; the persisted
  `onceAtUtc` is the instant. A nonexistent DST-gap wall time is rejected; an
  ambiguous repeated wall time resolves to the earlier instant, consistently
  with the selected calculator. A past `once` cannot be created.
- `recurring`: `{kind:"recurring", timezone:"Asia/Shanghai", cron:"0 9 * * *"}`.
  Recurrence is always evaluated in the explicit zone; the host process `TZ` is
  irrelevant. UTC and IANA schedules are stored as UTC instants.
- `nextRunAt` is always strictly after `now` after a claim, so a tick cannot
  re-fire the same occurrence.
- Normal late tick: if nothing was skipped, `lateByMs` records lateness but the
  trigger is not artificially marked as catch-up.
- Paused: no tick fires. `enable` computes the skipped window and appends one
  `missed` audit trigger; it does not replay the window.
- A one-time schedule becomes `completed` when its occurrence is claimed (or
  skipped); a failed research run does not make the occurrence available again.

## 8. Missed-run policy (frozen)

`missedRunPolicy` is persisted as `coalesce_one` and is not a free-form option.

1. On startup/tick, if `nextRunAt` is in the past, `collectDueOccurrences()`
   enumerates due occurrences from that instant through `now`, bounded by
   `LIMITS.maxMissedScan = 1000` (the result records `capped`/`missedThrough`).
2. Exactly **one** catch-up trigger is claimed for the earliest missed
   occurrence. The trigger records `missedCount`, `missedThrough`, `catchUp`
   and the final `scheduledFor`.
3. `nextRunAt` advances to the first occurrence strictly after `now`; no
   intermediate occurrence is replayed.
4. The claimed catch-up goes through the same executor/run-store path and the
   same dedupe key (`scheduleId@scheduledFor`). A restart after that claim
   recovers the lease rather than starting another run.
5. Pause/enable uses the same one-shot idea but records a `missed` trigger
   instead of a catch-up run, because the user explicitly paused. A skipped
   occurrence is therefore never silently neither run nor recorded.

This is intentionally time-sensitive-unfriendly: a long outage produces one
late run, not a burst. That is the POC decision; production policy should be
revisited with users.

## 9. Idempotency, concurrency and failure release

- Dedupe key is `` `${scheduleId}@${scheduledFor.toISOString()}` `` (manual runs
  use a separate random key). The research run id is **not** used as the
  pre-trigger key, because it does not exist before the executor starts.
- The claim is persisted (`activeTrigger`, trigger `scheduled`, `nextRunAt`
  advanced, `stats.triggers++`) **before** calling the executor. A duplicate
  tick sees `activeTrigger` or an already-present dedupe key and starts nothing;
  a duplicate callback arriving after a restart is skipped by the persisted
  key.
- Single process, global concurrency 1: one active run at a time across all
  schedules. AGT-027’s runtime is not safe for concurrent sessions on one
  instance, so different schedules are serialized rather than overlapped.
  `runNow` and a second tick return `scheduler_busy` while a run is active.
- The in-memory slot is released in a `finally` after every success/failure;
  the persisted `activeTrigger` is cleared in the same terminal write. A
  failure therefore does not poison the next occurrence.
- If the process dies between claim and executor return, the next startup marks
  the trigger `interrupted`, clears the lease and continues; it never
  automatically retries that consumed occurrence. If the run already reached a
  terminal state in the run store, recovery adopts that real status instead of
  inventing one.

## 10. Cancellation and timeout

- The scheduler passes its clock as `deps.now` (bound function, so the executor
  cannot lose `this`) and an `AbortController` signal as `deps.signal`.
- `cancel(id)` aborts that controller; AGT-028’s executor attaches an abort
  listener, aborts its internal controller, and persists `cancelled`.
- `stop({abortActive:true})` (the default) aborts every active schedule and
  awaits settlement. `stop({abortActive:false})` drains without cancelling.
- Timeout is owned by AGT-028: the schedule’s `limits.maxRuntimeMs` drives the
  executor deadline and the run store records `timeout`. The scheduler maps it
  to trigger `timeout`; it never reports a timeout as success.
- Limitation: if an injected/runtime port ignores the abort signal and never
  resolves, the executor’s `await runAgent()` still hangs after abort. The POC
  does not kill the OS process or fabricate a terminal result; a production
  adapter must enforce process-level timeouts.

## 11. Tests and evidence

All commands were run in this worktree on Node `v22.23.2` (npm `10.9.8`).

| Layer | File | Count | What it proves |
| --- | --- | --- | --- |
| T1 unit | `tests/scheduler-t1.test.mjs` | 11 | once/cron parsing, IANA zones, DST gap/ambiguous handling, process-TZ independence, pause, run-now, stable dedupe, coalesced catch-up, start/stop, schema/temp files |
| T2 contract | `tests/scheduler-t2.test.mjs` | 12 | reload, corrupt-file fail-closed, lease blocking, persisted duplicate callback, failure release, partial status, cancellation, timeout, executor contract, terminal and orphaned recovery |
| T3 integration | `tests/scheduler-t3.test.mjs` | 6 | real `startResearch()` → real run store → `readResearchRun()`; due tick, pause, duplicate tick, clean restart, failure-then-success, restart catch-up |

```bash
npm run test:scheduler   # 29 tests passed
npm test                 # 349 tests passed (full suite, 126 top-level entries)
npm run scheduler:poc    # local restart/recovery evidence, no model/network
```

T3’s fixture replaces only `runtimePort` and `toolLayer` (the model/network
boundary). It does not replace `startResearch`, the executor, the run store or
`readResearchRun`. The test asserts the returned `runId` is readable from the
run store and that `report.md` contains the fixture’s Markdown report.

### Local restart/recovery evidence

`docs/evidence/agt-030/restart-recovery.txt` is the captured output of
`npm run scheduler:poc`. It uses separate child processes, `TZ=UTC`, a fixed
clock, and the same production executor/run-store modules:

- **Scenario A — clean restart.** Process 1 creates `poc-daily` at
  `2026-11-03T00:55Z`, fires the `Asia/Shanghai 09:00` occurrence at
  `2026-11-03T01:00Z`, and exits. Process 2 starts on `2026-11-04T01:00Z`,
  reloads `nextRunAt = 2026-11-04T01:00:00Z`, runs exactly one new occurrence,
  and leaves `nextRunAt = 2026-11-05T01:00:00Z`. Both run ids are present in the
  run store with `status: completed` and a readable report.
- **Scenario B — hard exit mid-run.** Process 1 claims the occurrence and exits
  with code 42 while the run store still says `running`; the schedule file
  contains `activeTrigger` with the run id. Process 2 starts on
  `2026-11-04T01:00Z`, recovers that trigger as `interrupted`
  (`researchStatus: "running"`, error explains the orphan) and clears the
  lease; the next due occurrence then runs normally as `succeeded`. A duplicate
  tick in the same process starts nothing.

The evidence output includes the schedule id, run ids, before/after
`nextRunAt`, trigger statuses, stats, and report lengths. It contains no
credential or private data.

### Not proven

- No live model or real network run was made; all report text comes from the
  deterministic runtime fixture. A live run is optional in the Issue and was
  not required to prove scheduling.
- No multi-process concurrency, distributed lock, leader election or external
  database was tested.
- No HTTP API, Cloud Auth UI/API, Feishu delivery, Guanlan writeback,
  auto-publishing, Docker or deployment was added.

## 12. Known limits and follow-ups

- Single process and global concurrency 1 limit throughput. That is deliberate
  for the POC and for AGT-027’s single-runtime constraint.
- Atomic rename without `fsync` is not power-loss durable; a production store
  needs a durability decision (fsync, SQLite or a managed database).
- A failed `_save` can leave the in-memory schedule already mutated (lease
  applied, trigger appended) while disk still holds the previous version. The
  instance then disagrees with disk until it is restarted; this POC has no
  write-ahead record or in-memory rollback.
- After a hard exit the scheduler recovers its lease as `interrupted`, but
  AGT-028’s own `run.json` may keep reporting `running` indefinitely, since the
  two stores are not reconciled by this card.
- The wall clock is the source of truth; a backward clock jump can make a
  schedule appear not due. Host time sync is assumed.
- A completely unresponsive runtime port can exceed the executor deadline
  because the executor awaits the port promise; process-level enforcement is a
  future hardening item.
- Persisted `request` text is plaintext local state (no credentials are
  expected in a research request). Operators must keep the state directory
  private.
- The missed-run policy is intentionally frozen for this POC; real product
  behavior (for example “skip if older than N hours”) is a user decision.
- `runNow` while a run is active is rejected rather than queued. Queuing is not
  part of this Issue.

## 13. Reproduction

```bash
git checkout feat/agt-030-scheduler-poc
npm ci
npm run test:scheduler
npm test
npm run scheduler:poc
```

The Draft PR body records the implementation head SHA and links Issue #10.
