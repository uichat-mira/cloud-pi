/**
 * Feishu transport: the thinnest wrapper over the official MIT
 * `@larksuiteoapi/node-sdk` (v1.76.0) that the channel needs.
 *
 * It owns network concerns only: WebSocket long connection, event dispatch,
 * bot open-id lookup and message reply. It does not read files, start a daemon,
 * create a Pi session or decide routing. The SDK's own reconnect loop is used;
 * application-level reply retries are deliberately not added in this POC.
 */
import * as Lark from "@larksuiteoapi/node-sdk";

const BOT_INFO_PATH = "/open-apis/bot/v3/info";

function domainOf(config) {
  return config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

/**
 * @param {object} options
 * @param {object} options.config validated Feishu config
 * @param {Function} options.onEvent async (flattenedEvent) => void
 * @param {Function} [options.log] structured diagnostic sink
 */
export function createFeishuTransport({ config, onEvent, log = () => {} }) {
  if (typeof onEvent !== "function") throw new TypeError("createFeishuTransport requires onEvent()");

  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: domainOf(config),
    loggerLevel: Lark.LoggerLevel.error,
  });

  let wsClient;
  let botOpenId = config.botOpenId;
  let started = false;

  async function probeBotOpenId() {
    if (botOpenId) return botOpenId;
    const response = await client.request({ method: "GET", url: BOT_INFO_PATH });
    const code = response?.code;
    if (code !== 0) {
      throw new Error(`Feishu bot info failed: code=${code ?? "unknown"} msg=${response?.msg ?? "unknown"}`);
    }
    const openId = response?.bot?.open_id;
    if (typeof openId !== "string" || !openId.startsWith("ou_")) {
      throw new Error("Feishu bot info did not return a bot open_id");
    }
    botOpenId = openId;
    return botOpenId;
  }

  async function start() {
    if (started) return { botOpenId };
    await probeBotOpenId();

    const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.error }).register({
      "im.message.receive_v1": async (data) => {
        try {
          await onEvent(data);
        } catch (error) {
          log({
            level: "error",
            event: "feishu_event_handler_failed",
            code: String(error?.code ?? error?.name ?? "error"),
          });
        }
      },
    });

    wsClient = new Lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: domainOf(config),
      loggerLevel: Lark.LoggerLevel.error,
      onReady: () => log({ level: "info", event: "feishu_ws_ready" }),
      onReconnecting: () => log({ level: "warn", event: "feishu_ws_reconnecting" }),
      onReconnected: () => log({ level: "info", event: "feishu_ws_reconnected" }),
      onError: (error) =>
        log({
          level: "error",
          event: "feishu_ws_error",
          code: String(error?.code ?? error?.name ?? "error"),
        }),
    });

    await wsClient.start({ eventDispatcher: dispatcher });
    started = true;
    log({ level: "info", event: "feishu_ws_started", botOpenId: botOpenId ? `${botOpenId.slice(0, 6)}…` : undefined });
    return { botOpenId };
  }

  async function reply(messageId, text) {
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new Error("Feishu reply requires a message id");
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("Feishu reply requires non-empty text");
    }
    const response = await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "text", content: JSON.stringify({ text }) },
    });
    if (typeof response?.code === "number" && response.code !== 0) {
      throw new Error(`Feishu reply failed: code=${response.code} msg=${response.msg ?? "unknown"}`);
    }
    return { messageId: response?.data?.message_id };
  }

  function stop() {
    if (!started) return;
    started = false;
    try {
      wsClient?.close({ force: true });
    } catch (error) {
      log({
        level: "error",
        event: "feishu_ws_close_failed",
        code: String(error?.code ?? error?.name ?? "error"),
      });
    }
  }

  return {
    start,
    stop,
    reply,
    getBotOpenId: () => botOpenId,
  };
}
