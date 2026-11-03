/**
 * Assemble the Feishu channel service used by the server and the live POC.
 *
 * Order matters: the channel is created before the transport starts so no
 * inbound event is dropped while the WebSocket is connecting. The bot open id
 * is a getter because it is discovered by the transport at startup.
 *
 * The chat runtime and the research runtime are assembled separately
 * (AGT-032): chat keeps the single AGT-027 runtime, while research lazily loads
 * the research runtime port and calls the existing AGT-028 entry point.
 */
import { createFeishuChannel } from "./channel.mjs";
import { loadFeishuConfig, describeFeishuConfig, maskId } from "./config.mjs";
import { createFeishuTransport } from "./transport.mjs";
import { createFeishuAgentRunner, createFeishuResearchRunner } from "./runtime.mjs";

/**
 * @param {object} [options]
 * @param {Record<string,string>} [options.env]
 * @param {Function} [options.log]
 * @param {Function} [options.onOutcome]
 * @param {object} [options.runtimeOptions] forwarded to createFeishuAgentRunner
 * @param {object} [options.researchOptions] forwarded to createFeishuResearchRunner
 * @param {Function} [options.createTransport] injection (tests)
 * @param {Function} [options.createAgentRunner] injection (tests)
 * @param {Function} [options.createResearchRunner] injection (tests)
 * @param {object} [options.chatRuns] recorder that persists chat runs into the run
 *   store (`createChatRunRecorder()`); omitted means chat runs are not persisted
 * @param {() => string} [options.generateRunId] run-store compatible id generator
 */
export async function startFeishuService({
  env = process.env,
  log = () => {},
  onOutcome,
  runtimeOptions = {},
  researchOptions = {},
  chatRuns,
  generateRunId,
  createTransport = createFeishuTransport,
  createAgentRunner = createFeishuAgentRunner,
  createResearchRunner = createFeishuResearchRunner,
} = {}) {
  const config = loadFeishuConfig(env);
  const agent = createAgentRunner({ env, generateRunId, ...runtimeOptions });
  const research = createResearchRunner({ env, log, ...researchOptions });
  let transport;
  let channel;

  try {
    transport = createTransport({
      config,
      log,
      onEvent: (raw) => {
        // Never block the SDK dispatcher on a model run; the channel serializes
        // per-chat work and reports outcomes asynchronously.
        channel.handleEvent(raw);
      },
    });

    channel = createFeishuChannel({
      allowedChatIds: config.allowedChatIds,
      botOpenId: () => transport.getBotOpenId(),
      runTurn: agent.runTurn,
      runResearch: research.runResearch,
      reply: transport.reply,
      log,
      onOutcome: (outcome) => {
        // Persistent chat runs (AGT-037 trace): same run store, same schema.
        // Best effort — never let a storage problem change a delivered reply.
        if (chatRuns && outcome?.runId && (outcome.action === "replied" || outcome.action === "failed")) {
          void chatRuns.record(outcome, { channel: "feishu" });
        }
        onOutcome?.(outcome);
      },
    });

    const started = await transport.start();

    return {
      config,
      channel,
      transport,
      agent,
      research,
      summary: {
        ...describeFeishuConfig(config),
        appId: maskId(config.appId),
        botOpenIdResolved: Boolean(started.botOpenId),
        botOpenId: started.botOpenId ? maskId(started.botOpenId) : undefined,
      },
      async stop({ timeoutMs = 5_000 } = {}) {
        let drained;
        try {
          transport.stop();
        } finally {
          drained = await channel.stopAll({ timeoutMs });
          await research.dispose();
          await agent.dispose();
        }
        return drained;
      },
    };
  } catch (error) {
    try {
      transport?.stop();
    } catch {
      // Best effort during startup failure.
    }
    try {
      await research.dispose();
    } catch {
      // Best effort during startup failure.
    }
    try {
      await agent.dispose();
    } catch {
      // Best effort during startup failure.
    }
    throw error;
  }
}
