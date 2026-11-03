/**
 * AGT-037 T1/T2: the unified entry assembles the existing seams in order, degrades
 * explicitly when a channel is not configured, refuses a second instance, and
 * shuts down in the reverse order with a bounded drain.
 *
 * Nothing here touches a real SDK, a real model or the network: every collaborator
 * is injected through `deps`, which is the same injection the process entry uses.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppConfigError, CHANNEL, createCloudAgentApp, loadAppConfig, selectChannels } from "../src/app.mjs";
import { exitCodeFor, parseEntryArgs, resolveEntryEnv } from "../src/entry/main.mjs";
import { fakeAppDeps } from "./helpers/app-fixture.mjs";

const FEISHU_ENV = Object.freeze({ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret-feishu" });
const WECOM_ENV = Object.freeze({ WECOM_BOT_ID: "bot-test", WECOM_BOT_SECRET: "secret-wecom" });

async function tempDir(t, prefix = "cloud-agent-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function appFor({ dir, env, config, deps }) {
  return createCloudAgentApp({
    env: { ...env },
    baseDir: dir,
    config:
      config ??
      loadAppConfig(
        { ...env, CLOUD_AGENT_STATE_DIR: join(dir, "state"), RESEARCH_RUNS_DIR: join(dir, "runs") },
        { baseDir: dir },
      ),
    deps,
    log: () => {},
  });
}

test("config: auto mode enables exactly the channels whose credentials exist", () => {
  assert.deepEqual(selectChannels({ ...FEISHU_ENV }).enabled, [CHANNEL.FEISHU]);
  assert.deepEqual(selectChannels({ ...FEISHU_ENV, ...WECOM_ENV }).enabled, [CHANNEL.FEISHU, CHANNEL.WECOM]);
  const none = selectChannels({});
  assert.deepEqual(none.enabled, []);
  assert.deepEqual(
    none.skipped.map((entry) => entry.reason),
    ["credentials_missing", "credentials_missing"],
  );
  assert.deepEqual(selectChannels({ CLOUD_AGENT_CHANNELS: "none", ...WECOM_ENV }).enabled, []);
});

test("config: an explicit channel list fails closed when its credential is missing", () => {
  assert.throws(() => selectChannels({ CLOUD_AGENT_CHANNELS: "wecom" }), AppConfigError);
  assert.throws(() => selectChannels({ CLOUD_AGENT_CHANNELS: "feishu,wecom", ...FEISHU_ENV }), AppConfigError);
  assert.throws(() => selectChannels({ CLOUD_AGENT_CHANNELS: "telegram" }), AppConfigError);
  assert.deepEqual(selectChannels({ CLOUD_AGENT_CHANNELS: "wecom", ...WECOM_ENV }).enabled, [CHANNEL.WECOM]);
});

test("config: numeric switches are validated and exit code 2 is reserved for config", () => {
  assert.throws(() => loadAppConfig({ CLOUD_AGENT_API_PORT: "70000" }), AppConfigError);
  assert.throws(() => loadAppConfig({ CLOUD_AGENT_TICK_INTERVAL_MS: "10" }), AppConfigError);
  assert.equal(exitCodeFor(new AppConfigError(["x"])), 2);
  assert.equal(exitCodeFor(Object.assign(new Error("boom"), { code: "instance_locked" })), 1);
});

test("entry args: flags map onto the documented environment keys", () => {
  const parsed = parseEntryArgs(["--channels", "feishu", "--api-port=0", "--check"]);
  assert.equal(parsed.check, true);
  assert.equal(parsed.env.CLOUD_AGENT_CHANNELS, "feishu");
  assert.equal(parsed.env.CLOUD_AGENT_API_PORT, "0");
  assert.throws(() => parseEntryArgs(["--nope"]), Error);
});

test("entry env: a secrets file is merged without overriding an explicit variable", async (t) => {
  const dir = await tempDir(t);
  const { writeFile } = await import("node:fs/promises");
  const secretsPath = join(dir, "wecom.env");
  await writeFile(secretsPath, "# comment\nWECOM_BOT_ID=bot-from-file\nWECOM_BOT_SECRET=secret-from-file\n");
  const merged = resolveEntryEnv({
    env: { WECOM_BOT_ID: "bot-from-env" },
    overrides: { CLOUD_AGENT_WECOM_SECRETS: secretsPath },
  });
  assert.equal(merged.env.WECOM_BOT_ID, "bot-from-env");
  assert.equal(merged.env.WECOM_BOT_SECRET, "secret-from-file");
  assert.equal(merged.secretsFile, secretsPath);
  // A missing explicit file is an error, a missing default file is not.
  assert.throws(() => resolveEntryEnv({ env: {}, overrides: { CLOUD_AGENT_WECOM_SECRETS: join(dir, "absent.env") } }));
});

test("assembly: subsystems start in dependency order and the tick loop starts last", async (t) => {
  const dir = await tempDir(t);
  const deps = fakeAppDeps();
  const app = appFor({ dir, env: { ...FEISHU_ENV, ...WECOM_ENV }, deps });

  await app.start();
  assert.deepEqual(deps.steps, [
    "lock.acquire",
    "research.load",
    "delivery.create",
    "api.create",
    "api.start",
    "feishu.start",
    "wecom.start",
    "scheduler.start",
  ]);
  const summary = app.describe();
  assert.equal(summary.phase, "running");
  assert.deepEqual(summary.channels.running, ["feishu", "wecom"]);
  assert.equal(summary.api.url, "http://127.0.0.1:8787/v1");
  assert.ok(existsSync(join(dir, "runs")), "the run store root is created before channels start");

  const result = await app.stop({ reason: "test" });
  assert.equal(result.drained, true);
  // Reverse order: channels, scheduler, API, lock.
  assert.deepEqual(deps.steps.slice(8), [
    "feishu.stop",
    "wecom.stop",
    "scheduler.stop",
    "scheduler.settle",
    "api.stop",
    "lock.release",
  ]);
  assert.equal(deps.lock.released, true);
});

test("assembly: a missing WeCom credential degrades to Feishu-only with a logged reason", async (t) => {
  const dir = await tempDir(t);
  const deps = fakeAppDeps();
  const app = appFor({ dir, env: { ...FEISHU_ENV }, deps });
  await app.start();
  const summary = app.describe();
  assert.deepEqual(summary.channels.enabled, [CHANNEL.FEISHU]);
  assert.deepEqual(summary.channels.skipped, [{ channel: CHANNEL.WECOM, reason: "credentials_missing" }]);
  assert.equal(deps.steps.includes("wecom.start"), false);
  await app.stop({ reason: "test" });
});

test("assembly: no channel credentials leaves scheduler, delivery and API running", async (t) => {
  const dir = await tempDir(t);
  const deps = fakeAppDeps();
  const app = appFor({ dir, env: { CLOUD_AGENT_CHANNELS: "none" }, deps });
  await app.start();
  assert.deepEqual(app.describe().channels.running, []);
  assert.equal(deps.steps.includes("scheduler.start"), true);
  await app.stop({ reason: "test" });
});

test("assembly: a failure mid-start unwinds everything already started", async (t) => {
  const dir = await tempDir(t);
  const deps = fakeAppDeps({ failAt: "wecom.start" });
  const app = appFor({ dir, env: { ...FEISHU_ENV, ...WECOM_ENV }, deps });
  await assert.rejects(() => app.start(), /wecom auth failed/);
  // The Feishu channel that did start is stopped, the API is closed and the lock
  // is released: a failed start leaves no half-owned process.
  assert.ok(deps.steps.includes("feishu.stop"));
  assert.ok(deps.steps.includes("api.stop"));
  assert.ok(deps.steps.includes("lock.release"));
  assert.equal(app.describe().phase, "stopped");
});

test("lifecycle: a second instance on the same state directory is refused", async (t) => {
  const dir = await tempDir(t);
  const deps = fakeAppDeps({ failAt: "lock.acquire" });
  const app = appFor({ dir, env: { ...FEISHU_ENV }, deps });
  await assert.rejects(() => app.start(), /already running/);
  assert.equal(deps.steps.includes("api.start"), false, "nothing else starts after the lock refusal");
  assert.equal(exitCodeFor(Object.assign(new Error("locked"), { code: "instance_locked" })), 1);
});

test("lifecycle: a hung drain is bounded and reported as not drained", async (t) => {
  const dir = await tempDir(t);
  const deps = fakeAppDeps({ settle: "hang", draining: false });
  const config = loadAppConfig(
    {
      ...FEISHU_ENV,
      CLOUD_AGENT_STATE_DIR: join(dir, "state"),
      RESEARCH_RUNS_DIR: join(dir, "runs"),
      CLOUD_AGENT_SHUTDOWN_TIMEOUT_MS: "100",
    },
    { baseDir: dir },
  );
  const app = appFor({ dir, env: { ...FEISHU_ENV }, config, deps });
  await app.start();
  const result = await app.stop({ reason: "SIGTERM" });
  assert.equal(result.drained, false);
  assert.equal(result.schedulerDrained, false);
  // The in-flight run is cancelled instead of being left unowned.
  assert.ok(deps.steps.includes("scheduler.cancelAll"));
  assert.equal(result.channels.feishu, false);
});

test("lifecycle: stop is idempotent and safe before start", async (t) => {
  const dir = await tempDir(t);
  const app = appFor({ dir, env: { ...FEISHU_ENV }, deps: fakeAppDeps() });
  assert.equal((await app.stop()).drained, true);
  await app.start();
  await app.stop();
  assert.deepEqual(await app.stop(), { drained: true, reason: "signal", alreadyStopped: true });
});
