/**
 * AGT-029 T2: Channel Adapter contract.
 *
 * The adapter is tested without a network or a model: `runTurn` and `reply` are
 * injected spies, so a run happening (or not happening) is directly observable.
 * The real runtime boundary is covered separately in agt-029-runtime.test.mjs.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_REPLIES, createFeishuChannel } from "../src/channels/feishu/channel.mjs";
import { botMention, textEvent } from "./helpers/feishu-events.mjs";

const BOT_OPEN_ID = "ou_bot_0001";

function createHarness({ runTurn, reply, botOpenId = BOT_OPEN_ID } = {}) {
  const outcomes = [];
  const replies = [];
  const channel = createFeishuChannel({
    botOpenId,
    runTurn: runTurn ?? (async () => ({ status: "succeeded", text: "ok", runId: "run-default" })),
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

function groupEvent({ text = "@_user_1 hello", chatId = "oc_group", mentions = [botMention({ openId: BOT_OPEN_ID })] } = {}) {
  return textEvent({ eventId: `evt_${chatId}_${text}`, messageId: `om_${chatId}`, chatId, chatType: "group", text, mentions });
}

describe("AGT-029 T2: private chat route", () => {
  test("one message becomes one run and the answer is replied to the original message", async () => {
    const calls = [];
    const { channel, replies, outcomes } = createHarness({
      runTurn: async (input) => {
        calls.push(input);
        return {
          status: "succeeded",
          text: "pong from cloud pi",
          runId: "run-1",
          model: { modelId: "faux-model" },
          durationMs: 12,
          usage: { input: 3, output: 4, total: 7 },
        };
      },
    });

    const accepted = channel.handleEvent(textEvent({ text: "ping" }));
    assert.equal(accepted.action, "accepted");
    assert.equal(accepted.reason, "private_chat");
    assert.equal(accepted.chatType, "p2p");

    await channel.whenIdle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "ping");
    assert.equal(calls[0].signal.aborted, false);
    assert.deepEqual(replies, [{ messageId: "om_0000000000000001", text: "pong from cloud pi" }]);
    const replied = outcomes.find((outcome) => outcome.action === "replied");
    assert.equal(replied.runId, "run-1");
    assert.equal(replied.modelId, "faux-model");
    assert.equal(replied.replyDelivered, true);
  });
});

describe("AGT-029 T2: group chat and verified mentions", () => {
  test("a group with @bot runs", async () => {
    const calls = [];
    const { channel, replies } = createHarness({
      runTurn: async (input) => {
        calls.push(input);
        return { status: "succeeded", text: "group answer", runId: "run-group" };
      },
    });
    channel.handleEvent(groupEvent({ text: "@_user_1 你好" }));
    await channel.whenIdle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "你好");
    assert.equal(replies.length, 1);
  });

  test("a group without @bot never calls the runtime", async () => {
    let calls = 0;
    const { channel, replies, outcomes } = createHarness({
      runTurn: async () => {
        calls += 1;
        return { status: "succeeded", text: "should not run", runId: "run-no" };
      },
    });
    channel.handleEvent(groupEvent({ text: "just chatting", mentions: [] }));
    await channel.whenIdle();
    assert.equal(calls, 0);
    assert.equal(replies.length, 0);
    assert.equal(outcomes.at(-1).reason, "group_without_mention");
  });

  test("a previously unlisted group can @bot and receive a real adapter reply", async () => {
    const calls = [];
    const { channel, replies, outcomes } = createHarness({
      runTurn: async (input) => {
        calls.push(input);
        return { status: "succeeded", text: "group answer", runId: "run-open" };
      },
    });
    channel.handleEvent(groupEvent({ chatId: "oc_other", text: "@_user_1 hi" }));
    await channel.whenIdle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "hi");
    assert.equal(replies.length, 1);
    assert.equal(outcomes.find((entry) => entry.action === "accepted")?.reason, "group_mention");
  });
});

describe("AGT-029 T2: dedupe", () => {
  test("redelivery of the same event produces one run and one reply", async () => {
    let calls = 0;
    const { channel, replies, outcomes } = createHarness({
      runTurn: async () => {
        calls += 1;
        return { status: "succeeded", text: "once", runId: "run-once" };
      },
    });
    const event = textEvent({ text: "hello" });
    channel.handleEvent(event);
    await channel.whenIdle();
    channel.handleEvent(event);
    await channel.whenIdle();

    assert.equal(calls, 1);
    assert.equal(replies.length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.duplicate).length, 0);
    assert.ok(outcomes.some((outcome) => outcome.reason === "duplicate_event"));
  });

  test("concurrent duplicates before the run starts still produce one run", async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { channel } = createHarness({
      runTurn: async () => {
        calls += 1;
        await gate;
        return { status: "succeeded", text: "late", runId: "run-concurrent" };
      },
    });
    const event = textEvent({ text: "hello" });
    channel.handleEvent(event);
    channel.handleEvent(event);
    assert.equal(calls, 1);
    release();
    await channel.whenIdle();
    assert.equal(calls, 1);
  });
});

describe("AGT-029 T2: runtime and reply failures", () => {
  test("a failed run becomes a bounded error reply, not a crash", async () => {
    const { channel, replies, outcomes } = createHarness({
      runTurn: async () => ({
        status: "failed",
        text: "",
        runId: "run-failed",
        error: { code: "auth_error", message: "401 invalid api key: secret" },
      }),
    });
    channel.handleEvent(textEvent({ text: "ping" }));
    await channel.whenIdle();
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /auth_error/);
    assert.equal(replies[0].text.includes("secret"), false);
    assert.equal(outcomes.find((outcome) => outcome.action === "failed").runId, "run-failed");
  });

  test("a runtime exception is caught and reported as channel_error", async () => {
    const { channel, replies } = createHarness({
      runTurn: async () => {
        throw new Error("transport exploded");
      },
    });
    channel.handleEvent(textEvent({ text: "ping" }));
    await channel.whenIdle();
    assert.match(replies[0].text, /channel_error/);
  });

  test("a reply failure is reported in the outcome without throwing", async () => {
    const { channel, outcomes } = createHarness({
      runTurn: async () => ({ status: "succeeded", text: "answer", runId: "run-reply" }),
      reply: async () => {
        throw Object.assign(new Error("feishu down"), { code: "reply_failed" });
      },
    });
    channel.handleEvent(textEvent({ text: "ping" }));
    await channel.whenIdle();
    const replied = outcomes.find((outcome) => outcome.action === "replied");
    assert.equal(replied.replyDelivered, false);
  });
});

describe("AGT-029 T2: stop / cancel", () => {
  test("/stop aborts the active run signal and replies exactly once", async () => {
    let signalSeen;
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    const { channel, replies, outcomes } = createHarness({
      runTurn: async ({ signal }) => {
        signalSeen = signal;
        started();
        await new Promise((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", resolve, { once: true });
        });
        return { status: "cancelled", text: "", runId: "run-stopped" };
      },
    });

    channel.handleEvent(textEvent({ messageId: "om_work", text: "long task" }));
    await startedPromise;
    assert.equal(signalSeen.aborted, false);

    channel.handleEvent(textEvent({ eventId: "evt_stop", messageId: "om_stop", text: "/stop" }));
    await channel.whenIdle();

    assert.equal(signalSeen.aborted, true);
    assert.deepEqual(replies, [{ messageId: "om_stop", text: CHANNEL_REPLIES.stopped }]);
    assert.ok(outcomes.some((outcome) => outcome.action === "cancelled" && outcome.runId === "run-stopped"));
    assert.ok(outcomes.some((outcome) => outcome.action === "stopped"));
  });

  test("/stop with no active run replies without calling the runtime", async () => {
    let calls = 0;
    const { channel, replies, outcomes } = createHarness({
      runTurn: async () => {
        calls += 1;
        return { status: "succeeded", text: "no", runId: "run-no" };
      },
    });
    channel.handleEvent(textEvent({ eventId: "evt_stop", messageId: "om_stop", text: "/stop" }));
    await channel.whenIdle();
    assert.equal(calls, 0);
    assert.deepEqual(replies, [{ messageId: "om_stop", text: CHANNEL_REPLIES.noActiveRun }]);
    assert.ok(outcomes.some((outcome) => outcome.action === "stop_noop"));
  });

  test("a message queued before /stop never runs after the stop", async () => {
    let calls = 0;
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    const { channel, outcomes } = createHarness({
      runTurn: async ({ signal }) => {
        calls += 1;
        started();
        await new Promise((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", resolve, { once: true });
        });
        return { status: "cancelled", text: "", runId: `run-${calls}` };
      },
    });

    channel.handleEvent(textEvent({ eventId: "evt_1", messageId: "om_1", text: "first" }));
    await startedPromise;
    channel.handleEvent(textEvent({ eventId: "evt_2", messageId: "om_2", text: "queued" }));
    channel.handleEvent(textEvent({ eventId: "evt_stop", messageId: "om_stop", text: "/stop" }));
    await channel.whenIdle();

    assert.equal(calls, 1);
    assert.ok(outcomes.some((outcome) => outcome.reason === "stopped_before_start"));
  });

  test("a stop command in a group requires @bot", async () => {
    const { channel, replies } = createHarness();
    channel.handleEvent(groupEvent({ chatId: "oc_other", text: "/stop", mentions: [] }));
    await channel.whenIdle();
    assert.equal(replies.length, 0);
    channel.handleEvent(groupEvent({ chatId: "oc_other", text: "@_user_1 /stop" }));
    await channel.whenIdle();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, CHANNEL_REPLIES.noActiveRun);
  });
});

describe("AGT-029 T2: messages that must not reach the runtime", () => {
  test("empty text, non-text messages and app senders are ignored", async () => {
    let calls = 0;
    const { channel, replies } = createHarness({
      runTurn: async () => {
        calls += 1;
        return { status: "succeeded", text: "no", runId: "run-no" };
      },
    });

    channel.handleEvent(textEvent({ eventId: "evt_empty", text: "" }));
    channel.handleEvent(textEvent({ eventId: "evt_post", messageType: "post", content: "{}" }));
    channel.handleEvent(textEvent({ eventId: "evt_app", senderType: "app" }));
    await channel.whenIdle();

    assert.equal(calls, 0);
    assert.equal(replies.length, 0);
  });

  test("a disposed channel ignores new events", async () => {
    const { channel, outcomes } = createHarness();
    await channel.dispose();
    const result = channel.handleEvent(textEvent({ text: "after dispose" }));
    assert.equal(result.reason, "channel_disposed");
    assert.ok(outcomes.some((outcome) => outcome.reason === "channel_disposed"));
  });
});

describe("AGT-029 P1-2: stopAll releases dropped queued work", () => {
  test("stopAll drains an active run plus queued work without leaking pending", { timeout: 5_000 }, async () => {
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const { channel, replies, outcomes } = createHarness({
      runTurn: async ({ signal }) => {
        calls += 1;
        started();
        await new Promise((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", resolve, { once: true });
        });
        return { status: "cancelled", text: "", runId: "run-stopall" };
      },
    });

    channel.handleEvent(textEvent({ eventId: "evt_active", messageId: "om_active", chatId: "oc_same", text: "active" }));
    await startedPromise;
    channel.handleEvent(textEvent({ eventId: "evt_queued", messageId: "om_queued", chatId: "oc_same", text: "queued" }));
    assert.equal(channel.pendingCount, 2);

    const startedAt = Date.now();
    const drained = await channel.stopAll({ timeoutMs: 1_000 });

    assert.equal(drained, true, "stopAll must drain instead of timing out");
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(calls, 1, "the queued message must not run");
    assert.equal(channel.pendingCount, 0);
    assert.equal(channel.activeRunCount, 0);
    assert.equal(replies.length, 0);
    await channel.whenIdle();
    assert.ok(outcomes.some((outcome) => outcome.action === "cancelled"));
  });
});
