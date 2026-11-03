/**
 * AGT-029 T1: Feishu routing policy.
 *
 * These are the authorization boundaries: only private chat and an explicitly
 * mentioned bot in a locally authorized group may reach the Agent. Everything
 * else fails closed, including an unverifiable bot identity.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decideFeishuRoute } from "../src/channels/feishu/policy.mjs";
const botMention = ({ openId = "ou_bot_0001" } = {}) => ({ openId });

const POLICY = Object.freeze({
  allowedChatIds: ["oc_allowed_group"],
  botOpenId: "ou_bot_0001",
});

describe("AGT-029 T1: Feishu routing policy", () => {
  test("private chat is allowed", () => {
    const route = decideFeishuRoute(
      { chatType: "p2p", chatId: "oc_private", mentions: [] },
      { allowedChatIds: [], botOpenId: undefined },
    );
    assert.deepEqual(route, { allowed: true, kind: "p2p", reason: "private_chat" });
  });

  test("an authorized group with an explicit bot mention is allowed", () => {
    const route = decideFeishuRoute(
      { chatType: "group", chatId: "oc_allowed_group", mentions: [botMention()] },
      POLICY,
    );
    assert.deepEqual(route, { allowed: true, kind: "group", reason: "group_mention" });
  });

  test("an authorized group without a mention is ignored", () => {
    const route = decideFeishuRoute(
      { chatType: "group", chatId: "oc_allowed_group", mentions: [] },
      POLICY,
    );
    assert.deepEqual(route, { allowed: false, kind: "group", reason: "group_without_mention" });
  });

  test("a mention of another bot is not the bot mention", () => {
    const route = decideFeishuRoute(
      {
        chatType: "group",
        chatId: "oc_allowed_group",
        mentions: [botMention({ openId: "ou_other_bot" })],
      },
      POLICY,
    );
    assert.equal(route.allowed, false);
    assert.equal(route.reason, "group_without_mention");
  });

  test("an unauthorized group is ignored even with a bot mention", () => {
    const route = decideFeishuRoute(
      { chatType: "group", chatId: "oc_other_group", mentions: [botMention()] },
      POLICY,
    );
    assert.deepEqual(route, { allowed: false, kind: "group", reason: "unauthorized_group" });
  });

  test("a group is ignored when the bot identity cannot be verified", () => {
    const route = decideFeishuRoute(
      { chatType: "group", chatId: "oc_allowed_group", mentions: [botMention()] },
      { allowedChatIds: ["oc_allowed_group"], botOpenId: undefined },
    );
    assert.deepEqual(route, { allowed: false, kind: "group", reason: "bot_identity_unknown" });
  });

  test("unknown chat types fail closed", () => {
    const route = decideFeishuRoute(
      { chatType: "topic", chatId: "oc_allowed_group", mentions: [botMention()] },
      POLICY,
    );
    assert.deepEqual(route, { allowed: false, kind: "unsupported", reason: "unsupported_chat_type" });
  });
});
