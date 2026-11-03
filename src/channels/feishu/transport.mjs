/**
 * Feishu transport: the thinnest wrapper over the official MIT
 * `@larksuiteoapi/node-sdk` (v1.76.0) that the channel needs.
 *
 * It owns network concerns only: WebSocket long connection, event dispatch,
 * bot open-id lookup, replying to an inbound message and proactively sending a
 * message to a configured destination (AGT-033). It does not read files, start
 * a daemon, create a Pi session or decide routing/recipients. The SDK's own
 * reconnect loop is used; application-level retries are deliberately not added
 * here — delivery policy belongs to `src/delivery/`.
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { maskId } from "./config.mjs";

const BOT_INFO_PATH = "/open-apis/bot/v3/info";

/** Bounded per-request timeout for a proactive send (Axios default is 0 = no bound). */
const DEFAULT_SEND_TIMEOUT_MS = 15_000;
const MAX_SEND_TIMEOUT_MS = 120_000;
export const SEND_TIMEOUT_ENV = "FEISHU_SEND_TIMEOUT_MS";

/** Only the two receive id types this POC actually sends to. */
const RECEIVE_ID_PATTERN = Object.freeze({
  open_id: /^ou_[A-Za-z0-9]+$/,
  chat_id: /^oc_[A-Za-z0-9_-]+$/,
});

/**
 * Feishu API business codes that are worth retrying. `99991400` is the
 * documented request-frequency limit; a network failure is also retryable.
 * Every other API-level rejection (invalid receive id, missing permission) is
 * treated as terminal so a bad destination cannot spam the API.
 */
export const RETRYABLE_FEISHU_SEND_CODES = Object.freeze([99991400]);

/** A send failure the delivery layer can classify without parsing messages. */
export class FeishuSendError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, retryable?: boolean, feishuCode?: number }} [options]
   */
  constructor(message, { code = "feishu_send_error", retryable = false, feishuCode } = {}) {
    super(message);
    this.name = "FeishuSendError";
    this.code = code;
    this.retryable = retryable;
    this.feishuCode = feishuCode;
  }
}

/**
 * Resolve the single-request timeout: explicit option, then env, then 15s.
 * Invalid values fail closed at transport creation instead of silently leaving
 * the SDK's unbounded `timeout: 0`.
 */
export function resolveSendTimeoutMs(value) {
  const raw = value ?? process.env[SEND_TIMEOUT_ENV] ?? DEFAULT_SEND_TIMEOUT_MS;
  const numeric = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 1 || numeric > MAX_SEND_TIMEOUT_MS) {
    throw new TypeError(
      `send timeout must be an integer between 1 and ${MAX_SEND_TIMEOUT_MS} ms (${SEND_TIMEOUT_ENV})`,
    );
  }
  return numeric;
}

function isTimeoutError(error) {
  return (
    error?.code === "ECONNABORTED" ||
    error?.code === "ETIMEDOUT" ||
    error?.code === "ERR_CANCELED" ||
    error?.name === "TimeoutError" ||
    error?.name === "CanceledError" ||
    /timed out|timeout|canceled|cancelled/i.test(String(error?.message ?? ""))
  );
}

/**
 * Build the dedicated HTTP instance used only by the proactive-send client.
 *
 * The locked SDK's `im.message.create` has no per-call options for a timeout or
 * signal, but its generated method always calls `this.httpInstance.request()`.
 * This wrapper injects both on every request:
 *
 * - `timeout` is forced to the transport's value (even if a caller passed a
 *   larger one), so Axios aborts the socket and rejects `ECONNABORTED`;
 * - `signal` is a cancellable `AbortSignal.timeout()` (or the caller's own
 *   signal), so a stalled request has an observable cancellation path.
 *
 * It never touches `defaults` of the shared instance, and reply/bot-info keep
 * using the untouched main client.
 */
