/**
 * AGT-029 T2: service wiring without a socket or a model.
 *
 * Proves configuration is validated before the transport opens, and that the
 * transport event callback is wired to the policy/dedupe/run/reply adapter.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError } from "../src/config.mjs";
import { startFeishuService } from "../src/channels/feishu/service.mjs";
import { textEvent, botMention } from "./helpers/feishu-events.mjs";

const FEISHU_ENV = Object.freeze({
  FEISHU_APP_ID: "cli_a1b2c3",
  FEISHU_APP_SECRET: "secret-value-not-logged",
  FEISHU_ALLOWED_CHAT_IDS: "oc_group",
});

describe("AGT-029 T2: service startup", () => {
  test("an incomplete model configuration fails before the transport is created", async () => {
    let transportCreated = false;
    await assert.rejects(
      startFeishuService({
        env: FEISHU_ENV,
        createTransport: () => {
          transportCreated = true;
          throw new Error("transport must not be created");
        },
      }),
      (error) => error instanceof ConfigError,
    );
    assert.equal(transportCreated, false);
  });

  test("the transport event callback reaches policy, runtime and reply", async () => {
    const calls = [];
    const replies = [];
    let stopped = false;
    let agentDisposed = false;
    let onEvent;
    const fakeTransport = {
      async start() {
        return { botOpenId: "ou_bot_000000000001" };
      },
      stop() {
        stopped = true;
      },
      async reply(messageId, text) {
        replies.push({ messageId, text });
        return { messageId: "om_reply_1" };
      },
      getBotOpenId() {
        return "ou_bot_000000000001";
      },
    };

    const service = await startFeishuService({
      env: FEISHU_ENV,
      createTransport: (options) => {
        onEvent = options.onEvent;
        return fakeTransport;
      },
      createAgentRunner: () => ({
        async runTurn({ text }) {
          calls.push(text);
          return { status: "succeeded", text: "service answer", runId: "run-service" };
        },
        async dispose() {
          agentDisposed = true;
        },
      }),
    });

    assert.deepEqual(service.summary, {
      appId: "cli_a1b2c3",
      domain: "feishu",
      allowedChatCount: 1,
      botOpenIdConfigured: false,
      botOpenIdResolved: true,
      botOpenId: "ou_bot…0001",
    });

    onEvent(textEvent({ text: "ping" }));
    await service.channel.whenIdle();
    assert.deepEqual(calls, ["ping"]);
    assert.equal(replies[0].text, "service answer");

    onEvent(
      textEvent({
        eventId: "evt_group",
        messageId: "om_group",
        chatId: "oc_group",
        chatType: "group",
        text: "@_user_1 hi",
        mentions: [botMention({ openId: "ou_bot_000000000001" })],
      }),
    );
    await service.channel.whenIdle();
    assert.deepEqual(calls, ["ping", "hi"]);

    await service.stop();
    assert.equal(stopped, true);
    assert.equal(agentDisposed, true);
  });
});
