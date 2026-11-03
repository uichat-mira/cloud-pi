import assert from "node:assert/strict";
import test from "node:test";
import { createWecomChannel } from "../src/channels/wecom/channel.mjs";
import { createWecomDedupeStore } from "../src/channels/wecom/dedupe.mjs";
import { createKnownSessionStore } from "../src/channels/wecom/sessions.mjs";
import { byteLength, splitForSend } from "../src/channels/wecom/text.mjs";

const BOT_NAME = "MiraBot";

function singleFrame(overrides = {}) {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: `req-${overrides.reqId ?? "1"}` },
    body: {
      msgid: "msg-1",
      msgtype: "text",
      chattype: "single",
      from: { userid: "user-a" },
      text: { content: "hello" },
      ...overrides.body,
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildChannel(overrides = {}) {
  const sent = [];
  const replies = [];
  const outcomes = [];
  const channel = createWecomChannel({
    runTurn: async () => ({ status: "succeeded", text: "ok" }),
    reply: async (frame, text) => {
      sent.push(text);
      replies.push({ reqId: frame?.headers?.req_id, text });
      return { replyId: `reply-${sent.length}` };
    },
    policy: { botName: BOT_NAME },
    dedupe: createWecomDedupeStore(),
    onOutcome: (outcome) => outcomes.push(outcome),
    ...overrides,
  });
  return { channel, sent, replies, outcomes };
}

test("channel: the outcome carries token usage and the platform acknowledgement, nothing else", async () => {
  const { channel, outcomes } = buildChannel({
    runTurn: async () => ({
      status: "succeeded",
      text: "答",
      runId: "run-usage-1",
      usage: { input: 12, output: 34, cacheRead: 0, cacheWrite: 0, total: 46, cost: 0.0001 },
    }),
    reply: async () => ({ replyId: "reply-1", errcode: 0 }),
  });

  channel.handleEvent(singleFrame());
  await channel.whenIdle();

  const outcome = outcomes.find((entry) => entry.action === "replied");
  assert.ok(outcome);
  assert.deepEqual({ ...outcome.usage }, { input: 12, output: 34, total: 46 });
  assert.equal(outcome.platformErrcode, 0);
  // No prompt, text or credential material leaks into the outcome projection.
  assert.deepEqual(Object.keys(outcome.usage).sort(), ["input", "output", "total"]);
});

test("channel: one accepted message runs the model exactly once and replies in place", async () => {
  const calls = [];
  const { channel, sent, replies, outcomes } = buildChannel({
    runTurn: async (input) => {
      calls.push(input);
      return { status: "succeeded", text: "你好，我是 Mira。" };
    },
  });

  const decision = channel.handleEvent({ frame: singleFrame() });
  assert.equal(decision.action, "accepted");
  assert.equal(decision.kind, "chat");

  await channel.whenIdle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "hello");
  assert.equal(calls[0].chatId, "user-a");
  assert.equal(sent.length, 1);
  assert.equal(sent[0], "你好，我是 Mira。");
  assert.equal(replies[0].reqId, "req-1");
  assert.equal(outcomes.filter((outcome) => outcome.action === "replied").length, 1);

  await channel.dispose();
});

test("channel: a re-delivered callback is ignored before any model work", async () => {
  const calls = [];
  const { channel, outcomes } = buildChannel({
    runTurn: async () => {
      calls.push(1);
      return { status: "succeeded", text: "ok" };
    },
  });

  assert.equal(channel.handleEvent({ frame: singleFrame() }).action, "accepted");
  assert.equal(channel.handleEvent({ frame: singleFrame() }).reason, "duplicate_event");
  await channel.whenIdle();
  assert.equal(calls.length, 1);
  assert.ok(outcomes.some((outcome) => outcome.reason === "duplicate_event"));

  await channel.dispose();
});