export function createSendHttpInstance(baseHttpInstance, timeoutMs) {
  if (!baseHttpInstance || typeof baseHttpInstance.request !== "function") {
    throw new TypeError("createSendHttpInstance requires an httpInstance.request()");
  }
  const timed = (options = {}) => ({
    ...options,
    timeout: timeoutMs,
    signal: options.signal ?? AbortSignal.timeout(timeoutMs),
  });
  const call = (name, args) => {
    const method = baseHttpInstance[name];
    if (typeof method !== "function") {
      throw new TypeError(`send httpInstance does not support ${name}()`);
    }
    return method.apply(baseHttpInstance, args);
  };
  return {
    request: (options) => call("request", [timed(options)]),
    get: (url, options) => call("get", [url, timed(options)]),
    delete: (url, options) => call("delete", [url, timed(options)]),
    head: (url, options) => call("head", [url, timed(options)]),
    options: (url, options) => call("options", [url, timed(options)]),
    post: (url, data, options) => call("post", [url, data, timed(options)]),
    put: (url, data, options) => call("put", [url, data, timed(options)]),
    patch: (url, data, options) => call("patch", [url, data, timed(options)]),
  };
}

function businessRejection(error) {
  const data = error?.response?.data;
  if (data && typeof data.code === "number") return { code: data.code, msg: data.msg };
  if (typeof error?.code === "number") return { code: error.code, msg: error.msg };
  return null;
}

function assertSendInput({ receiveIdType, receiveId, text, uuid }) {
  const pattern = RECEIVE_ID_PATTERN[receiveIdType];
  if (!pattern) {
    throw new FeishuSendError(
      `unsupported receive_id_type: ${JSON.stringify(receiveIdType)}`,
      { code: "invalid_destination" },
    );
  }
  if (typeof receiveId !== "string" || !pattern.test(receiveId)) {
    throw new FeishuSendError("send requires a valid Feishu receive id for its type", {
      code: "invalid_destination",
    });
  }
  if (typeof text !== "string" || text.length === 0) {
    throw new FeishuSendError("send requires non-empty text", { code: "invalid_message" });
  }
  if (uuid !== undefined && (typeof uuid !== "string" || uuid.length === 0 || uuid.length > 64)) {
    throw new FeishuSendError("uuid must be a non-empty string of at most 64 characters", {
      code: "invalid_message",
    });
  }
}

