#!/usr/bin/env node
/**
 * AGT-037 live drain evidence.
 *
 * Windows cannot deliver a catchable SIGTERM/SIGINT from another process to a
 * Node process, so a real signal-driven shutdown of a *live* runtime cannot be
 * produced on this host. This driver runs the same composition root with the same
 * real configuration (real WeCom credentials, real scheduler, real delivery, real
 * management API) and then calls `app.stop()` — the exact function the signal
 * handler calls — so the drain verdict and exit code are produced by the real
 * runtime rather than by a fake.
 *
 * The channel layer is real: the WeCom long connection is established and torn
 * down through the production service.
 *
 * Usage: node scripts/agt-037/live-drain.mjs [--wait-ms 15000]
 */
import { createCloudAgentApp, loadAppConfig } from "../../src/app.mjs";
import { loadEnvFile, defaultSecretsPath } from "../../src/env-file.mjs";

const args = process.argv.slice(2);
const waitIndex = args.indexOf("--wait-ms");
const waitMs = waitIndex >= 0 ? Number(args[waitIndex + 1]) : 15_000;

const log = (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);

// Model config comes from the shell (`--env-file`), WeCom credentials from the
// maintainer secrets file; neither value is printed.
const baseEnv = { ...process.env };
const secrets = loadEnvFile(baseEnv.CLOUD_AGENT_WECOM_SECRETS ?? defaultSecretsPath(), { missing: "ignore" });
const env = {
  ...secrets,
  ...baseEnv,
  CLOUD_AGENT_CHANNELS: "wecom",
  CLOUD_AGENT_API_PORT: "0",
  WECOM_ALLOWED_USER_IDS: "",
};

const app = createCloudAgentApp({ env, log, config: loadAppConfig(env) });
const evidence = { event: "agt037_live_drain", ok: false };
let exitCode = 1;

try {
  const summary = await app.start();
  evidence.started = {
    phase: summary.phase,
    channels: summary.channels.running,
    apiPort: summary.api.port,
  };
  const health = await fetch(`${summary.api.url}/health`).then((response) => response.json());
  evidence.health = { ok: health.ok, status: health.data?.status };

  await new Promise((resolve) => setTimeout(resolve, waitMs));

  const drained = await app.stop({ reason: "driver_stop" });
  evidence.drain = {
    drained: drained.drained,
    channels: drained.channels,
    schedulerDrained: drained.schedulerDrained,
    apiStopped: drained.apiStopped,
  };
  exitCode = drained.drained === false ? 1 : 0;
  evidence.exitCode = exitCode;
  evidence.ok = drained.drained === true && exitCode === 0;
} catch (error) {
  evidence.error = String(error?.message ?? error).slice(0, 300);
  exitCode = 1;
  evidence.exitCode = 1;
} finally {
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  process.exitCode = exitCode;
}
