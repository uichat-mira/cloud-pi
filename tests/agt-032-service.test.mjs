/**
 * AGT-032 T2: service assembly.
 *
 * Proves the research runner is wired as a separate dependency of the channel
 * (chat runtime untouched), and that shutdown disposes it after draining.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFeishuService } from "../src/channels/feishu/service.mjs";
import { REPORT_TEXT } from "./agt-032-fixtures.mjs";
import { textEvent } from "./helpers/feishu-events.mjs";

const FEISHU_ENV = Object.freeze({
  FEISHU_APP_ID: "cli_a1b2c3",
  FEISHU_APP_SECRET: "secret-value-not-logged",
  FEISHU_ALLOWED_CHAT_IDS: "oc_group",
});

test("the service wires /research to the research runner and keeps chat separate", async (t) => {
  const chatCalls = [];
  const researchCalls = [];
  const replies = [];
  const disposed = { agent: false, research: false };
  let onEvent;

  const fakeTransport = {
    async start() {
      return { botOpenId: "ou_bot_000000000001" };
    },
    stop() {},
    async reply(messageId, text) {
      replies.push({ messageId, text });
      return { messageId: `om_reply_${replies.length}` };
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
        chatCalls.push(text);
        return { status: "succeeded", text: `chat:${text}`, runId: "run-chat" };
      },
      async dispose() {
        disposed.agent = true;
      },
    }),
    createResearchRunner: () => ({
      async runResearch({ topic }) {
        researchCalls.push(topic);
        return { status: "completed", runId: "r-service-1", report: REPORT_TEXT, durationMs: 4 };
      },
      async dispose() {
        disposed.research = true;
      },
    }),
  });
  t.after(() => service.stop());

  onEvent(textEvent({ eventId: "evt_chat", messageId: "om_chat", text: "hello" }));
  onEvent(textEvent({ eventId: "evt_research", messageId: "om_research", text: "/research AI 新闻" }));
  await service.channel.whenIdle();

  assert.deepEqual(chatCalls, ["hello"]);
  assert.deepEqual(researchCalls, ["AI 新闻"]);
  assert.equal(replies[0].text, "chat:hello");
  assert.match(replies[1].text, /研究完成/);
  assert.match(replies[1].text, /r-service-1/);

  await service.stop();
  assert.equal(disposed.research, true);
  assert.equal(disposed.agent, true);
});
