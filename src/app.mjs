/**
 * Cloud Agent composition root (AGT-037).
 *
 * One process owns the whole runtime: the run store, the scheduler, the
 * delivery stage, the loopback management API and the chat channels. This module
 * only *assembles* existing seams — it does not re-implement any of them:
 *
 *   config → run store → scheduler → delivery → management API → channels → tick
 *
 * Two ordering decisions are deliberate and observable:
 *
 *   - the scheduler is created (and therefore replays undelivered terminal
 *     triggers) before the channels start, but its tick loop starts *after* the
 *     channels, so a recovered delivery has a live sender;
 *   - shutdown runs in the opposite order so nothing can create new work while
 *     the process is draining.
 *
 * Every collaborator is injectable; the real defaults are imported lazily so
 * tests can assemble an app without the Pi runtime, the Feishu SDK or WeCom.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createManagementApi } from "./api/server.mjs";
import { DEFAULT_API_HOST, DEFAULT_API_PORT } from "./api/contracts.mjs";
import { createDeliveringScheduler } from "./delivery/scheduler.mjs";
import { resolveRunsRoot } from "./research/run-store.mjs";
import { createChatRunRecorder } from "./runs/chat-runs.mjs";
import { loadEnvFile, resolveUserPath } from "./env-file.mjs";
import { createInstanceLock } from "./channels/wecom/instance.mjs";

/** Environment contract of the unified entry. Values are names only. */
export const APP_ENV = Object.freeze({
  channels: "CLOUD_AGENT_CHANNELS",
  stateDir: "CLOUD_AGENT_STATE_DIR",
  runsDir: "RESEARCH_RUNS_DIR",
  apiHost: "CLOUD_AGENT_API_HOST",
  apiPort: "CLOUD_AGENT_API_PORT",
  tickIntervalMs: "CLOUD_AGENT_TICK_INTERVAL_MS",
  shutdownTimeoutMs: "CLOUD_AGENT_SHUTDOWN_TIMEOUT_MS",
  wecomSecrets: "CLOUD_AGENT_WECOM_SECRETS",
});

export const CHANNEL_MODE = Object.freeze({
  /** Enable exactly the channels whose credentials are present. */
  AUTO: "auto",
  NONE: "none",
});

export const CHANNEL = Object.freeze({ FEISHU: "feishu", WECOM: "wecom" });

const DEFAULTS = Object.freeze({
  stateDir: join(".work", "cloud-agent"),
  apiHost: DEFAULT_API_HOST,
  apiPort: DEFAULT_API_PORT,
  tickIntervalMs: 30_000,
  shutdownTimeoutMs: 20_000,
});

const MIN_TICK_INTERVAL_MS = 250;

/** A configuration problem the operator can fix; never contains secret values. */
export class AppConfigError extends Error {
  constructor(fields, detail) {
    super(detail ?? `Cloud Agent configuration is incomplete or invalid (${fields.join(", ")})`);
    this.name = "AppConfigError";
    this.code = "app_config_error";
    this.fields = Object.freeze([...fields]);
  }
}

const present = (value) => (typeof value === "string" ? value.trim() : "");

