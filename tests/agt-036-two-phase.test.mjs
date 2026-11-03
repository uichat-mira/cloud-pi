/**
 * AGT-036 follow-up: ack → final two-phase replies.
 *
 * The contract under test:
 *  1. the callback `req_id` gets an acknowledgement immediately, before the model
 *     is consulted;
 *  2. the finished answer is pushed with `aibot_send_msg` to the *same*
 *     conversation, with an explicit `chat_type` (1 single / 2 group);
 *  3. the push target must be a conversation that produced inbound traffic —
 *     otherwise the platform's `93006` semantics are reported and nothing is sent;
 *  4. content is budgeted in UTF-8 bytes (20480), so a long answer is segmented
 *     instead of being rejected (`40058`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createWecomChannel, WECOM_REPLIES } from "../src/channels/wecom/channel.mjs";
import { WECOM_DEFAULT_ACK_TEXT, WECOM_MAX_CONTENT_BYTES } from "../src/channels/wecom/config.mjs";
import { createWecomDedupeStore } from "../src/channels/wecom/dedupe.mjs";
import { createKnownSessionStore } from "../src/channels/wecom/sessions.mjs";
import { byteLength } from "../src/channels/wecom/text.mjs";

const BOT_NAME = "Mira";

function singleFrame({ reqId = "req-1", msgId = "msg-1", text = "你好" } = {}) {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: reqId },
    body: {
      msgid: msgId,
      msgtype: "text",
      chattype: "single",
      from: { userid: "user-a" },
      text: { content: text },
    },
  };
}

function groupFrame({ reqId = "req-g1", msgId = "msg-g1", text = "@Mira 查一下进度", chatId = "chat-1" } = {}) {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: reqId },
    body: {
      msgid: msgId,
      msgtype: "text",
      chattype: "group",
      chatid: chatId,
      from: { userid: "user-a" },
      text: { content: text },
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function settle(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Mirrors the service wiring: the registry learns a conversation when the channel
 * accepts its inbound message, which is what makes the later push legal.
 */
function buildChannel({ recordSessions = true, ...overrides } = {}) {
  const replies = [];
  const pushes = [];
  const outcomes = [];
  const sessions = createKnownSessionStore();
  const channel = createWecomChannel({
    sessions,
    // These tests are about the two-phase *mechanics* (ack inside the callback,
    // answer later on the push path), so the ack merge window is off here. The
    // merge policy itself is covered in tests/agt-036-experience-copy.test.mjs.
    ack: { enabled: true, text: WECOM_DEFAULT_ACK_TEXT, mergeMs: 0 },
    runTurn: async () => ({ status: "succeeded", text: "最终答案" }),
    reply: async (frame, text) => {
      replies.push({ reqId: frame?.headers?.req_id, text });
      return { messageId: `reply-${replies.length}`, errcode: 0 };
    },
    push: async (input) => {
      pushes.push(input);
      return { errcode: 0 };
    },
    policy: { botName: BOT_NAME },
    dedupe: createWecomDedupeStore(),
    onOutcome: (outcome) => {
      outcomes.push(outcome);
      if (recordSessions && outcome?.action === "accepted" && outcome.chatId) {
        sessions.record({ chatId: outcome.chatId, chatType: outcome.chatType });
      }
    },
    ...overrides,
  });
  return { channel, sessions, replies, pushes, outcomes };
}

test("two-phase: the callback is acknowledged before the model finishes", async () => {
  const gate = deferred();
  const calls = [];
  const { channel, replies, pushes, outcomes } = buildChannel({
    runTurn: async (input) => {
      calls.push(input);
      await gate.promise;
      return { status: "succeeded", text: "最终答案" };
    },
  });

  const decision = channel.handleEvent({ frame: singleFrame() });
  assert.equal(decision.action, "accepted");
  assert.equal(decision.acked, true);

  await settle();
  // Phase 1 only: the model has not resolved yet.
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, WECOM_DEFAULT_ACK_TEXT);
  assert.equal(replies[0].reqId, "req-1");
  assert.equal(pushes.length, 0);
  assert.equal(calls.length, 1);

  gate.resolve();
  await channel.whenIdle();

  assert.equal(replies.length, 1, "one ack, never a second reply on the same req_id");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].text, "最终答案");
  assert.equal(pushes[0].chatId, "user-a");
  assert.equal(pushes[0].chatType, "single");

  const acked = outcomes.find((entry) => entry.action === "acked");
  const final = outcomes.find((entry) => entry.action === "replied");
  assert.ok(acked && final);
  assert.equal(acked.phase, "ack");
  assert.equal(typeof acked.ackMs, "number");
  assert.equal(final.phase, "final");
  assert.equal(final.delivery, "push");
  // Same callback, same request id: the two evidence lines can be joined.
  assert.equal(acked.requestId, "req-1");
  assert.equal(final.requestId, "req-1");
  assert.equal(typeof final.ackMs, "number");
  assert.equal(final.ackDelivered, true);
});