test("channel: policy rejections never reach the model and are reported", async () => {
  const calls = [];
  const { channel, outcomes } = buildChannel({
    runTurn: async () => {
      calls.push(1);
      return { status: "succeeded", text: "ok" };
    },
  });

  const groupWithoutMention = {
    cmd: "aibot_msg_callback",
    headers: { req_id: "req-9" },
    body: { msgid: "msg-9", msgtype: "text", chattype: "group", chatid: "chat-a", from: { userid: "u" }, text: { content: "hi" } },
  };
  const decision = channel.handleEvent({ frame: groupWithoutMention });
  assert.equal(decision.action, "ignored");
  assert.equal(decision.reason, "mention_required");

  const invalid = channel.handleEvent({ frame: { cmd: "aibot_msg_callback" } });
  assert.equal(invalid.reason, "invalid_event");

  await channel.whenIdle();
  assert.equal(calls.length, 0);
  assert.ok(outcomes.some((outcome) => outcome.reason === "mention_required"));

  await channel.dispose();
});

test("channel: group @ mention is stripped before the prompt", async () => {
  const calls = [];
  const { channel } = buildChannel({
    runTurn: async (input) => {
      calls.push(input.text);
      return { status: "succeeded", text: "收到" };
    },
  });

  const frame = {
    cmd: "aibot_msg_callback",
    headers: { req_id: "req-g" },
    body: {
      msgid: "msg-g",
      msgtype: "text",
      chattype: "group",
      chatid: "chat-g",
      from: { userid: "u" },
      text: { content: "@MiraBot 总结一下今天的新闻" },
    },
  };
  assert.equal(channel.handleEvent({ frame }).action, "accepted");
  await channel.whenIdle();
  assert.deepEqual(calls, ["总结一下今天的新闻"]);

  await channel.dispose();
});

test("channel: /stop cancels the active run and suppresses its reply", async () => {
  const pending = deferred();
  const sent = [];
  const outcomes = [];
  const channel = createWecomChannel({
    runTurn: async ({ signal }) => {
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
        pending.promise.then(resolve);
      });
      return signal.aborted ? { status: "cancelled", text: "" } : { status: "succeeded", text: "late" };
    },
    reply: async (frame, text) => {
      sent.push(text);
      return { replyId: `r-${sent.length}` };
    },
    policy: { botName: BOT_NAME },
    onOutcome: (outcome) => outcomes.push(outcome),
  });

  channel.handleEvent({ frame: singleFrame() });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const stopDecision = channel.handleEvent({
    frame: singleFrame({ reqId: "2", body: { msgid: "msg-stop", text: { content: "/stop" } } }),
  });
  assert.equal(stopDecision.action, "stopped");

  await channel.whenIdle();
  pending.resolve();

  assert.ok(sent.some((text) => text === "已停止当前任务。"));
  assert.ok(!sent.includes("late"), "an aborted run must not send its answer");
  assert.ok(outcomes.some((outcome) => outcome.action === "cancelled"));

  await channel.dispose();
});

test("channel: /stop with nothing running answers without inventing a run", async () => {
  const { channel, sent } = buildChannel();
  const decision = channel.handleEvent({
    frame: singleFrame({ reqId: "3", body: { msgid: "msg-stop-2", text: { content: "/stop" } } }),
  });
  assert.equal(decision.action, "stop_noop");
  await channel.whenIdle();
  assert.deepEqual(sent, ["当前没有正在执行的任务。"]);
  await channel.dispose();
});

