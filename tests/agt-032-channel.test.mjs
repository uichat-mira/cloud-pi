/**
 * AGT-032 T1/T2: Feishu `/research` command contract and channel behaviour.
 *
 * No network, no model: `runTurn`, `runResearch` and `reply` are injected, so
 * "did a research run happen?" is directly observable. The real executor path
 * is proven separately in agt-032-live-path.test.mjs.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_REPLIES,
  MAX_RESEARCH_REPLY_CHARS,
  RESEARCH_REPLIES,
  buildResearchReply,
  createFeishuChannel,
  mapResearchStatus,
  parseResearchCommand,
} from "../src/channels/feishu/channel.mjs";
import { loadFeishuResearchConfig } from "../src/channels/feishu/config.mjs";
import { botMention, textEvent } from "./helpers/feishu-events.mjs";
import { LONG_REPORT_TEXT, REPORT_TEXT } from "./agt-032-fixtures.mjs";

const BOT_OPEN_ID = "ou_bot_0001";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness({ runTurn, runResearch, reply, botOpenId = BOT_OPEN_ID } = {}) {
  const outcomes = [];
  const replies = [];
  const channel = createFeishuChannel({
    botOpenId,
    runTurn:
      runTurn ??
      (async () => {
        assert.fail("chat runtime must not be called by a research test");
      }),
    runResearch,
    reply:
      reply ??
      (async (messageId, text) => {
        replies.push({ messageId, text });
        return { messageId: `om_reply_${replies.length}` };
      }),
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  return { channel, outcomes, replies };
}

function groupEvent({ text, chatId = "oc_group", mentions = [botMention({ openId: BOT_OPEN_ID })] } = {}) {
  return textEvent({
    eventId: `evt_${chatId}_${text}`,
    messageId: `om_${chatId}`,
    chatId,
    chatType: "group",
    text,
    mentions,
  });
}

describe("AGT-032 T1: /research command parsing", () => {
  test("accepts explicit English and Chinese commands", () => {
    assert.deepEqual(parseResearchCommand("/research AI Agent 工程进展"), {
      isCommand: true,
      command: "/research",
      topic: "AI Agent 工程进展",
    });
    assert.deepEqual(parseResearchCommand("/研究 最近 48 小时 AI 进展"), {
      isCommand: true,
      command: "/研究",
      topic: "最近 48 小时 AI 进展",
    });
    assert.equal(parseResearchCommand("/RESEARCH\tagent news").topic, "agent news");
    assert.equal(parseResearchCommand("　/research　主题").topic, "主题");
    assert.deepEqual(parseResearchCommand("/research"), { isCommand: true, command: "/research", topic: "" });
    assert.deepEqual(parseResearchCommand("/research    "), { isCommand: true, command: "/research", topic: "" });
  });

  test("ordinary text is never misread as a research command", () => {
    for (const text of [
      "research AI agents",
      "please /research AI agents",
      "/researchfoo",
      "/研究主题",
      "/stop",
      "/cancel",
      "我们可以 /research 一下吗",
      "   ",
    ]) {
      const parsed = parseResearchCommand(text);
      assert.equal(parsed.isCommand, false, `must not be a command: ${JSON.stringify(text)}`);
    }
    assert.equal(parseResearchCommand(null).isCommand, false);
  });

  test("status mapping is total and fails closed", () => {
    assert.equal(mapResearchStatus("completed"), "succeeded");
    assert.equal(mapResearchStatus("completed_with_errors"), "partial");
    assert.equal(mapResearchStatus("failed"), "failed");
    assert.equal(mapResearchStatus("cancelled"), "cancelled");
    assert.equal(mapResearchStatus("timeout"), "timeout");
    assert.equal(mapResearchStatus("succeeded"), "failed");
    assert.equal(mapResearchStatus(undefined), "failed");
  });

  test("research concurrency config is bounded and validated", () => {
    assert.deepEqual(loadFeishuResearchConfig({}), { maxConcurrent: 1 });
    assert.deepEqual(loadFeishuResearchConfig({ FEISHU_RESEARCH_MAX_CONCURRENT: "3" }), { maxConcurrent: 3 });
    assert.deepEqual(loadFeishuResearchConfig({ FEISHU_RESEARCH_MAX_CONCURRENT: "99" }), { maxConcurrent: 4 });
    assert.throws(() => loadFeishuResearchConfig({ FEISHU_RESEARCH_MAX_CONCURRENT: "0" }));
    assert.throws(() => loadFeishuResearchConfig({ FEISHU_RESEARCH_MAX_CONCURRENT: "two" }));
  });
});

describe("AGT-032 T1/T2: reply mapping", () => {
  const cases = [
    {
      status: "completed",
      record: { status: "completed", runId: "r-20260101T000000-abcdef", report: REPORT_TEXT },
      prefix: "研究完成",
      kind: "succeeded",
    },
    {
      status: "completed_with_errors",
      record: { status: "completed_with_errors", runId: "r-20260101T000001-abcdef", report: REPORT_TEXT },
      prefix: "研究部分完成",
      kind: "partial",
    },
    {
      status: "failed",
      record: { status: "failed", runId: "r-20260101T000002-abcdef", error: { code: "model_error" } },
      prefix: "研究失败",
      kind: "failed",
    },
    {
      status: "cancelled",
      record: { status: "cancelled", runId: "r-20260101T000003-abcdef", error: { code: "aborted" } },
      prefix: "研究已取消",
      kind: "cancelled",
    },
    {
      status: "timeout",
      record: { status: "timeout", runId: "r-20260101T000004-abcdef", error: { code: "timeout" } },
      prefix: "研究超时",
      kind: "timeout",
    },
  ];

  test("every terminal status has a distinct, non-success message", () => {
    const texts = new Set();
    for (const entry of cases) {
      const text = buildResearchReply(entry.record);
      assert.ok(text.startsWith(entry.prefix), `${entry.status} reply: ${text.slice(0, 40)}`);
      assert.ok(text.includes(entry.record.runId), "the run id must be in the reply");
      assert.equal(mapResearchStatus(entry.record.status), entry.kind);
      texts.add(text);
    }
    assert.equal(texts.size, cases.length, "terminal statuses must not share a reply text");

    const partial = buildResearchReply(cases[1].record);
    assert.equal(partial.startsWith("研究完成"), false, "partial must never present as full success");
    assert.match(partial, /部分完成/);
    assert.equal(buildResearchReply(cases[2].record).includes("model_error"), true);
    assert.equal(buildResearchReply(cases[2].record).includes("stack"), false);
  });

  test("a failed reply never leaks a stack or credentials", () => {
    const text = buildResearchReply({
      status: "failed",
      runId: "r-20260101T000005-abcdef",
      error: { code: "model_error", message: "Bearer fake-credential at /srv/app/execute.mjs:42" },
    });
    assert.equal(text.includes("fake-credential"), false);
    assert.equal(text.includes("/srv/app"), false);
    assert.equal(text.includes("at Object."), false);
  });

  test("long reports are truncated instead of failing the run", () => {
    const record = { status: "completed", runId: "r-20260101T000006-abcdef", report: LONG_REPORT_TEXT };
    const text = buildResearchReply(record);
    assert.ok(Array.from(text).length <= MAX_RESEARCH_REPLY_CHARS);
    assert.ok(text.includes(record.runId));
    assert.ok(text.includes("报告已截断"));
    assert.equal(record.status, "completed", "truncation must not rewrite the run status");

    const tiny = buildResearchReply(record, { maxChars: 240 });
    assert.ok(Array.from(tiny).length <= 240);
    assert.ok(tiny.includes(record.runId), "run id must survive even the smallest bound");
  });

  test("a missing report is reported without changing the terminal status", () => {
    const text = buildResearchReply({ status: "completed", runId: "r-1", report: null, reportUnavailable: true });
    assert.match(text, /报告读取失败/);
    const empty = buildResearchReply({ status: "completed", runId: "r-2", report: "   " });
    assert.match(empty, /没有可读报告/);
  });
});

describe("AGT-032 T1/T2: channel routing for /research", () => {
  test("a valid research command starts exactly one research run and replies to the original message", async () => {
    const calls = [];
    const { channel, replies, outcomes } = harness({
      runResearch: async (input) => {
        calls.push(input);
        return { status: "completed", runId: "r-20260101T000000-abcdef", report: REPORT_TEXT, durationMs: 12 };
      },
    });

    const accepted = channel.handleEvent(textEvent({ text: "/research AI Agent 工程进展" }));
    assert.equal(accepted.action, "accepted");
    assert.equal(accepted.kind, "research");
    assert.equal(accepted.topicProvided, true);
    await channel.whenIdle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].topic, "AI Agent 工程进展");
    assert.equal(calls[0].signal.aborted, false);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].messageId, "om_0000000000000001");
    assert.match(replies[0].text, /研究完成/);
    assert.match(replies[0].text, /r-20260101T000000-abcdef/);

    const outcome = outcomes.find((entry) => entry.action === "replied" && entry.kind === "research");
    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.researchStatus, "completed");
    assert.equal(outcome.runId, "r-20260101T000000-abcdef");
    assert.equal(outcome.replyDelivered, true);
  });

  test("ordinary chat text keeps going to the chat runtime only", async () => {
    const chat = [];
    const research = [];
    const { channel } = harness({
      runTurn: async ({ text }) => {
        chat.push(text);
        return { status: "succeeded", text: "pong", runId: "run-chat" };
      },
      runResearch: async (input) => {
        research.push(input);
        return { status: "completed", runId: "run-research" };
      },
    });
    channel.handleEvent(textEvent({ text: "帮我 research 一下 AI 新闻" }));
    channel.handleEvent(textEvent({ eventId: "evt_2", messageId: "om_2", text: "/researchfoo" }));
    await channel.whenIdle();
    assert.deepEqual(chat, ["帮我 research 一下 AI 新闻", "/researchfoo"]);
    assert.equal(research.length, 0);
  });

  test("an empty topic replies with usage and never starts a run", async () => {
    let calls = 0;
    const { channel, replies, outcomes } = harness({
      runResearch: async () => {
        calls += 1;
        return { status: "completed", runId: "r-should-not-run" };
      },
    });
    const accepted = channel.handleEvent(textEvent({ text: "/research   " }));
    assert.equal(accepted.action, "accepted");
    assert.equal(accepted.topicProvided, false);
    await channel.whenIdle();
    assert.equal(calls, 0);
    assert.deepEqual(replies, [{ messageId: "om_0000000000000001", text: RESEARCH_REPLIES.usage }]);
    assert.equal(outcomes.at(-1).action, "research_usage");
    assert.equal(outcomes.at(-1).reason, "missing_topic");
  });

  test("a research command without a wired runner fails closed", async () => {
    const { channel, replies, outcomes } = harness({});
    channel.handleEvent(textEvent({ text: "/research AI 新闻" }));
    await channel.whenIdle();
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /研究失败/);
    assert.match(replies[0].text, /research_unavailable/);
    assert.equal(outcomes.at(-1).action, "failed");
    assert.equal(outcomes.at(-1).errorCode, "research_unavailable");
  });
});

describe("AGT-032 T1/T2: group mention and sender rules", () => {
  test("any group with @bot can trigger public research", async () => {
    const topics = [];
    const { channel } = harness({
      runResearch: async ({ topic }) => {
        topics.push(topic);
        return { status: "completed", runId: "r-group-1", report: REPORT_TEXT };
      },
    });
    channel.handleEvent(groupEvent({ text: "@_user_1 /research AI 新闻" }));
    await channel.whenIdle();
    assert.deepEqual(topics, ["AI 新闻"]);
  });

  test("an unlisted group requires @bot but is not blocked from public research", async () => {
    let calls = 0;
    const { channel, outcomes } = harness({
      runResearch: async () => {
        calls += 1;
        return { status: "completed", runId: "r-open", report: REPORT_TEXT };
      },
    });
    channel.handleEvent(groupEvent({ text: "/research AI 新闻", mentions: [] }));
    await channel.whenIdle();
    assert.equal(calls, 0);
    assert.equal(outcomes.at(-1).reason, "group_without_mention");

    channel.handleEvent(groupEvent({ chatId: "oc_other", text: "@_user_1 /research AI 新闻" }));
    await channel.whenIdle();
    assert.equal(calls, 1);
    assert.ok(outcomes.some((entry) => entry.action === "accepted" && entry.reason === "group_mention"));
  });

  test("non-user senders and duplicate deliveries never start research", async () => {
    let calls = 0;
    const { channel, outcomes } = harness({
      runResearch: async () => {
        calls += 1;
        return { status: "completed", runId: "r-once", report: REPORT_TEXT };
      },
    });
    channel.handleEvent(textEvent({ eventId: "evt_app", text: "/research AI", senderType: "app" }));
    await channel.whenIdle();
    assert.equal(calls, 0);

    const event = textEvent({ eventId: "evt_dup", messageId: "om_dup", text: "/research AI" });
    channel.handleEvent(event);
    await channel.whenIdle();
    channel.handleEvent(event);
    await channel.whenIdle();
    assert.equal(calls, 1);
    assert.ok(outcomes.some((entry) => entry.reason === "duplicate_event"));
  });
});

describe("AGT-032 T2: cancellation and per-chat serialization", () => {
  test("/stop aborts the active research signal and no success reply is sent", async () => {
    let signalSeen;
    const started = deferred();
    const { channel, replies, outcomes } = harness({
      runResearch: async ({ signal }) => {
        signalSeen = signal;
        started.resolve();
        await new Promise((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", resolve, { once: true });
        });
        // Even if the executor raced to a completion, /stop must suppress it.
        return { status: "cancelled", runId: "r-stopped", error: { code: "aborted" } };
      },
    });

    channel.handleEvent(textEvent({ eventId: "evt_research", messageId: "om_research", text: "/research AI" }));
    await started.promise;
    assert.equal(signalSeen.aborted, false);

    channel.handleEvent(textEvent({ eventId: "evt_stop", messageId: "om_stop", text: "/stop" }));
    await channel.whenIdle();

    assert.equal(signalSeen.aborted, true);
    assert.deepEqual(replies, [{ messageId: "om_stop", text: CHANNEL_REPLIES.stopped }]);
    assert.equal(outcomes.some((entry) => entry.action === "replied" && entry.kind === "research"), false);
    const cancelled = outcomes.find((entry) => entry.action === "cancelled" && entry.kind === "research");
    assert.equal(cancelled.runId, "r-stopped");
  });

  test("/stop in one chat does not cancel research in another chat", async () => {
    const startedA = deferred();
    const startedB = deferred();
    const gates = new Map();
    const signals = new Map();
    const { channel, outcomes } = harness({
      runResearch: async ({ chatId, signal }) => {
        signals.set(chatId, signal);
        (chatId === "oc_a" ? startedA : startedB).resolve();
        const gate = deferred();
        gates.set(chatId, gate);
        const status = await gate.promise;
        return { status, runId: `r-${chatId}`, report: status === "completed" ? REPORT_TEXT : null };
      },
    });

    channel.handleEvent(textEvent({ eventId: "evt_a", messageId: "om_a", chatId: "oc_a", text: "/research A" }));
    channel.handleEvent(textEvent({ eventId: "evt_b", messageId: "om_b", chatId: "oc_b", text: "/research B" }));
    await Promise.all([startedA.promise, startedB.promise]);

    channel.handleEvent(textEvent({ eventId: "evt_stop_a", messageId: "om_stop_a", chatId: "oc_a", text: "/stop" }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(signals.get("oc_a").aborted, true);
    assert.equal(signals.get("oc_b").aborted, false, "another chat's research must not be aborted");

    gates.get("oc_a").resolve("cancelled");
    gates.get("oc_b").resolve("completed");
    await channel.whenIdle();

    assert.ok(outcomes.some((entry) => entry.kind === "research" && entry.chatId === "oc_b" && entry.status === "succeeded"));
    assert.equal(outcomes.some((entry) => entry.chatId === "oc_b" && entry.status === "cancelled"), false);
  });

  test("research runs for one chat are serialized", async () => {
    let active = 0;
    let maxActive = 0;
    const first = deferred();
    const starts = [];
    const { channel } = harness({
      runResearch: async ({ topic }) => {
        starts.push(topic);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (starts.length === 1) await first.promise;
        active -= 1;
        return { status: "completed", runId: `r-${starts.length}`, report: REPORT_TEXT };
      },
    });

    channel.handleEvent(textEvent({ eventId: "evt_1", messageId: "om_1", text: "/research one" }));
    channel.handleEvent(textEvent({ eventId: "evt_2", messageId: "om_2", text: "/research two" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(starts, ["one"], "the second research run must wait for the first");

    first.resolve();
    await channel.whenIdle();
    assert.deepEqual(starts, ["one", "two"]);
    assert.equal(maxActive, 1);
  });

  test("different chats may run research concurrently at the channel layer", async () => {
    const started = [];
    const gates = [];
    const { channel } = harness({
      runResearch: async ({ chatId }) => {
        started.push(chatId);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        return { status: "completed", runId: `r-${chatId}`, report: REPORT_TEXT };
      },
    });
    channel.handleEvent(textEvent({ eventId: "evt_a", messageId: "om_a", chatId: "oc_a", text: "/research A" }));
    channel.handleEvent(textEvent({ eventId: "evt_b", messageId: "om_b", chatId: "oc_b", text: "/research B" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(started.sort(), ["oc_a", "oc_b"]);
    for (const gate of gates) gate.resolve();
    await channel.whenIdle();
  });
});

describe("AGT-032 T2: reply failures never rewrite the research status", () => {
  test("a reply failure is reported but the research outcome keeps its real status", async () => {
    const record = { status: "completed", runId: "r-reply-fail", report: REPORT_TEXT };
    const { channel, outcomes } = harness({
      runResearch: async () => record,
      reply: async () => {
        throw Object.assign(new Error("feishu down"), { code: "reply_failed" });
      },
    });
    channel.handleEvent(textEvent({ text: "/research AI" }));
    await channel.whenIdle();
    const outcome = outcomes.find((entry) => entry.kind === "research" && entry.action !== "accepted");
    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.researchStatus, "completed");
    assert.equal(outcome.replyDelivered, false);
    assert.equal(record.status, "completed");
  });
});
