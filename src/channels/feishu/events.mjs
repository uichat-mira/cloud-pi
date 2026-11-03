/**
 * Normalize a Feishu `im.message.receive_v1` event into the small, trusted
 * shape the channel policy needs.
 *
 * Two payload shapes are accepted because the official SDK flattens v2 events
 * (`{...header, ...event}`) before invoking a handler, while the raw webhook
 * body keeps `{header, event}`. Nothing here trusts text to decide identity or
 * authorization: mention identity comes from `mentions[].id.open_id`.
 */

export const FEISHU_MESSAGE_EVENT = "im.message.receive_v1";

export function readFeishuEventType(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (payload.header && typeof payload.header === "object" && typeof payload.header.event_type === "string") {
    return payload.header.event_type;
  }
  return typeof payload.event_type === "string" ? payload.event_type : undefined;
}

function normalizeMentions(raw) {
  if (!Array.isArray(raw)) return [];
  const mentions = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    // Raw event: { key, id: { open_id }, name }. Some endpoints flatten id.
    const openId =
      typeof entry.id === "string" ? entry.id : typeof entry.id?.open_id === "string" ? entry.id.open_id : undefined;
    mentions.push({
      key: typeof entry.key === "string" ? entry.key : undefined,
      openId,
      name: typeof entry.name === "string" ? entry.name : undefined,
    });
  }
  return mentions;
}

function extractText(message) {
  if (message.message_type !== "text" || typeof message.content !== "string") return null;
  try {
    const parsed = JSON.parse(message.content);
    return typeof parsed?.text === "string" ? parsed.text : null;
  } catch {
    return null;
  }
}

function stripMentionKeys(text, mentions) {
  let out = text;
  for (const mention of mentions) {
    if (mention.key) out = out.split(mention.key).join("");
  }
  return out.trim();
}

/**
 * @param {unknown} payload raw webhook body or flattened SDK event
 * @returns {null | {
 *   eventId?: string, eventType: string, messageId: string, chatId: string,
 *   chatType: string, messageType: string, senderType: string, senderOpenId?: string,
 *   text: string|null, mentions: Array<{key?:string,openId?:string,name?:string}>,
 *   dedupeKey: string|null, createTime?: string
 * }}
 */
export function normalizeFeishuMessageEvent(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (readFeishuEventType(payload) !== FEISHU_MESSAGE_EVENT) return null;

  const header = payload.header && typeof payload.header === "object" ? payload.header : payload;
  const event = payload.event && typeof payload.event === "object" ? payload.event : payload;
  const message = event.message;
  if (!message || typeof message !== "object") return null;

  const messageId = typeof message.message_id === "string" ? message.message_id : "";
  const chatId = typeof message.chat_id === "string" ? message.chat_id : "";
  if (!messageId || !chatId) return null;

  const mentions = normalizeMentions(message.mentions);
  const rawText = extractText(message);
  const text = rawText === null ? null : stripMentionKeys(rawText, mentions);

  const eventId = typeof header.event_id === "string" ? header.event_id : undefined;
  return {
    eventId,
    eventType: FEISHU_MESSAGE_EVENT,
    messageId,
    chatId,
    chatType: typeof message.chat_type === "string" ? message.chat_type : "",
    messageType: typeof message.message_type === "string" ? message.message_type : "",
    senderType: typeof event.sender?.sender_type === "string" ? event.sender.sender_type : "user",
    senderOpenId: typeof event.sender?.sender_id?.open_id === "string" ? event.sender.sender_id.open_id : undefined,
    text,
    mentions,
    dedupeKey: eventId ? `event:${eventId}` : messageId ? `message:${messageId}` : null,
    createTime: typeof message.create_time === "string" ? message.create_time : undefined,
  };
}
