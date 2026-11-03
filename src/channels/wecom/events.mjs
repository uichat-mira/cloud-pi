/**
 * WeCom callback → channel event normalization.
 *
 * The智能机器人 long-connection protocol delivers one JSON frame per callback:
 *
 *   {
 *     cmd: "aibot_msg_callback",
 *     headers: { req_id: "..." },
 *     body: {
 *       msgid, msgtype: "text"|"mixed"|"image"|...,
 *       chattype: "single"|"group", chatid?, from: { userid },
 *       text: { content }, compat_info?: { source }
 *     }
 *   }
 *
 * Facts that shape this module (see docs/research/wecom-channel/):
 *  - there is no structured mention list: `@<bot>` exists only inside the text;
 *  - there is no `eventId`; `msgid` is the only documented dedupe handle and the
 *    platform may re-deliver the same callback;
 *  - `chatid` is only present for group chats, so a single chat uses the sender
 *    `userid` as its conversation key;
 *  - `compat_info.source` marks a message produced by another application, not
 *    by a person.
 *
 * Identity is never derived from message text: the sender and the conversation
 * come from platform fields only.
 */

export const WECOM_MESSAGE_CALLBACK = "aibot_msg_callback";

/** Message types this channel handles. Everything else is ignored, not guessed. */
export const WECOM_SUPPORTED_MESSAGE_TYPE = "text";

/**
 * Accepts either our transport envelope `{ frame, type }` or a bare frame, so
 * the normalizer stays usable from tests and from a different transport shape.
 */
function readFrame(payload) {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload.frame && typeof payload.frame === "object" ? payload.frame : payload;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/**
 * @param {unknown} payload transport envelope or raw callback frame
 * @returns {null | Readonly<{
 *   eventId: undefined,
 *   messageId: string,
 *   chatId: string,
 *   chatType: "single"|"group",
 *   messageType: string,
 *   senderType: "user"|"application",
 *   senderUserId: string|undefined,
 *   text: string|null,
 *   mentions: ReadonlyArray<never>,
 *   dedupeKey: string|null,
 *   frame: object
 * }>}
 */
export function normalizeWecomMessageEvent(payload) {
  const frame = readFrame(payload);
  if (!frame) return null;

  const cmd = typeof frame.cmd === "string" ? frame.cmd : undefined;
  if (cmd !== undefined && cmd !== WECOM_MESSAGE_CALLBACK) return null;

  const body = frame.body;
  if (!body || typeof body !== "object") return null;

  const messageId = typeof body.msgid === "string" && body.msgid.length > 0 ? body.msgid : null;
  const chatTypeRaw = typeof body.chattype === "string" ? body.chattype.toLowerCase() : "";
  const senderUserId =
    body.from && typeof body.from === "object" && typeof body.from.userid === "string" && body.from.userid.length > 0
      ? body.from.userid
      : undefined;

  const groupChatId = typeof body.chatid === "string" && body.chatid.length > 0 ? body.chatid : undefined;
  const chatId = chatTypeRaw === "group" ? groupChatId : senderUserId;
  // Without a conversation key the reply has nowhere to go; refuse rather than
  // invent one.
  if (!chatId) return null;
  if (chatTypeRaw !== "single" && chatTypeRaw !== "group") return null;

  const messageType = typeof body.msgtype === "string" ? body.msgtype.toLowerCase() : "";
  const text = readText(body);
  const source = body.compat_info && typeof body.compat_info === "object" ? body.compat_info.source : undefined;

  return Object.freeze({
    eventId: undefined,
    messageId: messageId ?? chatId,
    chatId,
    chatType: chatTypeRaw,
    messageType,
    senderType: typeof source === "string" && source.length > 0 ? "application" : "user",
    senderUserId,
    text,
    mentions: Object.freeze([]),
    dedupeKey: messageId ? `wecom:msg:${messageId}` : null,
    frame,
  });
}

function readText(body) {
  const text = body.text;
  if (text && typeof text === "object" && typeof text.content === "string") return text.content;
  return null;
}

/**
 * Remove one leading `@<botName>` plus the whitespace after it.
 *
 * The platform gives no mention metadata, so this is deliberately strict: the
 * mention must be the first thing in the message and must match the configured
 * display name exactly. Anything else stays unparsed and is reported as such by
 * the policy layer instead of being guessed.
 *
 * @param {string|null} text
 * @param {string|undefined} botName
 * @returns {{ mentioned: boolean, text: string }}
 */
export function stripBotMention(text, botName) {
  if (typeof text !== "string" || text.length === 0) return { mentioned: false, text: "" };
  if (typeof botName !== "string" || botName.length === 0) return { mentioned: false, text };
  const trimmedStart = text.replace(/^[\s\u200b]+/, "");
  const token = `@${botName}`;
  if (!trimmedStart.startsWith(token)) return { mentioned: false, text };
  const rest = trimmedStart.slice(token.length);
  // `@RobotA2` must not match a bot named `RobotA`.
  if (rest.length > 0 && !/[\s\u200b]/.test(rest[0])) return { mentioned: false, text };
  return { mentioned: true, text: rest.trim() };
}
