/**
 * WeCom routing policy: decide, before any model work, whether one normalized
 * message may start a run.
 *
 * The policy is fail-closed. WeCom gives no structured mention information and
 * no group member list, so a group message is only accepted when its text
 * begins with the configured `@<botName>`; an unprovable mention is refused
 * instead of guessed. A group allowlist (when configured) is a local
 * conversation allowlist for this channel process: it is **not** Cloud Auth
 * authorization and grants no member account, tool or data privilege.
 */
import { stripBotMention } from "./events.mjs";

export const WECOM_ROUTE = Object.freeze({
  SINGLE: "single",
  GROUP: "group",
});

export const WECOM_IGNORE_REASON = Object.freeze({
  NON_USER_SOURCE: "non_user_source",
  UNSUPPORTED_MESSAGE_TYPE: "unsupported_message_type",
  USER_NOT_ALLOWED: "user_not_allowed",
  CHAT_NOT_ALLOWED: "chat_not_allowed",
  MENTION_REQUIRED: "mention_required",
  BOT_NAME_UNCONFIGURED: "bot_name_unconfigured",
  EMPTY_TEXT: "empty_text",
});

/**
 * @param {object} event normalized event from `normalizeWecomMessageEvent`
 * @param {{botName?: string, allowedUserIds?: readonly string[], allowedChatIds?: readonly string[]}} [policy]
 * @returns {{allowed: boolean, kind: string, reason: string, text: string}}
 */
export function decideWecomRoute(event, policy = {}) {
  const botName = policy.botName;
  const allowedUserIds = policy.allowedUserIds ?? [];
  const allowedChatIds = policy.allowedChatIds ?? [];

  if (event?.senderType !== "user") {
    return reject(WECOM_IGNORE_REASON.NON_USER_SOURCE, "", "application");
  }
  if (event?.messageType !== "text") {
    return reject(WECOM_IGNORE_REASON.UNSUPPORTED_MESSAGE_TYPE, "", event?.chatType ?? "unknown");
  }

  if (event.chatType === "single") {
    if (allowedUserIds.length > 0 && !allowedUserIds.includes(event.senderUserId)) {
      return reject(WECOM_IGNORE_REASON.USER_NOT_ALLOWED, "", WECOM_ROUTE.SINGLE);
    }
    const text = (event.text ?? "").trim();
    if (text.length === 0) return reject(WECOM_IGNORE_REASON.EMPTY_TEXT, "", WECOM_ROUTE.SINGLE);
    return { allowed: true, kind: WECOM_ROUTE.SINGLE, reason: "single_message", text };
  }

  if (event.chatType === "group") {
    if (allowedChatIds.length > 0 && !allowedChatIds.includes(event.chatId)) {
      return reject(WECOM_IGNORE_REASON.CHAT_NOT_ALLOWED, "", WECOM_ROUTE.GROUP);
    }
    // Without a configured display name the mention cannot be proven at all.
    if (typeof botName !== "string" || botName.length === 0) {
      return reject(WECOM_IGNORE_REASON.BOT_NAME_UNCONFIGURED, "", WECOM_ROUTE.GROUP);
    }
    const stripped = stripBotMention(event.text, botName);
    if (!stripped.mentioned) return reject(WECOM_IGNORE_REASON.MENTION_REQUIRED, "", WECOM_ROUTE.GROUP);
    if (stripped.text.length === 0) return reject(WECOM_IGNORE_REASON.EMPTY_TEXT, "", WECOM_ROUTE.GROUP);
    return { allowed: true, kind: WECOM_ROUTE.GROUP, reason: "group_mention", text: stripped.text };
  }

  return reject(WECOM_IGNORE_REASON.UNSUPPORTED_MESSAGE_TYPE, "", "unknown");
}

function reject(reason, text, kind) {
  return { allowed: false, kind, reason, text };
}
