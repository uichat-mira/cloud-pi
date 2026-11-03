#!/usr/bin/env node
/**
 * AGT-037 local evidence: assemble the *real* unified runtime, exercise it over a
 * *real* loopback socket and a *real* run store, then stop it through the real
 * graceful-shutdown path.
 *
 * What is real: the composition root, the run store, the scheduler and delivery
 * store, the management API socket, config validation, exit-code mapping.
 * What is replaced: the model call and any platform send (no credentials here, and
 * sending to a real Feishu/WeCom tenant is never part of a local smoke test).
 *
 * This is *not* evidence of real WeCom receive/send. That is t12, and it needs the
 * maintainer bot credentials.
 *
 * Usage: node scripts/agt-037/entry-smoke.mjs [--keep]
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TOOL } from "../../src/research/contracts.mjs";
import { RUNTIME_PORT_VERSION } from "../../src/research/port.mjs";
import { generateRunId } from "../../src/research/execute.mjs";
import { createChatRunRecorder } from "../../src/runs/chat-runs.mjs";
import { main } from "../../src/entry/main.mjs";

const keep = process.argv.includes("--keep");
const root = resolve(".work", "agt-037", `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const runsDir = join(root, "runs");
const stateDir = join(root, "state");

const lines = [];
const out = { write: (chunk) => lines.push(String(chunk).trimEnd()) };
const err = { write: (chunk) => lines.push(String(chunk).trimEnd()) };

function fixtureRuntimePort() {
  return {
    portVersion: RUNTIME_PORT_VERSION,
    async runAgent() {
      throw new Error("local smoke test does not call the model");
    },
  };
}

function fixtureToolLayer() {
  const tool = (name, description) => ({
    name,
    label: name,
    description,
    parameters: { type: "object", properties: {} },
    async execute() {
      throw new Error("local smoke test does not call tools");
    },
  });
  return { tools: [tool(TOOL.SEARCH, "smoke search"), tool(TOOL.READ_PAGE, "smoke read")] };
}

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

const evidence = { event: "agt037_entry_smoke", root, checks: {} };

try {
  await mkdir(root, { recursive: true });
  // An explicit but empty credential file: the smoke test must never read the
  // developer's real secrets, and an explicit missing file is itself an error.
  const emptySecrets = join(root, "empty-secrets.env");
  await writeFile(emptySecrets, "# deliberately empty: local smoke test\n");

  const env = {
    ...process.env,
    CLOUD_AGENT_CHANNELS: "none",
    CLOUD_AGENT_STATE_DIR: stateDir,
    RESEARCH_RUNS_DIR: runsDir,
    CLOUD_AGENT_API_PORT: "0",
    CLOUD_AGENT_TICK_INTERVAL_MS: "60000",
    CLOUD_AGENT_SHUTDOWN_TIMEOUT_MS: "5000",
    // Keep the smoke test offline even if the developer shell has creds.
    FEISHU_APP_ID: "",
    FEISHU_APP_SECRET: "",
    WECOM_BOT_ID: "",
    WECOM_BOT_SECRET: "",
    CLOUD_AGENT_WECOM_SECRETS: emptySecrets,
  };

  // 1. Configuration is validated before anything starts.
  const checkRun = await main({ argv: ["--check"], env, stdout: out, stderr: err, installSignals: false });
  evidence.checks.checkExitCode = checkRun.code;

  // 2. The real runtime: real lock, real scheduler, real delivery stage, real API socket.
  const started = await main({
    argv: [],
    env,
    stdout: out,
    stderr: err,
    installSignals: false,
    deps: {
      async loadResearchDeps({ runsDir: dir }) {
        return { runtimePort: fixtureRuntimePort(), toolLayer: fixtureToolLayer(), rootDir: dir, env: {}, logger: {} };
      },
    },
  });
  if (started.code !== null) {
    evidence.error = `entry exited during start (code ${started.code})`;
    throw new Error(evidence.error);
  }
  const app = started.app;
  const apiUrl = app.api.address.url; // already includes the /v1 prefix

  const health = await getJson(`${apiUrl}/health`);
  const status = await getJson(`${apiUrl}/status`);
  evidence.checks.apiUrl = apiUrl;
  evidence.checks.health = { httpStatus: health.status, ok: health.body.ok, phase: app.phase };
  evidence.checks.status = { httpStatus: status.status, uptimeFields: Object.keys(status.body.data ?? {}) };
  evidence.checks.channels = app.describe().channels;

  // 3. A channel turn written into the same run store must be readable by id.
  const recorder = createChatRunRecorder({ rootDir: runsDir, env, log: (entry) => out.write(JSON.stringify(entry)) });
  const runId = generateRunId();
  await recorder.record(
    {
      action: "replied",
      status: "succeeded",
      runId,
      durationMs: 42,
      chatType: "single",
      chatId: "id:smoke0",
      replyDelivered: true,
      segments: 1,
      segmentsDelivered: 1,
      usage: { input: 3, output: 5, total: 8 },
    },
    { channel: "wecom" },
  );
  const runRead = await getJson(`${apiUrl}/runs/${runId}`);
  evidence.checks.chatRun = {
    runId,
    httpStatus: runRead.status,
    sameRunId: runRead.body?.data?.run?.runId === runId,
    channel: runRead.body?.data?.run?.request?.channel,
    topic: runRead.body?.data?.run?.request?.topic,
  };

  // 4. Graceful drain through the real stop path.
  const stopped = await started.stop("SIGTERM");
  evidence.checks.shutdown = {
    drained: stopped?.result?.drained,
    schedulerDrained: stopped?.result?.schedulerDrained,
    apiStopped: stopped?.result?.apiStopped,
    exitCode: stopped?.code,
  };

  // 5. A configuration error must be exit code 2, not a silent start.
  const badChannel = await main({
    argv: ["--channels", "wecom"],
    env: { ...env, CLOUD_AGENT_WECOM_SECRETS: emptySecrets },
    stdout: out,
    stderr: err,
    installSignals: false,
  });
  evidence.checks.missingCredentialExitCode = badChannel.code;
} catch (error) {
  evidence.error = String(error?.message ?? error);
  evidence.checks.shutdown ??= { drained: false, exitCode: 1 };
} finally {
  const ok =
    !evidence.error &&
    evidence.checks.checkExitCode === 0 &&
    evidence.checks.health?.ok === true &&
    evidence.checks.chatRun?.sameRunId === true &&
    evidence.checks.shutdown?.drained === true &&
    evidence.checks.missingCredentialExitCode === 2;
  evidence.ok = ok;
  await mkdir(root, { recursive: true }).catch(() => {});
  await writeFile(join(root, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`).catch(() => {});
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (!keep) {
    // The evidence file is copied out first so the tree stays clean.
    await writeFile(
      join(".work", "agt-037", "entry-smoke-evidence.json"),
      `${JSON.stringify({ ...evidence, logLines: lines.slice(0, 40) }, null, 2)}\n`,
    ).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  // Exit through `exitCode` rather than `process.exit()`: on Windows an immediate
  // exit while a filesystem request is still queued trips a libuv assertion, and
  // the event loop is already empty here (API, scheduler and intervals are closed).
  process.exitCode = ok ? 0 : 1;
}