test("channel: queued work is dropped when /stop arrives", async () => {
  const calls = [];
  let releaseFirst;
  const first = deferred();
  const { channel } = buildChannel({
    runTurn: async (input) => {
      calls.push(input.text);
      if (input.text === "first") {
        releaseFirst = () => first.resolve();
        await first.promise;
      }
      return { status: "succeeded", text: "ok" };
    },
  });

  channel.handleEvent({ frame: singleFrame({ body: { msgid: "m1", text: { content: "first" } } }) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  channel.handleEvent({ frame: singleFrame({ body: { msgid: "m2", text: { content: "second" } } }) });
  assert.equal(channel.pendingCount, 2);

  channel.handleEvent({ frame: singleFrame({ reqId: "s", body: { msgid: "m3", text: { content: "/stop" } } }) });
  releaseFirst();
  await channel.whenIdle();

  assert.deepEqual(calls, ["first"]);
  await channel.dispose();
});

test("channel: per-conversation work is serialized", async () => {
  let active = 0;
  let maxActive = 0;
  const { channel } = buildChannel({
    runTurn: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: "succeeded", text: "ok" };
    },
  });

  channel.handleEvent({ frame: singleFrame({ body: { msgid: "a1" } }) });
  channel.handleEvent({ frame: singleFrame({ body: { msgid: "a2" } }) });
  channel.handleEvent({ frame: singleFrame({ body: { msgid: "a3" } }) });
  await channel.whenIdle();
  assert.equal(maxActive, 1);

  await channel.dispose();
});

test("channel: a failed run replies with a generic message and does not crash", async () => {
  const { channel, sent, outcomes } = buildChannel({
    runTurn: async () => {
      throw new Error("provider exploded with a secret token abc-123");
    },
  });

  channel.handleEvent({ frame: singleFrame() });
  await channel.whenIdle();

  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes("abc-123"), "internal error detail must not reach the chat");
  assert.ok(outcomes.some((outcome) => outcome.action === "failed"));

  // The channel keeps serving after a failure.
  channel.handleEvent({ frame: singleFrame({ body: { msgid: "msg-2" } }) });
  await channel.whenIdle();
  assert.equal(sent.length, 2);

  await channel.dispose();
});

test("channel: a failed reply is reported without throwing", async () => {
  const { channel, outcomes } = buildChannel({
    reply: async () => {
      throw new Error("transport down");
    },
  });
  channel.handleEvent({ frame: singleFrame() });
  await channel.whenIdle();
  const replied = outcomes.find((outcome) => outcome.action === "replied");
  assert.equal(replied.replyDelivered, false);
  await channel.dispose();
});

test("channel: long answers are split by UTF-8 bytes with continuation markers", async () => {
  const long = "长报告。".repeat(2_000); // 8000 chars ≈ 24 KB of CJK
  const { channel, sent } = buildChannel({
    runTurn: async () => ({ status: "succeeded", text: long }),
    segment: { maxBytes: 4_000 },
  });

  channel.handleEvent({ frame: singleFrame() });
  await channel.whenIdle();

  assert.ok(sent.length > 1, `expected several segments, got ${sent.length}`);
  for (const part of sent) {
    assert.ok(byteLength(part) <= 4_000, `segment of ${byteLength(part)} bytes exceeds the budget`);
  }
  assert.match(sent[0], /（续 1\/\d+）/);
  assert.ok(!/（续/.test(sent[sent.length - 1]), "the last segment carries no continuation marker");

  await channel.dispose();
});

test("channel: research command is refused when no research runner is wired", async () => {
  const { channel, sent } = buildChannel();
  channel.handleEvent({ frame: singleFrame({ body: { msgid: "r1", text: { content: "/research 今天的企业微信新闻" } } }) });
  await channel.whenIdle();
  assert.deepEqual(sent, ["研究功能未启用。"]);
  await channel.dispose();
});

test("channel: research topic is passed to an injected research runner", async () => {
  const topics = [];
  const { channel } = buildChannel({
    runResearch: async ({ topic }) => {
      topics.push(topic);
      return { status: "succeeded", text: "研究报告" };
    },
  });
  channel.handleEvent({ frame: singleFrame({ body: { msgid: "r2", text: { content: "/research 企业微信 长连接" } } }) });
  await channel.whenIdle();
  assert.deepEqual(topics, ["企业微信 长连接"]);
  await channel.dispose();
});

