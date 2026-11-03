#!/usr/bin/env node
/**
 * The one Cloud Agent process (AGT-037).
 *
 *   npm run start                     # every channel whose credentials exist
 *   npm run start:feishu-only         # explicit degradation: Feishu only
 *   npm run start:wecom-only          # explicit degradation: WeCom only
 *   npm run start:api-only            # scheduler + delivery + API, no channels
 *
 * Logs one JSON object per line. They never contain message text, raw platform
 * ids or credentials. Exit codes: 0 clean stop, 1 runtime/drain failure, 2
 * invalid configuration.
 */
import { fileURLToPath } from "node:url";
import { AppConfigError, createCloudAgentApp, loadAppConfig } from "../app.mjs";
import { defaultSecretsPath, loadEnvFile, resolveUserPath } from "../env-file.mjs";

const USAGE = `Cloud Agent unified entry (AGT-037)

  npm run start                     all configured channels (auto)
  npm run start:feishu-only         Feishu channel only
  npm run start:wecom-only          WeCom channel only
  npm run start:api-only            scheduler + delivery + API, no channels

Options:
  --channels <list>     auto | none | feishu | wecom | feishu,wecom
  --state-dir <dir>     shared state root (default .work/cloud-agent)
  --runs-dir <dir>      run store root (default RESEARCH_RUNS_DIR or .work/research-runs)
  --api-host <host>     loopback host (127.0.0.1 or ::1)
  --api-port <port>     loopback port (0 asks the OS)
  --wecom-secrets <p>   WeCom credential file (default ~/.mira-secrets/wecom.env)
  --check               validate configuration and exit
  --help                show this help

Exit codes: 0 clean stop, 1 runtime or drain failure, 2 invalid configuration.`;

const VALUE_FLAGS = Object.freeze({
  "--channels": "CLOUD_AGENT_CHANNELS",
  "--state-dir": "CLOUD_AGENT_STATE_DIR",
  "--runs-dir": "RESEARCH_RUNS_DIR",
  "--api-host": "CLOUD_AGENT_API_HOST",
  "--api-port": "CLOUD_AGENT_API_PORT",
  "--wecom-secrets": "CLOUD_AGENT_WECOM_SECRETS",
});

export class UsageError extends Error {}

