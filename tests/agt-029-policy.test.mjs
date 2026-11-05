/**
 * AGT-029 T1: Open Feishu chat. Explicit verified group mentions are still
 * mandatory; platform controls user and group access, not local chat lists.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decideFeishuRoute } from "../src/channels/feishu/policy.mjs";

const botMention = (openId = "ou_bot_0001") => ({ openId });
const POLICY = Object.freeze({ botOpenId: "ou_bot_0001" });

describe("AGT-029 T1: Feishu routing policy", () => {
  test("private chat is allowed without bot identity", () => {
    assert.deepEqual(
      decideFeishuRoute({ chatType: "p2p", chatId: "oc_private", mentions: [] }, {}),
      { allowed: true, kind: "p2p", reason: "private_chat" },
    );
  });

  test("any group with a verified bot mention can talk", () => {
    for (const chatId of ["oc_known", "oc_new"]) {
      assert.deepEqual(
        decideFeishuRoute({ chatType: "group", chatId, mentions: [botMention()] }, POLICY),
        { allowed: true, kind: "group", reason: "group_mention" },
      );
    }
  });

  test("legacy allowlist passed by callers never restricts group chat", () => {
    assert.deepEqual(
      decideFeishuRoute(
        { chatType: "group", chatId: "oc_any", mentions: [botMention()] },
        { ...POLICY, allowedChatIds: ["oc_other"] },
      ),
      { allowed: true, kind: "group", reason: "group_mention" },
    );
  });

  test("group without an explicit bot mention is ignored", () => {
    assert.deepEqual(
      decideFeishuRoute({ chatType: "group", chatId: "oc_any", mentions: [] }, POLICY),
      { allowed: false, kind: "group", reason: "group_without_mention" },
    );
  });

  test("mentioning another bot does not trigger this bot", () => {
    assert.deepEqual(
      decideFeishuRoute({ chatType: "group", chatId: "oc_any", mentions: [botMention("ou_other")] }, POLICY),
      { allowed: false, kind: "group", reason: "group_without_mention" },
    );
  });

  test("unknown bot identity fails closed in a group", () => {
    assert.deepEqual(
      decideFeishuRoute({ chatType: "group", chatId: "oc_any", mentions: [botMention()] }, {}),
      { allowed: false, kind: "group", reason: "bot_identity_unknown" },
    );
  });

  test("missing chat id and unknown chat type fail closed", () => {
    assert.deepEqual(
      decideFeishuRoute({ chatType: "group", chatId: "", mentions: [botMention()] }, POLICY),
      { allowed: false, kind: "group", reason: "missing_chat_id" },
    );
    assert.deepEqual(
      decideFeishuRoute({ chatType: "topic", chatId: "oc_any", mentions: [botMention()] }, POLICY),
      { allowed: false, kind: "unsupported", reason: "unsupported_chat_type" },
    );
  });
});
