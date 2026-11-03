import assert from "node:assert/strict";
import test from "node:test";
import { createWecomDedupeStore } from "../src/channels/wecom/dedupe.mjs";
import { normalizeWecomMessageEvent, stripBotMention } from "../src/channels/wecom/events.mjs";
import { WECOM_IGNORE_REASON, decideWecomRoute } from "../src/channels/wecom/policy.mjs";

function singleFrame(overrides = {}) {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: "req-1" },
    body: {
      msgid: "msg-1",
      msgtype: "text",
      chattype: "single",
      from: { userid: "user-a" },
      text: { content: "hello" },
      ...overrides,
    },
  };
}

function groupFrame(overrides = {}) {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: "req-2" },
    body: {
      msgid: "msg-2",
      msgtype: "text",
      chattype: "group",
      chatid: "chat-x",
      from: { userid: "user-b" },
      text: { content: "@MiraBot 请总结今天的新闻" },
      ...overrides,
    },
  };
}

test("normalizeWecomMessageEvent: single chat uses the sender userid as conversation key", () => {
  const event = normalizeWecomMessageEvent({ frame: singleFrame(), type: "text" });
  assert.equal(event.chatType, "single");
  assert.equal(event.chatId, "user-a");
  assert.equal(event.senderUserId, "user-a");
  assert.equal(event.messageId, "msg-1");
  assert.equal(event.messageType, "text");
  assert.equal(event.senderType, "user");
  assert.equal(event.text, "hello");
  assert.equal(event.dedupeKey, "wecom:msg:msg-1");
});

test("normalizeWecomMessageEvent: group chat uses chatid, keeps the mention in the text", () => {
  const event = normalizeWecomMessageEvent(groupFrame());
  assert.equal(event.chatType, "group");
  assert.equal(event.chatId, "chat-x");
  assert.equal(event.text, "@MiraBot 请总结今天的新闻");
  assert.deepEqual(event.mentions, []);
});

test("normalizeWecomMessageEvent: refuses frames that cannot be answered", () => {
  assert.equal(normalizeWecomMessageEvent(null), null);
  assert.equal(normalizeWecomMessageEvent({}), null);
  assert.equal(normalizeWecomMessageEvent({ cmd: "aibot_ping", body: {} }), null);
  assert.equal(normalizeWecomMessageEvent({ cmd: "aibot_msg_callback" }), null);
  // A group message without chatid has nowhere to reply.
  assert.equal(normalizeWecomMessageEvent(groupFrame({ chatid: "" })), null);
  // Unknown chattype is refused rather than guessed.
  assert.equal(normalizeWecomMessageEvent(singleFrame({ chattype: "channel" })), null);
  // A single chat without a sender has no conversation key.
  assert.equal(normalizeWecomMessageEvent(singleFrame({ from: {} })), null);
});

test("normalizeWecomMessageEvent: application-sourced messages are marked, not trusted", () => {
  const event = normalizeWecomMessageEvent(singleFrame({ compat_info: { source: "ai_assistant" } }));
  assert.equal(event.senderType, "application");
});

test("normalizeWecomMessageEvent: a missing msgid yields no dedupe key", () => {
  const event = normalizeWecomMessageEvent(singleFrame({ msgid: undefined }));
  assert.equal(event.dedupeKey, null);
  assert.equal(event.messageId, "user-a");
});

test("stripBotMention: only an exact leading mention is recognised", () => {
  assert.deepEqual(stripBotMention("@MiraBot hi", "MiraBot"), { mentioned: true, text: "hi" });
  assert.deepEqual(stripBotMention("  @MiraBot   hi  ", "MiraBot"), { mentioned: true, text: "hi" });
  assert.deepEqual(stripBotMention("@MiraBot2 hi", "MiraBot"), { mentioned: false, text: "@MiraBot2 hi" });
  assert.deepEqual(stripBotMention("hi @MiraBot", "MiraBot"), { mentioned: false, text: "hi @MiraBot" });
  assert.deepEqual(stripBotMention("@OtherBot hi", "MiraBot"), { mentioned: false, text: "@OtherBot hi" });
  assert.deepEqual(stripBotMention("@MiraBot", "MiraBot"), { mentioned: true, text: "" });
  // Without a configured name there is nothing to compare against: not mentioned.
  assert.deepEqual(stripBotMention("@MiraBot hi", undefined), { mentioned: false, text: "@MiraBot hi" });
});