/** Parse argv into `{help, check, env}` without touching `process.env`. */
export function parseEntryArgs(argv = []) {
  const env = {};
  let help = false;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const key = VALUE_FLAGS[flag];
    if (!key) throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
    let value = inline;
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} requires a value`);
      index += 1;
    }
    if (value === "") throw new UsageError(`${flag} requires a non-empty value`);
    env[key] = value;
  }
  return { help, check, env };
}

/**
 * Build the effective environment: process environment + flags + the optional
 * WeCom credential file. The file is read, never written; values are merged into
 * the copy only and never logged.
 */
export function resolveEntryEnv({ env = process.env, overrides = {}, wecomSecretsPath } = {}) {
  const merged = { ...env, ...overrides };
  const explicit = resolveUserPath(merged.CLOUD_AGENT_WECOM_SECRETS);
  const candidate = explicit ?? wecomSecretsPath ?? defaultSecretsPath();
  const missing = explicit ? "error" : "ignore";
  const credentials = loadEnvFile(candidate, { missing });
  return {
    env: { ...credentials, ...merged },
    // `merged` wins over the file so an explicit environment variable overrides
    // the file without editing it.
    secretsFile: Object.keys(credentials).length > 0 ? candidate : null,
  };
}

const CONFIG_CODES = new Set(["app_config_error", "config_error", "feishu_config_error", "wecom_config_error"]);

export function exitCodeFor(error) {
  if (error instanceof AppConfigError) return 2;
  if (error instanceof UsageError) return 2;
  if (error && CONFIG_CODES.has(error.code)) return 2;
  return 1;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.argv]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {NodeJS.WriteStream} [options.stdout]
 * @param {NodeJS.WriteStream} [options.stderr]
 * @param {object} [options.deps] collaborator injection (tests)
 * @param {boolean} [options.installSignals] install SIGINT/SIGTERM handlers
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  deps = {},
  installSignals = true,
} = {}) {
  const log = (entry) => stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);

  let parsed;
  try {
    parsed = parseEntryArgs(argv);
  } catch (error) {
    stderr.write(`${JSON.stringify({ level: "error", event: "cloud_agent_usage_error", message: error.message })}\n`);
    stderr.write(`${USAGE}\n`);
    return { code: 2 };
  }
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return { code: 0 };
  }

  let effective;
  try {
    effective = resolveEntryEnv({ env, overrides: parsed.env });
  } catch (error) {
    log({ level: "error", event: "cloud_agent_secrets_unreadable", code: String(error?.code ?? "error") });
    return { code: 1 };
  }

  let config;
  try {
    config = loadAppConfig(effective.env);
  } catch (error) {
    log({
      level: "error",
      event: "cloud_agent_config_invalid",
      code: String(error?.code ?? error?.name ?? "error"),
      message: String(error?.message ?? error),
      fields: Array.isArray(error?.fields) ? error.fields : undefined,
    });
    return { code: exitCodeFor(error) };
  }

  if (parsed.check) {
    // Offline validation of the WeCom startup gate: an operator must learn that
    // external tools are enabled without an explicit session allowlist here, not
    // from a failed production start.
    if (config.channels?.enabled?.includes("wecom")) {
      try {
        const { loadWecomConfig } = await import("../channels/wecom/config.mjs");
        const { assertWecomSessionAuthorization } = await import("../channels/wecom/authorization.mjs");
        const { WECOM_PROMPT_VERSION } = await import("../channels/wecom/runtime.mjs");
        const wecomConfig = loadWecomConfig(effective.env);
        const authorization = assertWecomSessionAuthorization({ env: effective.env, config: wecomConfig });
        log({
          level: "info",
          event: "wecom_session_authorization",
          enforced: authorization.enforced,
          sources: authorization.sources,
          allowedUserCount: authorization.allowedUserCount,
          allowedChatCount: authorization.allowedChatCount,
        });
        // Experience settings an operator can verify offline: which prompts are in
        // play and how chat replies are bounded. Numbers and version ids only.
        log({
          level: "info",
          event: "wecom_experience_config",
          promptVersions: { ...WECOM_PROMPT_VERSION },
          ackEnabled: wecomConfig.ackEnabled,
          ackMergeMs: wecomConfig.ackMergeMs,
          singleMaxSegments: wecomConfig.singleMaxSegments,
          groupMaxSegments: wecomConfig.groupMaxSegments,
        });
      } catch (error) {
        log({
          level: "error",
          event: "cloud_agent_config_invalid",
          code: String(error?.code ?? error?.name ?? "error"),
          message: String(error?.message ?? error),
          fields: Array.isArray(error?.fields) ? error.fields : undefined,
        });
        return { code: exitCodeFor(error) };
      }
    }
    log({
      level: "info",
      event: "cloud_agent_config_ok",
      channels: config.channels,
      stateDir: config.stateDir,
      runsDir: config.runsDir,
      api: config.api,
      wecomSecretsFileUsed: Boolean(effective.secretsFile),
    });
    return { code: 0 };
  }

  const app = createCloudAgentApp({ env: effective.env, log, config, deps });
  try {
    await app.start();
  } catch (error) {
    log({
      level: "error",
      event: "cloud_agent_start_failed",
      code: String(error?.code ?? error?.name ?? "error"),
      message: String(error?.message ?? error).slice(0, 300),
      fields: Array.isArray(error?.fields) ? error.fields : undefined,
    });
    return { code: exitCodeFor(error), app };
  }

  // The scheduler tick timer and the channel sockets are the liveness owners;
  // this timer makes the invariant explicit so a process with an unref'd timer
  // never exits silently while it is supposed to be serving. With
  // `installSignals: false` the caller owns liveness (tests, embedded use).
  const keepAlive = installSignals ? setInterval(() => {}, 60_000) : null;

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return { code: 0, alreadyStopping: true };
    stopping = true;
    log({ level: "info", event: "cloud_agent_shutdown_requested", signal });
    if (keepAlive) clearInterval(keepAlive);
    const result = await app.stop({ reason: signal }).catch((error) => {
      log({ level: "error", event: "cloud_agent_stop_failed", message: String(error?.message ?? error) });
      return { drained: false };
    });
    return { code: result?.drained === false ? 1 : 0, result };
  };

  if (installSignals) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        void shutdown(signal).then(({ code }) => {
          process.exit(code);
        });
      });
    }
    process.on("unhandledRejection", (reason) => {
      log({ level: "error", event: "cloud_agent_unhandled_rejection", message: String(reason?.message ?? reason).slice(0, 300) });
    });
  }

  return { code: null, app, stop: shutdown, log };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main()
    .then((result) => {
      if (typeof result?.code === "number") process.exit(result.code);
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ level: "error", event: "cloud_agent_entry_failed", code: String(error?.code ?? "error") })}\n`,
      );
      process.exit(exitCodeFor(error));
    });
}
