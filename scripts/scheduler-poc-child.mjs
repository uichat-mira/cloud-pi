/**
 * One scheduler process for the AGT-030 local restart/recovery evidence.
 *
 * The script is intentionally a child process so the parent can demonstrate a
 * real process boundary: definitions on disk, a fresh scheduler instance, and
 * recovery of an orphaned run-store lease after a hard exit.
 *
 * Usage:
 *   node scripts/scheduler-poc-child.mjs --phase seed|crash|resume \
 *     --state <dir> --runs <dir> [--created-at <iso>] --now <iso>
 */
import { join } from "node:path";
import { createScheduler } from "../src/scheduler/index.mjs";
import { listResearchRuns, readResearchRun } from "../src/research/index.mjs";
import {
  completedPort,
  createFakeClock,
  fixtureToolLayer,
  scriptedRuntimePort,
} from "../tests/helpers/scheduler-fixture.mjs";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

const phase = arg("phase");
const stateDir = arg("state");
const runsDir = arg("runs");
const nowArg = arg("now");
const createdAt = arg("created-at") ?? nowArg;
if (!phase || !stateDir || !runsDir || !nowArg) {
  console.error("missing --phase/--state/--runs/--now");
  process.exit(2);
}

const clock = createFakeClock(createdAt);
const hangingPort = scriptedRuntimePort(() => new Promise(() => {}));

function deps(port) {
  return {
    runtimePort: port,
    toolLayer: fixtureToolLayer(),
    rootDir: runsDir,
    env: {},
  };
}

function summary(schedule) {
  return {
    scheduleId: schedule.scheduleId,
    kind: schedule.kind,
    timezone: schedule.timezone,
    cron: schedule.cron,
    status: schedule.status,
    nextRunAt: schedule.nextRunAt,
    lastRun: schedule.lastRun,
    activeTrigger: schedule.activeTrigger,
    stats: schedule.stats,
    triggers: schedule.triggers.map((trigger) => ({
      dedupeKey: trigger.dedupeKey,
      scheduledFor: trigger.scheduledFor,
      status: trigger.status,
      researchStatus: trigger.researchStatus,
      runId: trigger.runId,
      catchUp: trigger.catchUp,
      missedCount: trigger.missedCount,
      recovery: trigger.recovery ?? false,
      error: trigger.error,
    })),
  };
}

async function runSummaries() {
  const runs = await listResearchRuns({ rootDir: runsDir });
  const out = [];
  for (const run of runs) {
    const { report } = await readResearchRun(run.runId, { rootDir: runsDir });
    out.push({
      runId: run.runId,
      status: run.status,
      topic: run.request?.topic,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      reportChars: report?.length ?? 0,
    });
  }
  return out;
}

async function print(extra = {}) {
  const scheduler = await createScheduler({
    stateDir,
    now: () => clock(),
    researchDeps: deps(completedPort()),
  });
  const schedules = scheduler.listSchedules();
  console.log(
    JSON.stringify(
      {
        phase,
        now: clock().toISOString(),
        stateDir,
        runsDir,
        node: process.version,
        schedules: schedules.map(summary),
        runs: await runSummaries(),
        ...extra,
      },
      null,
      2,
    ),
  );
}

async function seed() {
  const scheduler = await createScheduler({
    stateDir,
    now: () => clock(),
    researchDeps: deps(completedPort()),
  });
  let schedule = scheduler.listSchedules().find((entry) => entry.scheduleId === "poc-daily");
  if (!schedule) {
    schedule = await scheduler.createSchedule({
      scheduleId: "poc-daily",
      kind: "recurring",
      timezone: "Asia/Shanghai",
      cron: "0 9 * * *",
      request: {
        topic: "研究最近 48 小时 AI Agent 工程进展（scheduler POC 证据）",
        timeRange: "48h",
      },
    });
  }
  clock.set(nowArg);
  const result = await scheduler.tick();
  await print({ firstTick: { triggered: result.triggered.length } });
}

async function crash() {
  const scheduler = await createScheduler({
    stateDir,
    now: () => clock(),
    researchDeps: deps(hangingPort),
  });
  let schedule = scheduler.listSchedules().find((entry) => entry.scheduleId === "poc-crash");
  if (!schedule) {
    schedule = await scheduler.createSchedule({
      scheduleId: "poc-crash",
      kind: "recurring",
      timezone: "Asia/Shanghai",
      cron: "0 9 * * *",
      request: {
        topic: "研究最近 48 小时 AI Agent 工程进展（crash 证据）",
        timeRange: "48h",
      },
    });
  }
  clock.set(nowArg);
  const tickPromise = scheduler.tick();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = scheduler.getSchedule("poc-crash");
    const runs = await listResearchRuns({ rootDir: runsDir });
    if (current.activeTrigger?.runId && runs.length === 1) {
      const text = JSON.stringify(
        {
          phase: "crash",
          now: clock().toISOString(),
          note: "about to exit hard while the research run is still marked running",
          schedule: summary(current),
          runs: await runSummaries(),
        },
        null,
        2,
      );
      await new Promise((resolve) => process.stdout.write(`${text}\n`, resolve));
      process.exit(42);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  console.error("crash phase never observed a claimed run");
  process.exit(3);
}

async function resume() {
  const scheduler = await createScheduler({
    stateDir,
    now: () => clock(),
    researchDeps: deps(completedPort()),
  });
  await scheduler.start({ tickIntervalMs: 60_000 });
  await scheduler.settle();
  const afterRecovery = scheduler.listSchedules().map(summary);
  const duplicate = await scheduler.tick();
  await scheduler.stop({ abortActive: true });
  await print({
    afterRecovery,
    duplicateTickTriggered: duplicate.triggered.length,
    note: "recovery runs before the first tick; a duplicate tick starts nothing",
  });
  console.log(`process-exit-ok state-dir=${stateDir}`);
}

if (phase === "seed") await seed();
else if (phase === "crash") await crash();
else if (phase === "resume") await resume();
else {
  console.error(`unknown phase: ${phase}`);
  process.exit(2);
}
console.log(`done state=${join(stateDir)}`);