test("two-phase: a group answer is pushed with the group conversation and chat_type group", async () => {
  const { channel, replies, pushes } = buildChannel();

  channel.handleEvent({ frame: groupFrame({ text: "@Mira 查一下进度" }) });
  await channel.whenIdle();

  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, WECOM_DEFAULT_ACK_TEXT);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].chatId, "chat-1");
  assert.equal(pushes[0].chatType, "group");
});

test("two-phase: the @ prefix is stripped before the model sees the text", async () => {
  const texts = [];
  const { channel, pushes } = buildChannel({
    runTurn: async (input) => {
      texts.push(input.text);
      return { status: "succeeded", text: "ok" };
    },
  });

  channel.handleEvent({ frame: groupFrame({ text: "  @Mira   查一下进度  " }) });
  await channel.whenIdle();

  assert.deepEqual(texts, ["查一下进度"]);
  assert.equal(pushes.length, 1);
});

test("two-phase: a bare mention is answered with a hint and never reaches the model", async () => {
  const calls = [];
  const { channel, replies, pushes, outcomes } = buildChannel({
    runTurn: async (input) => {
      calls.push(input);
      return { status: "succeeded", text: "不应出现" };
    },
  });

  const decision = channel.handleEvent({ frame: groupFrame({ text: "@Mira   " }) });
  assert.equal(decision.action, "ignored");
  assert.equal(decision.reason, "empty_text");
  assert.equal(decision.replied, true);

  await channel.whenIdle();
  assert.equal(calls.length, 0, "the model is not called for an empty question");
  assert.equal(pushes.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, WECOM_REPLIES.emptyText);

  const outcome = outcomes.find((entry) => entry.phase === "hint");
  assert.ok(outcome);
  assert.equal(outcome.reason, "empty_text");
  assert.equal(outcome.replyDelivered, true);
});

test("two-phase: a longer bot name is not accepted as a mention (no fuzzy match)", async () => {
  const calls = [];
  const { channel, replies } = buildChannel({
    runTurn: async (input) => {
      calls.push(input);
      return { status: "succeeded", text: "不应出现" };
    },
  });

  const decision = channel.handleEvent({ frame: groupFrame({ text: "@MiraBot 你好" }) });
  assert.equal(decision.action, "ignored");
  assert.equal(decision.reason, "mention_required");

  await channel.whenIdle();
  assert.equal(calls.length, 0);
  assert.equal(replies.length, 0);
});

test("two-phase: a push to a conversation without prior inbound is refused with 93006 and never sent", async () => {
  const { channel, replies, pushes, outcomes } = buildChannel({ recordSessions: false });

  channel.handleEvent({ frame: singleFrame() });
  await channel.whenIdle();

  assert.equal(replies.length, 1, "the ack still answers the callback");
  assert.equal(pushes.length, 0, "nothing is sent to an unknown conversation");

  const final = outcomes.find((entry) => entry.phase === "final");
  assert.ok(final);
  assert.equal(final.action, "failed");
  assert.equal(final.reason, "no_prior_inbound");
  assert.equal(final.platformCode, 93_006);
  assert.equal(final.replyDelivered, false);
});

