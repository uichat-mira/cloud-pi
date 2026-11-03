/**
 * WeCom destination sender for the AGT-033 delivery stage (AGT-036 follow-up).
 *
 * This is the missing half of W1: the schedule contract already stores
 * `wecom_user` / `wecom_chat` targets, and this module turns one such target plus
 * one already-bounded text segment into a real `aibot_send_msg` push — through
 * the *channel's own* transport, so there is exactly one WebSocket, one
 * credential source and one rate-limit ledger in the process.
 *
 * What this module owns (and nothing else):
 *
 *  - mapping a target type onto the platform's `chat_type` (1 single / 2 group);
 *  - refusing a target the platform cannot accept (no prior inbound message);
 *  - enforcing the 20480-byte per-message limit explicitly, before the wire;
 *  - translating a transport failure into a classified `DeliveryError` so the
 *    coordinator records a code instead of a generic "internal error".
 *
 * What it deliberately does not own: segmentation, retries, idempotency keys and
 * the per-destination record. Those stay in the coordinator, unchanged and shared
 * with the Feishu path.
 *
 * Idempotency note: the platform does not return a message id for a push, so the
 * coordinator's stable segment uuid is persisted as `messageId` and the platform
 * acknowledgement is stored next to it as `ack`. A resolved send means "the
 * platform acked this segment", not "we wrote it to a socket".
 */
import { WECOM_MAX_CONTENT_BYTES } from "../channels/wecom/config.mjs";
import { byteLength } from "../channels/wecom/text.mjs";
import { DELIVERY_ERROR, DeliveryError } from "./contracts.mjs";

/** Target type → the platform's `chat_type` and the known-session expectation. */
const TARGET_CHAT_TYPE = Object.freeze({
  wecom_user: "single",
  wecom_chat: "group",
});

/** Transport failure classes the delivery record can express. */
const TRANSPORT_CODE_MAP = Object.freeze({
  rate_limited: DELIVERY_ERROR.RATE_LIMITED,
  not_connected: DELIVERY_ERROR.CHANNEL_UNAVAILABLE,
  sdk_unavailable: DELIVERY_ERROR.CHANNEL_UNAVAILABLE,
  sdk_incompatible: DELIVERY_ERROR.TRANSPORT_ERROR,
  content_too_large: DELIVERY_ERROR.SEGMENT_TOO_LARGE,
  empty_message: DELIVERY_ERROR.INVALID_DESTINATION,
  invalid_target: DELIVERY_ERROR.INVALID_DESTINATION,
  send_timeout: DELIVERY_ERROR.TRANSPORT_ERROR,
  send_failed: DELIVERY_ERROR.TRANSPORT_ERROR,
});

function toWecomDeliveryError(error) {
  if (error instanceof DeliveryError) return error;
  const transportCode = typeof error?.code === "string" ? error.code : "send_failed";
  const code = TRANSPORT_CODE_MAP[transportCode] ?? DELIVERY_ERROR.TRANSPORT_ERROR;
  // Retry only when the transport itself says the failure is transient; a rate
  // limit is retryable by definition but the coordinator still bounds attempts.
  const retryable = error?.retryable === true;
  return new DeliveryError(code, `${transportCode}: ${String(error?.message ?? error).slice(0, 240)}`, {
    retryable,
    cause: error,
  });
}

/**
 * @param {object} options
 * @param {(input: {chatId: string, chatType: "single"|"group", text: string}) => Promise<object>} options.send
 *   the WeCom channel transport's `send()`
 * @param {object} [options.sessions] known-conversation store (`assertDeliverable`)
 * @param {boolean} [options.requireKnownSession] refuse a conversation the bot has
 *   never seen (the platform's own precondition). Defaults to true.
 * @param {number} [options.maxBytes] per-message byte budget (default 20480)
 * @param {object} [options.logger]
 */
export function createWecomDeliverySender({
  send,
  sessions,
  requireKnownSession = true,
  maxBytes = WECOM_MAX_CONTENT_BYTES,
  logger = {},
} = {}) {
  if (typeof send !== "function") {
    throw new TypeError("createWecomDeliverySender requires the channel transport's send()");
  }

  async function deliver({ receiveIdType, receiveId, text, uuid }) {
    const chatType = TARGET_CHAT_TYPE[receiveIdType];
    if (!chatType) {
      throw new DeliveryError(DELIVERY_ERROR.INVALID_DESTINATION, `unsupported WeCom target type ${String(receiveIdType)}`);
    }
    const content = typeof text === "string" ? text : "";
    if (content.length === 0) {
      throw new DeliveryError(DELIVERY_ERROR.INVALID_DESTINATION, "refusing to deliver an empty segment");
    }
    const bytes = byteLength(content);
    if (bytes > maxBytes) {
      // Never truncate silently: a partial research report is worse than none.
      throw new DeliveryError(
        DELIVERY_ERROR.SEGMENT_TOO_LARGE,
        `${bytes} bytes exceeds the WeCom ${maxBytes}-byte limit`,
      );
    }

    if (requireKnownSession) {
      if (!sessions || typeof sessions.assertDeliverable !== "function") {
        throw new DeliveryError(
          DELIVERY_ERROR.CHANNEL_UNAVAILABLE,
          "no known-session store is wired; refusing to push blindly",
        );
      }
      const verdict = sessions.assertDeliverable({ chatId: receiveId, chatType });
      if (!verdict.deliverable) {
        // Terminal: retrying cannot make the platform accept a conversation the
        // bot has never seen, so this must not consume the attempt budget.
        throw new DeliveryError(
          DELIVERY_ERROR.SESSION_UNKNOWN,
          `${verdict.reason}: no inbound message from this conversation yet`,
        );
      }
    }

    try {
      const ack = await send({ chatId: receiveId, chatType, text: content });
      const errcode = typeof ack?.errcode === "number" ? ack.errcode : null;
      logger.info?.(`delivery: wecom push accepted (errcode ${errcode ?? "n/a"})`);
      // The platform returns no message id for a push; the coordinator's stable
      // segment uuid is the local handle and `ack` carries the real proof.
      return { messageId: typeof uuid === "string" && uuid ? uuid : "wecom-ack", ack: { errcode } };
    } catch (error) {
      throw toWecomDeliveryError(error);
    }
  }

  return {
    /** The map the coordinator expects: one function per WeCom target type. */
    senders: {
      wecom_user: (request) => deliver({ ...request, receiveIdType: "wecom_user" }),
      wecom_chat: (request) => deliver({ ...request, receiveIdType: "wecom_chat" }),
    },
    deliver,
    maxBytes,
  };
}