function domainOf(config) {
  return config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

/**
 * @param {object} options
 * @param {object} options.config validated Feishu config
 * @param {Function} options.onEvent async (flattenedEvent) => void
 * @param {Function} [options.log] structured diagnostic sink
 * @param {object} [options.client] injected official SDK client (tests only)
 * @param {object} [options.sendClient] injected dedicated send client (tests
 *   only); production builds one with its own bounded httpInstance
 * @param {number} [options.sendTimeoutMs] bounded single-request timeout
 *   (default: FEISHU_SEND_TIMEOUT_MS or 15000 ms)
 */
export function createFeishuTransport({
  config,
  onEvent,
  log = () => {},
  client: injectedClient,
  sendClient: injectedSendClient,
  sendTimeoutMs: sendTimeoutOption,
}) {
  if (typeof onEvent !== "function") throw new TypeError("createFeishuTransport requires onEvent()");

  const client =
    injectedClient ??
    new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: domainOf(config),
      loggerLevel: Lark.LoggerLevel.error,
    });

  const sendTimeoutMs = resolveSendTimeoutMs(sendTimeoutOption);
  // A dedicated client keeps send timeouts out of the reply/bot-info/websocket
  // client. Its httpInstance injects timeout/signal per request; the shared
  // Axios defaults object is never mutated.
  const sendingClient =
    injectedSendClient ??
    (injectedClient
      ? injectedClient
      : new Lark.Client({
          appId: config.appId,
          appSecret: config.appSecret,
          appType: Lark.AppType.SelfBuild,
          domain: domainOf(config),
          loggerLevel: Lark.LoggerLevel.error,
          httpInstance: createSendHttpInstance(client.httpInstance, sendTimeoutMs),
        }));

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

  /**
   * Proactively send one text message to a configured user or group.
   *
   * Uses the official `client.im.message.create` with
   * `params.receive_id_type = "open_id" | "chat_id"` (AGT-033). The stable
   * `uuid` lets Feishu suppress an identical retry within its own window; it
   * is a best-effort second guard behind the local delivery idempotency store.
   *
   * @returns {Promise<{ messageId: string }>}
   */
  async function send({ receiveIdType, receiveId, text, uuid }) {
    assertSendInput({ receiveIdType, receiveId, text, uuid });
    let response;
    try {
      response = await sendingClient.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "text",
          content: JSON.stringify({ text }),
          ...(uuid ? { uuid } : {}),
        },
      });
    } catch (error) {
      // The SDK can throw even for HTTP business rejections (AxiosError with
      // `response.data.code`), not only for network failures. Classify that
      // business code first; otherwise an invalid destination would be retried
      // as if it were a transient network error.
      const rejection = businessRejection(error);
      if (rejection) {
        const retryable = RETRYABLE_FEISHU_SEND_CODES.includes(rejection.code);
        log({
          level: retryable ? "warn" : "error",
          event: "feishu_send_rejected",
          destination: maskId(receiveId),
          feishuCode: rejection.code,
          retryable,
        });
        throw new FeishuSendError(`Feishu send rejected: code=${rejection.code}`, {
          code: "feishu_api_error",
          retryable,
          feishuCode: rejection.code,
        });
      }
      if (isTimeoutError(error)) {
        log({
          level: "warn",
          event: "feishu_send_timeout",
          destination: maskId(receiveId),
          timeoutMs: sendTimeoutMs,
        });
        throw new FeishuSendError(`Feishu send timed out after ${sendTimeoutMs}ms`, {
          code: "feishu_send_timeout",
          retryable: true,
        });
      }
      if (error instanceof FeishuSendError) throw error;
      // A genuine transport/protocol failure is retryable.
      log({
        level: "warn",
        event: "feishu_send_network_error",
        destination: maskId(receiveId),
        error: String(error?.code ?? error?.name ?? "error"),
      });
      throw new FeishuSendError(`Feishu send failed: ${error?.message ?? error}`, {
        code: "feishu_network_error",
        retryable: true,
      });
    }
    const code = response?.code;
    if (typeof code === "number" && code !== 0) {
      const retryable = RETRYABLE_FEISHU_SEND_CODES.includes(code);
      log({
        level: retryable ? "warn" : "error",
        event: "feishu_send_rejected",
        destination: maskId(receiveId),
        feishuCode: code,
        retryable,
      });
      throw new FeishuSendError(`Feishu send failed: code=${code} msg=${response?.msg ?? "unknown"}`, {
        code: "feishu_api_error",
        retryable,
        feishuCode: code,
      });
    }
    const messageId = response?.data?.message_id;
    if (typeof messageId !== "string" || messageId.length === 0) {
      // Never report success without a platform message id: a retry could
      // duplicate a message we cannot identify.
      throw new FeishuSendError("Feishu send returned no message_id", {
        code: "missing_message_id",
        retryable: false,
      });
    }
    log({
      level: "info",
      event: "feishu_message_sent",
      destination: maskId(receiveId),
      receiveIdType,
    });
    return { messageId };
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
    send,
    probeBotOpenId,
    getBotOpenId: () => botOpenId,
    /** Read-only diagnostics for live evidence: isolation + shared defaults. */
    diagnostics: () => ({
      dedicatedSendClient: sendingClient !== client,
      sendTimeoutMs,
      sharedDefaultsTimeout: client?.httpInstance?.defaults?.timeout ?? null,
    }),
  };
}