test("channel: a research reply carries its runId and the log line stays redacted", async () => {
  const logs = [];
  const { channel, sent } = buildChannel({
    log: (entry) => logs.push(entry),
    runResearch: async () => ({ status: "succeeded", text: "研究报告正文", runId: "run-abc-123" }),
  });

  channel.handleEvent({ frame: singleFrame({ body: { msgid: "r3", text: { content: "/research 长连接" } } }) });
  await channel.whenIdle();

  assert.match(sent[0], /runId: run-abc-123/);
  const replied = logs.find((entry) => entry.event === "wecom_channel_outcome" && entry.action === "replied");
  assert.equal(replied.channel, "wecom");
  assert.equal(replied.runId, "run-abc-123");
  // Raw platform identifiers never reach the log line.
  assert.ok(!JSON.stringify(logs).includes("user-a"));
  assert.ok(!JSON.stringify(logs).includes("msg-1"));

  await channel.dispose();
});

test("channel: nothing is accepted after shutdown starts", async () => {
  const { channel, outcomes } = buildChannel();
  await channel.stopAll();
  const decision = channel.handleEvent({ frame: singleFrame() });
  assert.equal(decision.action, "ignored");
  assert.equal(decision.reason, "channel_closing");
  assert.ok(outcomes.some((outcome) => outcome.reason === "channel_closing"));
});

test("text: splitForSend never breaks a codepoint and always respects the budget", () => {
  const text = "🙂中文".repeat(1_000); // mixed 4-byte and 3-byte codepoints
  const { segments, truncated } = splitForSend(text, { maxBytes: 1_000, maxSegments: 64 });
  assert.equal(truncated, false);
  assert.ok(segments.length > 1);
  const joined = segments.join("").replace(/\n\n（续 \d+\/\d+）/g, "");
  assert.equal(joined, text, "no content is lost or corrupted by segmentation");
  for (const segment of segments) assert.ok(byteLength(segment) <= 1_000);
});

test("text: short text stays one segment and empty text yields none", () => {
  assert.deepEqual(splitForSend("hello", { maxBytes: 1_000 }), { segments: ["hello"], truncated: false, omittedBytes: 0 });
  assert.deepEqual(splitForSend("", { maxBytes: 1_000 }), { segments: [], truncated: false, omittedBytes: 0 });
});

test("text: oversized reports are capped with an explicit truncation notice", () => {
  const text = "a".repeat(50_000);
  const { segments, truncated, omittedBytes } = splitForSend(text, { maxBytes: 10_000, maxSegments: 2 });
  assert.equal(truncated, true);
  assert.equal(segments.length, 2);
  assert.ok(omittedBytes > 0);
  assert.match(segments[1], /已省略/);
  for (const segment of segments) assert.ok(byteLength(segment) <= 10_000);
});

test("sessions: only a conversation that produced inbound traffic is a push target", () => {
  let clock = 10;
  const sessions = createKnownSessionStore({ ttlMs: 100, maxEntries: 2, now: () => clock });
  assert.equal(sessions.assertDeliverable({ chatId: "user-a" }).reason, "no_prior_inbound");

  sessions.record({ chatId: "user-a", chatType: "single" });
  assert.equal(sessions.assertDeliverable({ chatId: "user-a", chatType: "single" }).deliverable, true);
  assert.equal(sessions.assertDeliverable({ chatId: "user-a", chatType: "group" }).reason, "chat_type_mismatch");

  clock += 101;
  assert.equal(sessions.assertDeliverable({ chatId: "user-a" }).reason, "no_prior_inbound");

  sessions.record({ chatId: "c1", chatType: "group" });
  sessions.record({ chatId: "c2", chatType: "group" });
  sessions.record({ chatId: "c3", chatType: "group" });
  assert.equal(sessions.size, 2);
  assert.equal(sessions.get("c1"), undefined);
});