test("decideWecomRoute: single chat is accepted, non-text and app sources are refused", () => {
  const single = normalizeWecomMessageEvent(singleFrame());
  assert.equal(decideWecomRoute(single, {}).allowed, true);
  assert.equal(decideWecomRoute(single, {}).text, "hello");

  const image = normalizeWecomMessageEvent(singleFrame({ msgtype: "image" }));
  assert.deepEqual(
    { allowed: decideWecomRoute(image, {}).allowed, reason: decideWecomRoute(image, {}).reason },
    { allowed: false, reason: WECOM_IGNORE_REASON.UNSUPPORTED_MESSAGE_TYPE },
  );

  const app = normalizeWecomMessageEvent(singleFrame({ compat_info: { source: "channel" } }));
  assert.equal(decideWecomRoute(app, {}).reason, WECOM_IGNORE_REASON.NON_USER_SOURCE);

  const empty = normalizeWecomMessageEvent(singleFrame({ text: { content: "   " } }));
  assert.equal(decideWecomRoute(empty, {}).reason, WECOM_IGNORE_REASON.EMPTY_TEXT);
});

test("decideWecomRoute: single-chat allowlist fails closed", () => {
  const single = normalizeWecomMessageEvent(singleFrame());
  assert.equal(decideWecomRoute(single, { allowedUserIds: ["user-z"] }).reason, WECOM_IGNORE_REASON.USER_NOT_ALLOWED);
  assert.equal(decideWecomRoute(single, { allowedUserIds: ["user-a"] }).allowed, true);
});

test("decideWecomRoute: group messages need a provable mention and strip it", () => {
  const group = normalizeWecomMessageEvent(groupFrame());
  assert.equal(decideWecomRoute(group, { botName: "MiraBot" }).allowed, true);
  assert.equal(decideWecomRoute(group, { botName: "MiraBot" }).text, "请总结今天的新闻");

  // No configured bot name: the mention cannot be proven.
  assert.equal(decideWecomRoute(group, {}).reason, WECOM_IGNORE_REASON.BOT_NAME_UNCONFIGURED);

  // Not mentioned at all.
  const plain = normalizeWecomMessageEvent(groupFrame({ text: { content: "今天天气不错" } }));
  assert.equal(decideWecomRoute(plain, { botName: "MiraBot" }).reason, WECOM_IGNORE_REASON.MENTION_REQUIRED);

  // Mentioned another bot.
  const other = normalizeWecomMessageEvent(groupFrame({ text: { content: "@OtherBot hi" } }));
  assert.equal(decideWecomRoute(other, { botName: "MiraBot" }).reason, WECOM_IGNORE_REASON.MENTION_REQUIRED);

  // Mentioned with nothing left to answer.
  const bare = normalizeWecomMessageEvent(groupFrame({ text: { content: "@MiraBot" } }));
  assert.equal(decideWecomRoute(bare, { botName: "MiraBot" }).reason, WECOM_IGNORE_REASON.EMPTY_TEXT);
});

test("decideWecomRoute: group allowlist fails closed", () => {
  const group = normalizeWecomMessageEvent(groupFrame());
  assert.equal(
    decideWecomRoute(group, { botName: "MiraBot", allowedChatIds: ["chat-other"] }).reason,
    WECOM_IGNORE_REASON.CHAT_NOT_ALLOWED,
  );
  assert.equal(decideWecomRoute(group, { botName: "MiraBot", allowedChatIds: ["chat-x"] }).allowed, true);
});

test("dedupe store: reserves once, expires by ttl, and stays bounded", () => {
  let clock = 1_000;
  const store = createWecomDedupeStore({ ttlMs: 100, maxEntries: 2, now: () => clock });

  assert.equal(store.reserve("wecom:msg:a"), "wecom:msg:a");
  assert.equal(store.reserve("wecom:msg:a"), null);
  assert.equal(store.has("wecom:msg:a"), true);
  assert.equal(store.reserve(""), null);
  assert.equal(store.size, 1);

  clock += 101;
  assert.equal(store.has("wecom:msg:a"), false);
  assert.equal(store.reserve("wecom:msg:a"), "wecom:msg:a");

  clock += 1;
  store.reserve("wecom:msg:b");
  store.reserve("wecom:msg:c");
  assert.ok(store.size <= 2, `size ${store.size} must stay bounded`);
  // The oldest entry is evicted first.
  assert.equal(store.has("wecom:msg:a"), false);
  assert.equal(store.has("wecom:msg:c"), true);
});
