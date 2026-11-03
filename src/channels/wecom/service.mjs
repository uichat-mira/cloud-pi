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
import { assertWecomSessionAuthorization } from "./authorization.mjs";
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
 * @param {object} [options.chatRuns] recorder that persists chat runs into the run
 *   store (`createChatRunRecorder()`); omitted means chat runs are not persisted
 * @param {() => string} [options.generateRunId] run-store compatible id generator
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
  chatRuns,
  generateRunId,
  now = Date.now,
  pid = process.pid,
  onOutcome,
} = {}) {
  const config = wecomConfig ?? loadWecomConfig(env);
  // Fail-closed gate (V1 authorization boundary): with an external tool service
  // enabled, an implicit "anyone may talk to the bot" policy would let any third
  // party trigger a read under the maintainer-delegated identity. Refuse to build
  // the channel instead; the entry maps `wecom_config_error` to exit 2.
  const authorization = assertWecomSessionAuthorization({ env, config });
  log({
    level: "info",
    event: "wecom_session_authorization",
    enforced: authorization.enforced,
    sources: authorization.sources,
    allowedUserCount: authorization.allowedUserCount,
    allowedChatCount: authorization.allowedChatCount,
  });
  const runner = createWecomAgentRunner({ env, cwd, config: modelConfig, createRuntime, generateRunId });
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
    // Phase 1 answers inside the callback (`req_id`), phase 2 pushes the finished
    // answer with `aibot_send_msg` on the same long connection.
    reply: (frame, text) => transport.reply(frame, text),
    push: (input) => transport.send(input),
    sessions,
    ack: { enabled: config.ackEnabled, text: config.ackText, mergeMs: config.ackMergeMs },
    policy: {
      botName: config.botName,
      allowedUserIds: config.allowedUserIds,
      allowedChatIds: config.allowedChatIds,
    },
    // Empty by default: a rejection is silent, so nobody can probe the allowlist.
    deniedReply: config.deniedReply,
    segment: {
      maxBytes: config.replyMaxBytes,
      singleMaxSegments: config.singleMaxSegments,
      groupMaxSegments: config.groupMaxSegments,
    },
    dedupe,
    log,
    onOutcome: (outcome) => {
      if (outcome?.action === "accepted" && outcome.chatId) {
        sessions.record({ chatId: outcome.chatId, chatType: outcome.chatType });
      }
      // Persist the finished turn as a run record (AGT-037 trace). Best effort:
      // a storage failure must not undo a reply that already reached the user.
      if (chatRuns && outcome?.runId && (outcome.action === "replied" || outcome.action === "failed")) {
        void chatRuns.record(outcome, { channel: "wecom" });
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
    /** The transport is shared with the delivery stage: one socket, one rate ledger. */
    get transport() {
      return transport;
    },

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
