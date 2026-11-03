/**
 * Assemble the WeCom channel: config → instance lock → transport → agent runner
 * → channel.
 *
 * Everything is injectable so the offline tests can drive the same wiring with a
 * fake client and a fake runtime. The real path uses the official SDK and the
 * one Agent runtime; there is no second executor.
 */
import { join } from "node:path";
import { createWecomChannel } from "./channel.mjs";
import { describeWecomConfig, loadWecomConfig } from "./config.mjs";
import { createWecomDedupeStore } from "./dedupe.mjs";
import { createInstanceLock } from "./instance.mjs";
import { createWecomAgentRunner } from "./runtime.mjs";
import { createKnownSessionStore } from "./sessions.mjs";
import { createWecomTransport } from "./transport.mjs";

export const DEFAULT_WECOM_STATE_DIR = ".work/wecom-channel";

/**
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string} [options.stateDir] lock directory (default `.work/wecom-channel`)
 * @param {object} [options.wecomConfig] injected validated channel config (tests)
 * @param {object} [options.modelConfig] injected validated model config (tests)
 * @param {object} [options.cwd] runner session directory (tests)
 * @param {Function} [options.createRuntime] agent runtime injection (tests)
 * @param {Function} [options.createClient] SDK client injection (tests)
 * @param {Function} [options.log]
 * @param {Function} [options.runResearch] research seam; absent means `/research` is unavailable
 */
export function createWecomService({
  env = process.env,
  stateDir = join(process.cwd(), DEFAULT_WECOM_STATE_DIR),
  wecomConfig,
  modelConfig,
  cwd,
  createRuntime,
  createClient,
  log = () => {},
  runResearch,
  now = Date.now,
  pid = process.pid,
  onOutcome,
} = {}) {
  const config = wecomConfig ?? loadWecomConfig(env);
  const runner = createWecomAgentRunner({ env, cwd, config: modelConfig, createRuntime });
  const sessions = createKnownSessionStore({ now });
  const dedupe = createWecomDedupeStore({ now });
  const lock = createInstanceLock({ dir: stateDir, pid });

  let transport;
  let channel;
  let started = false;
  let stopped = false;

  channel = createWecomChannel({
    runTurn: (input) => runner.runTurn(input),
    runResearch,
    reply: (frame, text) => transport.reply(frame, text),
    policy: {
      botName: config.botName,
      allowedUserIds: config.allowedUserIds,
      allowedChatIds: config.allowedChatIds,
    },
    segment: { maxBytes: config.replyMaxBytes },
    dedupe,
    log,
    onOutcome: (outcome) => {
      if (outcome?.action === "accepted" && outcome.chatId) {
        sessions.record({ chatId: outcome.chatId, chatType: outcome.chatType });
      }
      onOutcome?.(outcome);
    },
  });

  transport = createWecomTransport({
    config,
    createClient,
    log,
    now,
    onEvent: ({ frame }) => {
      // Must stay synchronous: the connection's receive path must not await a
      // model run, and the protocol ack is the transport's job.
      channel.handleEvent({ frame });
    },
  });

  return {
    channel,
    runner,
    sessions,
    config,
    stateDir,

    async start() {
      if (started) return this.describe();
      const lockResult = lock.acquire();
      log({
        level: "info",
        event: "wecom_instance_lock_acquired",
        path: lockResult.file,
        recoveredStale: lockResult.recoveredStale || undefined,
      });
      try {
        await transport.start();
      } catch (error) {
        lock.release();
        throw error;
      }
      started = true;
      log({ level: "info", event: "wecom_channel_started", ...describeWecomConfig(config) });
      return this.describe();
    },

    async stop({ timeoutMs = 5_000 } = {}) {
      if (stopped) return { stopped: true };
      stopped = true;
      const drained = await channel.dispose({ timeoutMs }).then(
        () => true,
        () => false,
      );
      await runner.dispose().catch((error) => {
        log({ level: "warn", event: "wecom_runner_dispose_failed", message: String(error?.message ?? error) });
      });
      await transport.stop().catch((error) => {
        log({ level: "warn", event: "wecom_transport_stop_failed", message: String(error?.message ?? error) });
      });
      lock.release();
      log({ level: "info", event: "wecom_channel_stopped", drained });
      return { stopped: true, drained };
    },

    describe() {
      return {
        started,
        stopped,
        config: describeWecomConfig(config),
        transport: transport.describe(),
        lock: lock.path,
        knownSessions: sessions.size,
        dedupeSize: dedupe.size,
      };
    },
  };
}