function parsePositiveInt(name, value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppConfigError([name], `${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

/** Channel credentials that mark a channel as configured. */
export function channelCredentialState(env = process.env) {
  return {
    feishu: Boolean(present(env.FEISHU_APP_ID) && present(env.FEISHU_APP_SECRET)),
    wecom: Boolean(present(env.WECOM_BOT_ID) && present(env.WECOM_BOT_SECRET)),
  };
}

/**
 * Resolve which channels to run.
 *
 * `auto` (default) enables exactly the channels whose credentials are present and
 * logs the reason for every omitted one; an explicit list is a contract and fails
 * closed when a credential is missing. `none` runs scheduler + delivery + API only.
 *
 * @returns {{mode: string, enabled: string[], skipped: Array<{channel:string, reason:string}>}}
 */
export function selectChannels(env = process.env) {
  const raw = present(env[APP_ENV.channels]).toLowerCase();
  const credentials = channelCredentialState(env);
  const known = [CHANNEL.FEISHU, CHANNEL.WECOM];

  if (raw === CHANNEL_MODE.NONE) {
    return { mode: CHANNEL_MODE.NONE, enabled: [], skipped: known.map((channel) => ({ channel, reason: "disabled_by_config" })) };
  }
  if (!raw || raw === CHANNEL_MODE.AUTO) {
    const enabled = known.filter((channel) => credentials[channel]);
    const skipped = known
      .filter((channel) => !credentials[channel])
      .map((channel) => ({ channel, reason: "credentials_missing" }));
    return { mode: CHANNEL_MODE.AUTO, enabled, skipped };
  }

  const requested = raw
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = requested.filter((entry) => !known.includes(entry));
  if (unknown.length > 0) {
    throw new AppConfigError(
      [APP_ENV.channels],
      `${APP_ENV.channels} contains unknown channel(s): ${unknown.join(", ")} (allowed: ${known.join(", ")}, ${CHANNEL_MODE.AUTO}, ${CHANNEL_MODE.NONE})`,
    );
  }
  const missing = requested.filter((channel) => !credentials[channel]);
  if (missing.length > 0) {
    throw new AppConfigError(
      [APP_ENV.channels, ...missing.map((channel) => (channel === CHANNEL.FEISHU ? "FEISHU_APP_ID/FEISHU_APP_SECRET" : "WECOM_BOT_ID/WECOM_BOT_SECRET"))],
      `${APP_ENV.channels}=${raw}: missing credentials for ${missing.join(", ")}`,
    );
  }
  return { mode: raw, enabled: known.filter((channel) => requested.includes(channel)), skipped: [] };
}

/**
 * Validate and normalize the unified entry configuration.
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {{baseDir?: string}} [options]
 */
export function loadAppConfig(env = process.env, { baseDir = process.cwd() } = {}) {
  const channels = selectChannels(env);
  const stateDir = resolve(baseDir, present(env[APP_ENV.stateDir]) || DEFAULTS.stateDir);
  const runsDir = resolveRunsRoot({
    rootDir: present(env[APP_ENV.runsDir]) || undefined,
    env: {},
  });
  const apiPort = parsePositiveInt(`${APP_ENV.apiPort}`, env[APP_ENV.apiPort], { min: 0, max: 65535 }) ?? DEFAULTS.apiPort;
  const tickIntervalMs =
    parsePositiveInt(`${APP_ENV.tickIntervalMs}`, env[APP_ENV.tickIntervalMs], { min: MIN_TICK_INTERVAL_MS }) ??
    DEFAULTS.tickIntervalMs;
  const shutdownTimeoutMs =
    parsePositiveInt(`${APP_ENV.shutdownTimeoutMs}`, env[APP_ENV.shutdownTimeoutMs], { min: 100 }) ??
    DEFAULTS.shutdownTimeoutMs;
  const apiHost = present(env[APP_ENV.apiHost]) || DEFAULTS.apiHost;
  const wecomSecretsPath = resolveUserPath(env[APP_ENV.wecomSecrets], baseDir);

  return {
    channels,
    stateDir,
    runsDir,
    api: { host: apiHost, port: apiPort },
    tickIntervalMs,
    shutdownTimeoutMs,
    wecomSecretsPath,
    pid: process.pid,
  };
}

/** Real collaborators. Imported lazily so tests never load a platform SDK. */
export const defaultAppDeps = {
  createLock: createInstanceLock,
  createDeliveringScheduler,
  createManagementApi,
  createChatRunRecorder,
  async loadResearchDeps({ runsDir, env, log }) {
    const [{ loadAgentRuntimePort }, searchModule, readModule, { generateRunId }] = await Promise.all([
      import("./research/port.mjs"),
      import("./research/tools/search.mjs"),
      import("./research/tools/read-page.mjs"),
      import("./research/run-store.mjs"),
    ]);
    const runtimePort = await loadAgentRuntimePort({ moduleSpecifier: env.AGENT_RUNTIME_MODULE });
    const toolLayer = {
      tools: [searchModule.createWebSearchTool({}), readModule.createReadPageTool({})],
    };
    log({ level: "info", event: "cloud_agent_research_ready", runsDir });
    return { runtimePort, toolLayer, rootDir: runsDir, env, logger: { info: () => {}, warn: () => {} }, generateRunId };
  },
  async startFeishu({ env, log, chatRuns, generateRunId }) {
    const { startFeishuService } = await import("./channels/feishu/service.mjs");
    return await startFeishuService({ env, log, chatRuns, generateRunId });
  },
  async startWecom({ env, log, chatRuns, generateRunId, stateDir, runResearch }) {
    const { createWecomService } = await import("./channels/wecom/service.mjs");
    const service = createWecomService({ env, log, chatRuns, generateRunId, stateDir, runResearch });
    await service.start();
    return service;
  },
};

function logError(log, event, error, extra = {}) {
  log({
    level: "error",
    event,
    code: String(error?.code ?? error?.name ?? "error"),
    message: String(error?.message ?? error).slice(0, 300),
    fields: Array.isArray(error?.fields) ? error.fields : undefined,
    ...extra,
  });
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${code} after ${timeoutMs}ms`), { code })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Create the unified runtime.
 *
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {Function} [options.log] JSON-line logger
 * @param {() => Date} [options.now]
 * @param {string} [options.baseDir]
 * @param {object} [options.config] injected config (tests)
 * @param {object} [options.deps] collaborator injection (tests)
 */
