#!/usr/bin/env node
/**
 * AGT-036 delivery live run: scheduled research → real WeCom push.
 *
 * One process, one real WeCom long connection, the real scheduler, the real
 * research executor and the real delivery stage. It does exactly what the
 * product does — no second executor, no fixture in the live path:
 *
 *   1. start the app (WeCom channel + scheduler + delivery + loopback API)
 *   2. wait for one inbound message so the conversation is a legal push target
 *   3. create a schedule whose deliveryTargets are that conversation
 *   4. run it now (manual trigger) → real research run → terminal state
 *   5. the delivery stage pushes the report back into the same conversation
 *   6. append a masked evidence line (runId, scheduleId, segments, errcode)
 *
 * `--self-test` swaps only the model port and the WeCom transport for doubles so
 * the whole harness can be validated offline. Its output is clearly labelled and
 * is **not** evidence: a run is only evidence when `mode` is `live`.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCloudAgentApp } from "../../src/app.mjs";
import { createDeliveringScheduler } from "../../src/delivery/scheduler.mjs";
import { createKnownSessionStore } from "../../src/channels/wecom/sessions.mjs";
import { hashId } from "../../src/channels/wecom/config.mjs";
import { loadEnvFile } from "../../src/env-file.mjs";

const DEFAULT_INBOUND_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_EVIDENCE = ".work/agt-036-delivery/live-evidence.jsonl";
const DEFAULT_TOPIC = "检索过去 24 小时 AI Agent 工程领域的一条真实进展，用两句话总结";
const POLL_MS = 500;

function parseArgs(argv) {
  const options = {
    mode: "live",
    secrets: process.env.CLOUD_AGENT_WECOM_SECRETS ?? "C:\\Users\\Administrator\\.mira-secrets\\wecom.env",
    envFile: process.env.CLOUD_AGENT_ENV_FILE ?? "D:\\cloud-pi\\.env",
    inboundTimeoutMs: DEFAULT_INBOUND_TIMEOUT_MS,
    deliveryTimeoutMs: DEFAULT_DELIVERY_TIMEOUT_MS,
    evidence: DEFAULT_EVIDENCE,
    topic: DEFAULT_TOPIC,
    targetType: "wecom_user",
    stateDir: ".work/agt-036-delivery",
  };
  for (const arg of argv) {
    const [flag, rawValue] = arg.split("=");
    const value = rawValue === undefined ? "" : rawValue;
    switch (flag) {
      case "--secrets":
        options.secrets = value;
        break;
      case "--env-file":
        options.envFile = value;
        break;
      case "--inbound-timeout-ms":
        options.inboundTimeoutMs = Number(value);
        break;
      case "--delivery-timeout-ms":
        options.deliveryTimeoutMs = Number(value);
        break;
      case "--evidence":
        options.evidence = value;
        break;
      case "--topic":
        options.topic = value;
        break;
      case "--target":
        options.targetType = value;
        break;
      case "--state-dir":
        options.stateDir = value;
        break;
      case "--self-test":
        options.mode = "self-test";
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function readEnvIfPresent(path) {
  try {
    return await loadEnvFile(resolve(path));
  } catch {
    return {};
  }
}

/** Loop until `probe()` returns a truthy value or the budget runs out. */
async function waitFor(probe, { timeoutMs, intervalMs = POLL_MS, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

function fakeWecomTransport() {
  const calls = [];
  return {
    calls,
    async send({ chatId, chatType, text }) {
      calls.push({ chatId, chatType, bytes: Buffer.byteLength(text, "utf8") });
      return { delivered: true, errcode: 0 };
    },
  };
}

/**
 * Offline-only doubles. They replace the model port, the research tool layer and
 * the WeCom transport — never the scheduler, the delivery stage or the run store.
 */
async function selfTestDeps({ stateDir, runsDir }) {
  const { completedPort, researchDeps } = await import("../../tests/helpers/scheduler-fixture.mjs");
  const transport = fakeWecomTransport();
  const sessions = createKnownSessionStore({});
  sessions.record({ chatId: "self-test-user", chatType: "single" });
  return {
    transport,
    sessions,
    deps: {
      createDeliveringScheduler: async ({ schedulerOptions, delivery }) =>
        createDeliveringScheduler({
          schedulerOptions: { ...schedulerOptions, researchDeps: researchDeps({ rootDir: runsDir, port: completedPort() }) },
          delivery,
        }),
      startWecom: async () => ({
        sessions,
        transport,
        describe: () => ({ config: { mode: "self-test" } }),
        async stop() {
          return { drained: true };
        },
      }),
    },
  };
}

async function writeEvidence(path, entry) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await appendFile(resolve(path), `${JSON.stringify(entry)}\n`, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stateDir = resolve(options.stateDir);
  const runsDir = resolve(stateDir, "runs");
  const secrets = await readEnvIfPresent(options.secrets);
  const modelEnv = await readEnvIfPresent(options.envFile);

  const env = {
    ...modelEnv,
    ...secrets,
    CLOUD_AGENT_CHANNELS: "wecom",
    CLOUD_AGENT_STATE_DIR: stateDir,
    RESEARCH_RUNS_DIR: runsDir,
    CLOUD_AGENT_API_PORT: "0",
    CLOUD_AGENT_TICK_INTERVAL_MS: "1000",
    // Research egress goes through the local proxy; the WeCom socket must not.
    RESEARCH_HTTPS_PROXY: process.env.RESEARCH_HTTPS_PROXY ?? "http://127.0.0.1:1080",
  };
  delete env.HTTPS_PROXY;
  delete env.HTTP_PROXY;

  const selfTest = options.mode === "self-test" ? await selfTestDeps({ stateDir, runsDir }) : null;
  if (selfTest) env.CLOUD_AGENT_STATE_DIR = stateDir;

  const app = createCloudAgentApp({ env, ...(selfTest ? { deps: selfTest.deps } : {}) });

  const startedAt = Date.now();
  await app.start();
  process.stdout.write(
    `${JSON.stringify({ event: "agt036_delivery_started", mode: options.mode, api: app.api?.address?.url ?? null })}\n`,
  );

  let exitCode = 0;
  let summary;
  let testScheduleId;
  try {
    const service = app.channels.wecom;
    if (!service) throw new Error("the wecom channel did not start; nothing to push to");

    // 1. A conversation the bot has already seen is the only legal push target.
    if (!selfTest) {
      process.stdout.write(`${JSON.stringify({ event: "agt036_delivery_waiting_inbound" })}\n`);
    }
    const session = await waitFor(
      () => service.sessions.entries().find((entry) => entry.chatType === (options.targetType === "wecom_chat" ? "group" : "single")),
      { timeoutMs: selfTest ? 5_000 : options.inboundTimeoutMs, label: "an inbound WeCom message" },
    );

    // 2. The target comes from the conversation the platform itself reported; it
    //    is never derived from a message body or a model output.
    const target = {
      type: options.targetType,
      id: session.chatId,
      label: options.targetType === "wecom_chat" ? "定时研究群" : "定时研究单聊",
    };
    // Persist the test as a PAUSED one-off from its very first write. Even a
    // forced kill cannot leave an armed daily schedule that sends later.
    // Scheduler.runNow() explicitly accepts paused one-off schedules.
    const schedule = await app.scheduler.createSchedule({
      kind: "once",
      timezone: "UTC",
      at: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString().slice(0, 19),
      enabled: false,
      request: { topic: options.topic, timeRange: "24h" },
      deliveryTargets: [target],
    });
    testScheduleId = schedule.scheduleId;

    // 3. Manual trigger of the same path a cron tick would take.
    const trigger = await app.scheduler.runNow(schedule.scheduleId);
    const runId = trigger?.runId;
    if (!runId) throw new Error("the scheduler returned no run id");

    // 4. Delivery is a separate stage; read its own record, not the run status.
    const delivery = await waitFor(
      async () => {
        const view = await app.getRunDelivery(runId);
        if (!view) return null;
        return view.deliveryStatus === "pending" ? null : view;
      },
      { timeoutMs: options.deliveryTimeoutMs, label: "a terminal delivery record" },
    );

    const records = await app.coordinator.listRecords(runId);
    const acks = records.flatMap((record) => record.segmentsSent.map((segment) => segment.ack?.errcode ?? null));
    summary = {
      event: "agt036_delivery_live",
      mode: options.mode,
      at: new Date().toISOString(),
      scheduleId: schedule.scheduleId,
      scheduleMode: "paused_once",
      runId,
      targetType: target.type,
      destinationMasked: hashId(target.id),
      researchStatus: delivery.researchStatus,
      triggerStatus: delivery.triggerStatus,
      deliveryStatus: delivery.deliveryStatus,
      segments: records.reduce((total, record) => total + record.segmentsSent.length, 0),
      acks,
      attempts: records.reduce((total, record) => total + record.attempts, 0),
      lastError: records.find((record) => record.lastError)?.lastError ?? null,
      durationMs: Date.now() - startedAt,
    };
    exitCode = delivery.deliveryStatus === "sent" ? 0 : 1;
  } catch (error) {
    summary = {
      event: "agt036_delivery_live",
      mode: options.mode,
      at: new Date().toISOString(),
      ok: false,
      error: { code: error?.code ?? "error", message: String(error?.message ?? error).slice(0, 300) },
      durationMs: Date.now() - startedAt,
    };
    exitCode = error?.code === "app_config_error" ? 2 : 1;
  } finally {
    // Drain the run and delivery before removing ONLY this invocation's schedule.
    // Never enumerate or delete other schedules in an existing workspace.
    try {
      await app.stop();
    } catch (error) {
      exitCode = 1;
      summary = {
        ...(summary ?? { event: "agt036_delivery_live", mode: options.mode }),
        stopError: { code: String(error?.code ?? "stop_failed") },
      };
    }
    if (testScheduleId) {
      try {
        const deleted = await app.scheduler.deleteSchedule(testScheduleId);
        if (deleted?.deleted !== true) throw new Error("scheduler did not confirm deletion");
        summary = { ...summary, scheduleId: testScheduleId, scheduleMode: "paused_once", cleanup: { scheduleDeleted: true } };
      } catch (error) {
        // It was born paused: even a failed cleanup cannot auto-send later.
        // Still report nonzero so no one mistakes the probe for a clean run.
        exitCode = 1;
        summary = {
          ...(summary ?? { event: "agt036_delivery_live", mode: options.mode }),
          scheduleId: testScheduleId,
          scheduleMode: "paused_once",
          cleanup: { scheduleDeleted: false, code: String(error?.code ?? "cleanup_failed") },
        };
      }
    }
  }

  await writeEvidence(options.evidence, summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = exitCode;
}

await main();
