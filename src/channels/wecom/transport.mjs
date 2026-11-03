/**
 * WeCom transport: a thin wrapper over the official long-connection SDK.
 *
 * The SDK owns the WebSocket, the subscribe handshake, heartbeats and reconnect
 * backoff; this module owns only what the SDK cannot express:
 *
 *  - reply framing (`replyStream` needs a stream id, and the channel sends
 *    bounded segments rather than one streaming answer);
 *  - the per-conversation rate limits (30/min, 1000/h) the platform documents;
 *  - the `chat_type` gap: `WSClient.sendMessage()` cannot send `chat_type`, so a
 *    single-chat push would be inferred as a group chat. This module refuses it
 *    instead of delivering to the wrong place;
 *  - a hard timeout per send so a missing protocol ack can never hang a run.
 *
 * The SDK is imported lazily, so offline tests and any non-WeCom command never
 * need the package to be installed. The SDK module only writes to the module the
 * transport exposes; it never sees credentials outside the client options.
 */

import { WECOM_MAX_CONTENT_BYTES, hashId } from "./config.mjs";
import { byteLength } from "./text.mjs";

export const WECOM_RATE_LIMITS = Object.freeze({
  perMinute: 30,
  perHour: 1_000,
});

export class WecomTransportError extends Error {
  constructor(code, detail, { retryable = false } = {}) {
    super(detail ? `WeCom transport error (${code}): ${detail}` : `WeCom transport error (${code})`);
    this.name = "WecomTransportError";
    this.code = code;
    this.retryable = retryable;
  }
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    // Deliberately not unref'd: this timer is what turns a silent peer into a
    // bounded failure, so it must keep the event loop alive until it fires.
    timer = setTimeout(() => reject(new WecomTransportError(code, `timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function importSdkClient() {
  let module;
  try {
    module = await import("@wecom/aibot-node-sdk");
  } catch (error) {
    throw new WecomTransportError("sdk_unavailable", "install @wecom/aibot-node-sdk@1.0.7", {
      retryable: false,
    });
  }
  const Client = module?.WSClient ?? module?.default?.WSClient ?? module?.default;
  if (typeof Client !== "function") {
    throw new WecomTransportError("sdk_incompatible", "WSClient export not found");
  }
  return Client;
}

/**
 * @param {object} options
 * @param {object} options.config validated config from `loadWecomConfig()`
 * @param {(event: {frame: object, type: string}) => void} options.onEvent
 * @param {Function} [options.log]
 * @param {(options: object) => (Promise<object>|object)} [options.createClient] SDK injection (tests)
 * @param {() => number} [options.now]
 */
export function createWecomTransport({ config, onEvent, log = () => {}, createClient, now = Date.now } = {}) {
  if (!config) throw new TypeError("createWecomTransport requires config");

  let client;
  let starting;
  let authenticated = false;
  let stopped = false;
  let streamCounter = 0;
  let lastError;
  let rejectAuthentication;
  /** @type {Map<string, number[]>} chatId → send timestamps (ms) */
  const sendHistory = new Map();
  const listeners = [];

  /** The SDK reports a rejected subscribe as an error, then retries and gives up. */
  function looksLikeAuthFailure(message) {
    return /853000|invalid bot_id|authentication failed|auth failure/i.test(String(message ?? ""));
  }

  function attach(target, event, handler) {
    target.on(event, handler);
    listeners.push([event, handler]);
  }

  function note(event, detail = {}) {
    log({ level: "info", event, ...detail });
  }

  function prune(chatId, at) {
    const history = sendHistory.get(chatId);
    if (!history) return [];
    const kept = history.filter((timestamp) => at - timestamp < 60 * 60 * 1_000);
    sendHistory.set(chatId, kept);
    return kept;
  }

  function assertWithinRateLimit(chatId) {
    const at = now();
    const history = prune(chatId, at);
    const lastMinute = history.filter((timestamp) => at - timestamp < 60 * 1_000).length;
    if (lastMinute >= WECOM_RATE_LIMITS.perMinute) {
      return { retryAfterMs: 60_000 - (at - history[history.length - WECOM_RATE_LIMITS.perMinute]) };
    }
    if (history.length >= WECOM_RATE_LIMITS.perHour) {
      return { retryAfterMs: 60 * 60 * 1_000 - (at - history[0]) };
    }
    return null;
  }

  function recordSend(chatId) {
    const history = prune(chatId, now());
    history.push(now());
    sendHistory.set(chatId, history);
  }

  function assertTextFits(content) {
    const bytes = byteLength(content);
    if (bytes > WECOM_MAX_CONTENT_BYTES) {
      throw new WecomTransportError(
        "content_too_large",
        `${bytes} bytes exceeds ${WECOM_MAX_CONTENT_BYTES}; channel must segment first`,
      );
    }
  }

  async function start() {
    if (stopped) throw new WecomTransportError("stopped", "transport already stopped");
    if (starting) return starting;
    starting = (async () => {
      const Factory = createClient
        ? createClient
        : async (options) => {
            const Client = await importSdkClient();
            return new Client(options);
          };
      const clientOptions = {
        botId: config.botId,
        secret: config.botSecret,
        heartbeatInterval: config.heartbeatIntervalMs,
        ...(config.wsUrl ? { wsUrl: config.wsUrl } : {}),
      };
      try {
        client = await Factory(clientOptions);
      } catch (error) {
        if (error instanceof WecomTransportError) throw error;
        // Never echo the SDK message here: it can contain the subscribe payload.
        throw new WecomTransportError("client_create_failed", "the SDK client could not be created");
      }

      // The platform sends `event.enter_chat` about three seconds before the
      // first `aibot_msg_callback`. We only record it; replying to a welcome
      // event would need that event's own req_id.
      attach(client, "event.enter_chat", (frame) => {
        note("wecom_transport_enter_chat", {
          chatType: frame?.body?.chattype,
          chatId: frame?.body?.chatid ? hashId(frame.body.chatid) : undefined,
        });
      });
      attach(client, "message", (frame) => {
        // NOTE: the frame itself must be forwarded. `client.replyStream(frame, …)`
        // reads `frame.headers.req_id`; handing it `frame.headers` yields an empty
        // req_id and the platform rejects the reply with `846605 invalid req_id`
        // (observed in the real smoke, not inferred).
        try {
          onEvent?.({ frame, type: frame?.body?.msgtype ?? "unknown" });
        } catch (error) {
          log({ level: "error", event: "wecom_event_dispatch_failed", message: String(error?.message ?? error) });
        }
      });
      attach(client, "error", (error) => {
        lastError = String(error?.message ?? error ?? "unknown");
        log({ level: "warn", event: "wecom_transport_error", message: lastError });
        // A rejected subscribe must fail startup immediately instead of waiting
        // for the connect timeout.
        if (!authenticated && rejectAuthentication && looksLikeAuthFailure(lastError)) {
          rejectAuthentication(
            new WecomTransportError("auth_failed", "the platform rejected bot_id/secret", { retryable: false }),
          );
          rejectAuthentication = undefined;
        }
      });
      attach(client, "disconnected", (detail) => {
        authenticated = false;
        // The platform allows one connection per bot: a new subscriber kicks the
        // old one, and the SDK does not reconnect after `disconnected_event`.
        note("wecom_transport_disconnected", { reason: typeof detail === "string" ? detail : undefined });
      });
      attach(client, "reconnecting", (attempt) => {
        note("wecom_transport_reconnecting", { attempt: typeof attempt === "number" ? attempt : undefined });
      });

      const authenticatedPromise = new Promise((resolve, reject) => {
        rejectAuthentication = reject;
        attach(client, "authenticated", () => {
          authenticated = true;
          rejectAuthentication = undefined;
          resolve();
        });
      });

      try {
        await client.connect?.();
      } catch (error) {
        if (error instanceof WecomTransportError) throw error;
        throw new WecomTransportError("connect_failed", String(error?.message ?? error), { retryable: true });
      }

      try {
        await withTimeout(authenticatedPromise, config.connectTimeoutMs, "connect_timeout");
      } catch (error) {
        await stop().catch(() => {});
        throw error instanceof WecomTransportError
          ? error
          : new WecomTransportError("connect_timeout", String(error?.message ?? error), { retryable: true });
      }

      note("wecom_transport_authenticated", {
        botId: hashId(config.botId),
        wsUrl: config.wsUrl ?? "sdk_default",
      });
      return { authenticated: true };
    })();
    return starting;
  }

  /**
   * Reply in the conversation the callback came from. One segment per call.
   * @param {object} frame the callback frame (its `headers.req_id` is the reply handle)
   * @param {string} text one segment, already byte-bounded by the channel
   */
  async function reply(frame, text) {
    if (!authenticated || !client) throw new WecomTransportError("not_connected", "reply before authentication");
    const content = typeof text === "string" ? text : "";
    if (content.length === 0) throw new WecomTransportError("empty_reply", "refusing to send an empty reply");
    assertTextFits(content);

    const reqId = frame?.headers?.req_id ?? frame?.headers?.reqId;
    if (typeof reqId !== "string" || reqId.length === 0) {
      throw new WecomTransportError("missing_req_id", "callback frame has no reply handle");
    }
    if (typeof client.replyStream !== "function") {
      throw new WecomTransportError("sdk_incompatible", "replyStream() not available");
    }

    streamCounter += 1;
    const streamId = `${reqId}-${streamCounter}`;
    const limit = assertWithinRateLimit(reqId);
    if (limit) {
      throw new WecomTransportError("rate_limited", `retry after ~${Math.max(1, Math.round(limit.retryAfterMs / 1000))}s`, {
        retryable: true,
      });
    }

    try {
      // Pass the WHOLE callback frame. The SDK reads `frame.headers.req_id`
      // internally; passing `frame.headers` instead produces an empty req_id and
      // the platform answers `846605 invalid req_id` — measured in the real
      // long-connection smoke, so this is a verified trap, not a guess.
      const ack = await withTimeout(
        Promise.resolve(client.replyStream(frame, streamId, content, true)),
        config.replyTimeoutMs,
        "reply_timeout",
      );
      recordSend(reqId);
      // The SDK resolves only on a platform acknowledgement, so a resolved call is
      // an accepted delivery; the code is reported for the evidence projection.
      return { replyId: streamId, errcode: typeof ack?.errcode === "number" ? ack.errcode : 0 };
    } catch (error) {
      if (error instanceof WecomTransportError) throw error;
      throw new WecomTransportError("reply_failed", String(error?.message ?? error), { retryable: false });
    }
  }

  /**
   * Proactive push to an existing conversation (`aibot_send_msg`).
   *
   * `chat_type` is required: when it is absent the platform assumes a group chat,
   * so a single-chat push would be misrouted. The SDK's typed `SendMsgBody` does
   * not declare `chat_type`, but `sendMessage()` spreads the body into the frame
   * unchanged, so the documented field (1 single / 2 group, per the platform's
   * `aibot_send_msg` reference) is passed explicitly.
   *
   * The platform only accepts a push into a conversation the bot has already
   * seen; that precondition is enforced by the caller (delivery sender), not
   * guessed here.
   *
   * @param {{chatId: string, chatType: "single"|"group", text: string}} input
   * @returns {Promise<{delivered: true, errcode: number}>} resolves on a platform ack
   */
  async function send({ chatId, chatType, text } = {}) {
    if (!authenticated || !client) throw new WecomTransportError("not_connected", "send before authentication");
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new WecomTransportError("invalid_target", "chatId is required");
    }
    if (chatType !== "single" && chatType !== "group") {
      throw new WecomTransportError("invalid_target", "chatType must be single or group");
    }
    const content = typeof text === "string" ? text : "";
    if (content.length === 0) throw new WecomTransportError("empty_message", "refusing to send an empty message");
    assertTextFits(content);

    const limit = assertWithinRateLimit(chatId);
    if (limit) {
      throw new WecomTransportError("rate_limited", `retry after ~${Math.max(1, Math.round(limit.retryAfterMs / 1000))}s`, {
        retryable: true,
      });
    }
    if (typeof client.sendMessage !== "function") {
      throw new WecomTransportError("sdk_incompatible", "sendMessage() not available");
    }

    let ack;
    try {
      ack = await withTimeout(
        Promise.resolve(
          client.sendMessage(chatId, {
            chat_type: chatType === "group" ? 2 : 1,
            msgtype: "markdown",
            markdown: { content },
          }),
        ),
        config.replyTimeoutMs,
        "send_timeout",
      );
    } catch (error) {
      if (error instanceof WecomTransportError) throw error;
      throw new WecomTransportError("send_failed", String(error?.message ?? error), { retryable: true });
    }
    recordSend(chatId);
    // The SDK resolves only on a platform acknowledgement; report its code so the
    // delivery record keeps the real receipt and not just "we called send()".
    return { delivered: true, errcode: typeof ack?.errcode === "number" ? ack.errcode : 0 };
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    authenticated = false;
    if (client) {
      for (const [event, handler] of listeners) client.off?.(event, handler);
      listeners.length = 0;
      try {
        await withTimeout(Promise.resolve(client.disconnect?.()), 3_000, "disconnect_timeout");
      } catch (error) {
        log({ level: "warn", event: "wecom_transport_disconnect_failed", code: String(error?.code ?? "error") });
      }
    }
    note("wecom_transport_stopped");
  }

  return {
    start,
    reply,
    send,
    stop,
    get isAuthenticated() {
      return authenticated;
    },
    get lastError() {
      return lastError;
    },
    /** Diagnostics only: never the credential itself. */
    describe() {
      return {
        state: stopped ? "stopped" : authenticated ? "authenticated" : "connecting",
        wsUrl: config.wsUrl ?? "sdk_default",
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        botId: hashId(config.botId),
      };
    },
  };
}