test("two-phase: an oversized answer is segmented under the byte limit instead of being rejected", async () => {
  const answer = "长".repeat(30_000); // 90000 UTF-8 bytes, 3x the budget
  const { channel, pushes, outcomes } = buildChannel({
    // This test is about the byte budget, not the chat segment cap (which is
    // covered in tests/agt-036-experience-copy.test.mjs), so raise the cap.
    segment: { singleMaxSegments: 8 },
    runTurn: async () => ({ status: "succeeded", text: answer }),
  });

  channel.handleEvent({ frame: singleFrame() });
  await channel.whenIdle();

  assert.ok(pushes.length > 1, "a long answer is split, not dropped");
  for (const part of pushes) {
    assert.ok(
      byteLength(part.text) <= WECOM_MAX_CONTENT_BYTES,
      `segment of ${byteLength(part.text)} bytes exceeds the platform limit`,
    );
  }
  // Every codepoint survives segmentation (no truncation at this size).
  const joined = pushes.map((part) => part.text).join("");
  assert.equal([...joined].filter((char) => char === "长").length, 30_000);

  const final = outcomes.find((entry) => entry.phase === "final");
  assert.equal(final.action, "replied");
  assert.equal(final.segments, pushes.length);
  assert.equal(final.segmentsDelivered, pushes.length);
});

test("two-phase: an oversized an emoji-only answer never splits a codepoint", async () => {
  const answer = "🙂".repeat(8_000); // 32000 bytes, 4 bytes each
  const { channel, pushes } = buildChannel({
    runTurn: async () => ({ status: "succeeded", text: answer }),
  });

  channel.handleEvent({ frame: singleFrame() });
  await channel.whenIdle();

  for (const part of pushes) {
    assert.ok(byteLength(part.text) <= WECOM_MAX_CONTENT_BYTES);
    assert.equal(part.text.includes("\uFFFD"), false, "no broken UTF-8 sequence");
  }
  assert.equal(pushes.map((part) => part.text).join("").replace(/\n\n（续 \d+\/\d+）/g, "").length, answer.length);
});

test("two-phase: the ack is configurable and can be disabled", async () => {
  const custom = buildChannel({ ack: { text: "收到啦，稍等我一下" } });
  custom.channel.handleEvent({ frame: singleFrame() });
  await custom.channel.whenIdle();
  assert.equal(custom.replies[0].text, "收到啦，稍等我一下");
  assert.equal(custom.pushes.length, 1);

  const off = buildChannel({ ack: { enabled: false } });
  const decision = off.channel.handleEvent({ frame: singleFrame() });
  assert.equal(decision.acked, false);
  await off.channel.whenIdle();
  assert.equal(off.replies.length, 0);
  assert.equal(off.pushes.length, 1);
  assert.equal(off.pushes[0].text, "最终答案");
});

test("two-phase: without a push path the answer stays a single in-callback reply", async () => {
  const sent = [];
  const channel = createWecomChannel({
    runTurn: async () => ({ status: "succeeded", text: "直接回答" }),
    reply: async (_frame, text) => {
      sent.push(text);
      return { messageId: "reply-1", errcode: 0 };
    },
    policy: { botName: BOT_NAME },
    dedupe: createWecomDedupeStore(),
  });

  const decision = channel.handleEvent({ frame: singleFrame() });
  assert.equal(decision.acked, false);
  await channel.whenIdle();
  assert.deepEqual(sent, ["直接回答"]);
});

test("two-phase: a rate-limited push is reported as a typed failure", async () => {
  const { channel, outcomes } = buildChannel({
    push: async () => {
      const error = new Error("rate limited");
      error.code = "rate_limited";
      error.retryable = true;
      throw error;
    },
  });

  channel.handleEvent({ frame: singleFrame() });
  await channel.whenIdle();

  const final = outcomes.find((entry) => entry.phase === "final");
  assert.equal(final.action, "failed");
  assert.equal(final.reason, "rate_limited");
  assert.equal(final.replyDelivered, false);
});

test("two-phase: pushing without a session registry is a construction error", () => {
  assert.throws(
    () =>
      createWecomChannel({
        runTurn: async () => ({ status: "succeeded", text: "ok" }),
        reply: async () => ({}),
        push: async () => ({}),
      }),
    /known-session store/,
  );
});

test("sessions: keys are namespaced so a userid and a chatid never collide", () => {
  const sessions = createKnownSessionStore();
  sessions.record({ chatId: "same-id", chatType: "group" });
  sessions.record({ chatId: "same-id", chatType: "single" });

  assert.equal(sessions.get("same-id", "group").key, "wecom:group:same-id");
  assert.equal(sessions.get("same-id", "single").key, "wecom:user:same-id");
  assert.equal(sessions.size, 2);
  assert.equal(sessions.assertDeliverable({ chatId: "same-id", chatType: "group" }).deliverable, true);
  assert.equal(sessions.assertDeliverable({ chatId: "other", chatType: "group" }).platformCode, 93_006);
});
