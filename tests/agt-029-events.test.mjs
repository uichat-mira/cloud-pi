/**
 * AGT-029 T1: Feishu event normalization.
 *
 * Both the raw v2 webhook body and the flattened shape the SDK dispatcher
 * produces must normalize to the same trusted fields.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FEISHU_MESSAGE_EVENT,
  normalizeFeishuMessageEvent,
  readFeishuEventType,
} from "../src/channels/feishu/events.mjs";
import { botMention, flattenedEvent, textEvent } from "./helpers/feishu-events.mjs";

describe("AGT-029 T1: Feishu event normalization", () => {
  test("normalizes a raw v2 private message", () => {
    const event = normalizeFeishuMessageEvent(textEvent({ text: "ping" }));
    assert.equal(event.eventType, FEISHU_MESSAGE_EVENT);
    assert.equal(event.eventId, "evt_0001");
    assert.equal(event.messageId, "om_0000000000000001");
    assert.equal(event.chatId, "oc_0000000000000001");
    assert.equal(event.chatType, "p2p");
    assert.equal(event.messageType, "text");
    assert.equal(event.senderType, "user");
    assert.equal(event.senderOpenId, "ou_user_0001");
    assert.equal(event.text, "ping");
    assert.equal(event.dedupeKey, "event:evt_0001");
  });

  test("normalizes the SDK flattened event to the same fields", () => {
    const nested = normalizeFeishuMessageEvent(textEvent({ text: "same" }));
    const flattened = normalizeFeishuMessageEvent(flattenedEvent({ text: "same" }));
    assert.deepEqual(flattened, nested);
  });

  test("strips bot mention keys from group text", () => {
    const event = normalizeFeishuMessageEvent(
      textEvent({
        chatType: "group",
        chatId: "oc_group_1",
        text: "@_user_1 帮我总结一下",
        mentions: [botMention()],
      }),
    );
    assert.equal(event.text, "帮我总结一下");
    assert.deepEqual(event.mentions, [{ key: "@_user_1", openId: "ou_bot_0001", name: "Mira" }]);
  });

  test("supports a flattened mention id while keeping open_id usable", () => {
    const event = normalizeFeishuMessageEvent(
      textEvent({ mentions: [{ key: "@_user_1", id: "ou_bot_0001", id_type: "open_id", name: "Mira" }] }),
    );
    assert.equal(event.mentions[0].openId, "ou_bot_0001");
  });

  test("keeps non-text and malformed content out of the text field", () => {
    const post = normalizeFeishuMessageEvent(
      textEvent({ messageType: "post", content: JSON.stringify({ zh_cn: { content: [] } }) }),
    );
    assert.equal(post.text, null);

    const malformed = normalizeFeishuMessageEvent(textEvent({ content: "{not-json" }));
    assert.equal(malformed.text, null);
  });

  test("falls back to message_id when event_id is absent", () => {
    const payload = textEvent();
    delete payload.header.event_id;
    const event = normalizeFeishuMessageEvent(payload);
    assert.equal(event.eventId, undefined);
    assert.equal(event.dedupeKey, "message:om_0000000000000001");
  });

  test("ignores unsupported event types and structurally invalid payloads", () => {
    assert.equal(normalizeFeishuMessageEvent({ header: { event_type: "im.chat.member.bot.added_v1" } }), null);
    assert.equal(normalizeFeishuMessageEvent({}), null);
    assert.equal(normalizeFeishuMessageEvent(null), null);

    const missingIds = textEvent();
    delete missingIds.event.message.message_id;
    assert.equal(normalizeFeishuMessageEvent(missingIds), null);

    assert.equal(readFeishuEventType({ header: { event_type: "im.message.receive_v1" } }), "im.message.receive_v1");
    assert.equal(readFeishuEventType({ event_type: "im.message.receive_v1" }), "im.message.receive_v1");
    assert.equal(readFeishuEventType({}), undefined);
  });
});
