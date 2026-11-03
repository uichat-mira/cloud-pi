/**
 * Assemble the Feishu channel service used by the server and the live POC.
 *
 * Order matters: the channel is created before the transport starts so no
 * inbound event is dropped while the WebSocket is connecting. The bot open id
 * is a getter because it is discovered by the transport at startup.
 */
import { createFeishuChannel } from "./channel.mjs";
import { loadFeishuConfig, describeFeishuConfig, maskId } from "./config.mjs";
import { createFeishuTransport } from "./transport.mjs";
import { createFeishuAgentRunner } from "./runtime.mjs";

/**
 * @param {object} [options]
 * @param {Record<string,string>} [options.env]
 * @param {Function} [options.log]
 * @param {Function} [options.onOutcome]
 * @param {object} [options.runtimeOptions] forwarded to createFeishuAgentRunner
 * @param {Function} [options.createTransport] injection (tests)
 * @param {Function} [options.createAgentRunner] injection (tests)
 */
export async function startFeishuService({
  env = process.env,
  log = () => {},
  onOutcome,
  runtimeOptions = {},
  createTransport = createFeishuTransport,
  createAgentRunner = createFeishuAgentRunner,
} = {}) {
  const config = loadFeishuConfig(env);
  const agent = createAgentRunner({ env, ...runtimeOptions });
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
      reply: transport.reply,
      log,
      onOutcome,
    });

    const started = await transport.start();

    return {
      config,
      channel,
      transport,
      agent,
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
      await agent.dispose();
    } catch {
      // Best effort during startup failure.
    }
    throw error;
  }
}
