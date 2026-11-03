/**
 * Feishu event fixtures for AGT-029 tests. Test-only; not imported by `src/`.
 */

export function textEvent({
  eventId = "evt_0001",
  messageId = "om_0000000000000001",
  chatId = "oc_0000000000000001",
  chatType = "p2p",
  text = "hello",
  mentions = [],
  senderType = "user",
  messageType = "text",
  content,
} = {}) {
  return {
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: "im.message.receive_v1",
      create_time: "1793600000000",
      token: "verification-token",
      app_id: "cli_test",
      tenant_key: "tenant_test",
    },
    event: {
      sender: {
        sender_id: { open_id: "ou_user_0001", union_id: "on_user_0001" },
        sender_type: senderType,
        tenant_key: "tenant_test",
      },
      message: {
        message_id: messageId,
        create_time: "1793600000000",
        chat_id: chatId,
        chat_type: chatType,
        message_type: messageType,
        content: content ?? JSON.stringify({ text }),
        mentions,
      },
    },
  };
}

/** The flattened v2 shape the official SDK actually hands to handlers. */
export function flattenedEvent(options = {}) {
  const payload = textEvent(options);
  return {
    ...payload.header,
    ...payload.event,
  };
}

export function botMention({ openId = "ou_bot_0001", key = "@_user_1", name = "Mira" } = {}) {
  return { key, id: { open_id: openId, union_id: "on_bot_0001" }, name, tenant_key: "tenant_test" };
}