export function createCloudAgentApp({ env = process.env, log = () => {}, now = () => new Date(), baseDir = process.cwd(), config, deps = {} } = {}) {
  const collaborators = { ...defaultAppDeps, ...deps };
  const appConfig = config ?? loadAppConfig(env, { baseDir });

  let phase = "idle";
  let started = false;
  let stopped = false;
  let lock = null;
  let delivering = null;
  let api = null;
  let chatRuns = null;
  const channels = {};
  let feishuSender = null;

  const describe = () => ({
    stateDir: appConfig.stateDir,
    runsDir: appConfig.runsDir,
    pid: appConfig.pid,
    phase,
    channels: {
      mode: appConfig.channels.mode,
      enabled: appConfig.channels.enabled,
      skipped: appConfig.channels.skipped,
      running: Object.keys(channels),
    },
    api: api?.address ? { url: api.address.url, host: api.address.host, port: api.address.port } : null,
    scheduler: { tickIntervalMs: appConfig.tickIntervalMs, schedules: delivering ? delivering.scheduler.listSchedules().length : 0 },
    delivery: { enabled: Boolean(delivering), feishuSender: Boolean(feishuSender) },
  });

  function setPhase(next) {
    phase = next;
    log({ level: "info", event: "cloud_agent_phase", phase: next });
  }

  async function startChannels() {
    const enabled = appConfig.channels.enabled;
    if (enabled.includes(CHANNEL.FEISHU)) {
      const service = await collaborators.startFeishu({
        env,
        log,
        chatRuns,
        generateRunId: collaborators.generateRunId,
      });
      channels.feishu = service;
      // Delivery sends through the channel's own client: no second WebSocket and
      // no second credential source.
      feishuSender = (request) => service.transport.send(request);
      log({ level: "info", event: "cloud_agent_channel_started", channel: CHANNEL.FEISHU, ...service.summary });
    }
    if (enabled.includes(CHANNEL.WECOM)) {
      channels.wecom = await collaborators.startWecom({
        env,
        log,
        chatRuns,
        generateRunId: collaborators.generateRunId,
        stateDir: join(appConfig.stateDir, "wecom"),
      });
      log({ level: "info", event: "cloud_agent_channel_started", channel: CHANNEL.WECOM, config: channels.wecom.describe?.().config });
    }
    for (const skipped of appConfig.channels.skipped) {
      log({ level: "info", event: "cloud_agent_channel_skipped", channel: skipped.channel, reason: skipped.reason });
    }
  }

  async function start() {
    if (started) throw new AppConfigError([], "this Cloud Agent instance is already started");
    started = true;
    setPhase("config");

    // 1. run store: fail before any channel connects if the artifact root is not
    // writable.
    chatRuns = collaborators.createChatRunRecorder({ rootDir: appConfig.runsDir, env, now, log });
    await mkdir(appConfig.runsDir, { recursive: true });

    // 2. single instance guard on the shared state directory.
    lock = collaborators.createLock({ dir: appConfig.stateDir, pid: appConfig.pid });
    const lockResult = lock.acquire();
    log({
      level: "info",
      event: "cloud_agent_lock_acquired",
      path: lockResult.file,
      recoveredStale: lockResult.recoveredStale || undefined,
    });

    try {
      // 3. scheduler + 4. delivery stage, in one existing composition root.
      setPhase("scheduler");
      const researchDeps = await collaborators.loadResearchDeps({
        runsDir: appConfig.runsDir,
        env,
        log,
        chatRuns,
      });
      const generateRunId = collaborators.generateRunId ?? researchDeps.generateRunId;
      collaborators.generateRunId = generateRunId;
      delivering = await collaborators.createDeliveringScheduler({
        schedulerOptions: {
          stateDir: join(appConfig.stateDir, "scheduler"),
          env,
          now,
          researchDeps,
          logger: { info: () => {}, warn: () => {} },
        },
        delivery: {
          stateDir: join(appConfig.stateDir, "delivery"),
          env,
          now,
          researchRunsDir: appConfig.runsDir,
          // Targets are Feishu-only today; a WeCom target is refused by the
          // coordinator before this function is called (AGT-036 W1).
          sendMessage: async (request) => {
            if (!feishuSender) {
              throw new Error("feishu channel is not running; cannot deliver to a Feishu target");
            }
            return await feishuSender(request);
          },
          log,
        },
        log,
      });
      setPhase("delivery");

      // 5. loopback management API.
      setPhase("api");
      api = collaborators.createManagementApi({
        deliveringScheduler: delivering,
        runsDir: appConfig.runsDir,
        env,
        host: appConfig.api.host,
        port: appConfig.api.port,
        logger: { info: () => {}, warn: () => {} },
        shutdownTimeoutMs: appConfig.shutdownTimeoutMs,
      });
      await api.start();

      // 6. channels, then the tick loop so recovered deliveries have a sender.
      setPhase("channels");
      await startChannels();

      setPhase("scheduler_tick");
      await delivering.scheduler.start({ tickIntervalMs: appConfig.tickIntervalMs });
      setPhase("running");
    } catch (error) {
      logError(log, "cloud_agent_start_failed", error, { phase });
      await stop({ reason: "start_failed" }).catch(() => {});
      throw error;
    }

    const summary = describe();
    log({ level: "info", event: "cloud_agent_started", ...summary });
    return summary;
  }

  /**
   * Graceful shutdown: stop accepting work, drain, then close the API and release
   * the lock. Returns the drain verdict so the process entry can pick an exit code.
   */
  async function stop({ reason = "signal", timeoutMs = appConfig.shutdownTimeoutMs } = {}) {
    if (stopped || !started) return { drained: true, reason, alreadyStopped: true };
    stopped = true;
    setPhase("stopping");
    log({ level: "info", event: "cloud_agent_stopping", reason, timeoutMs });

    const channelDrained = {};
    // 1. channels first: no new inbound message may create work from here on.
    for (const [name, service] of Object.entries(channels)) {
      try {
        const result = await withTimeout(Promise.resolve(service.stop({ timeoutMs })), timeoutMs, "channel_drain_timeout");
        channelDrained[name] = result?.drained ?? result?.stopped ?? true;
      } catch (error) {
        channelDrained[name] = false;
        logError(log, "cloud_agent_channel_drain_failed", error, { channel: name });
      }
    }

    // 2. scheduler: stop the tick, let an in-flight run finish, then cancel.
    let schedulerDrained = true;
    if (delivering) {
      try {
        await withTimeout(
          (async () => {
            await delivering.scheduler.stop({ abortActive: false });
            await delivering.scheduler.settle();
          })(),
          timeoutMs,
          "scheduler_drain_timeout",
        );
      } catch (error) {
        schedulerDrained = false;
        logError(log, "cloud_agent_scheduler_drain_failed", error);
        delivering.scheduler.cancelAll?.("shutdown timeout");
        // The cancellation itself must be bounded too: a run that ignores its
        // abort signal must not keep the process from exiting.
        await withTimeout(
          Promise.resolve(delivering.scheduler.settle?.() ?? null).catch(() => {}),
          1_000,
          "scheduler_settle_timeout",
        ).catch(() => {});
      }
    }

    // 3. API last: it stays queryable while the rest drains.
    let apiStopped = true;
    if (api) {
      try {
        await withTimeout(Promise.resolve(api.stop()), timeoutMs, "api_stop_timeout");
      } catch (error) {
        apiStopped = false;
        logError(log, "cloud_agent_api_stop_failed", error);
      }
    }

    lock?.release?.();
    setPhase("stopped");

    const drained =
      Object.values(channelDrained).every((value) => value !== false) && schedulerDrained && apiStopped;
    const result = { drained, reason, channels: channelDrained, schedulerDrained, apiStopped };
    log({ level: "info", event: "cloud_agent_stopped", ...result });
    return result;
  }

  return {
    config: appConfig,
    start,
    stop,
    describe,
    get scheduler() {
      return delivering?.scheduler ?? null;
    },
    get coordinator() {
      return delivering?.coordinator ?? null;
    },
    get getRunDelivery() {
      return delivering?.getRunDelivery ?? null;
    },
    get api() {
      return api;
    },
    get channels() {
      return channels;
    },
    get phase() {
      return phase;
    },
  };
}
