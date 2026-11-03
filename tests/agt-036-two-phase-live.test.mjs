/**
 * The two-phase live harness: usage validation plus the offline self-test path.
 *
 * The self-test drives the real service wiring with a fake client, so it proves the
 * ack→push contract end to end *in process*. It is labelled `real: false` on
 * purpose: only a maintainer-run command against the real bot is live evidence.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { main, phaseEvidence, verifyTwoPhase } from "../scripts/agt-036/two-phase-live.mjs";
import { WECOM_DEFAULT_ACK_TEXT } from "../src/channels/wecom/config.mjs";

function capture() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

/** A fake SDK client that delivers one inbound message after authentication. */
function fakeClient({ chattype = "single" } = {}) {
  return new (class extends EventEmitter {
    constructor() {
      super();
      this.replies = [];
      this.sent = [];
      this.connect = async () => {
        setTimeout(() => {
          this.emit("authenticated");
          setTimeout(() => {
            const body =
              chattype === "group"
                ? {
                    msgid: "tp-msg-1",
                    msgtype: "text",
                    chattype: "group",
                    chatid: "tp-chat-1",
                    from: { userid: "tp-user-1" },
                    text: { content: "@Mira 你好" },
                  }
                : {
                    msgid: "tp-msg-1",
                    msgtype: "text",
                    chattype: "single",
                    from: { userid: "tp-user-1" },
                    text: { content: "你好" },
                  };
            this.emit("message", { cmd: "aibot_msg_callback", headers: { req_id: "tp-req-1" }, body });
          }, 10);
        }, 1);
      };
      this.disconnect = async () => {};
      this.replyStream = async (frame, streamId, content) => {
        this.replies.push({ streamId, content, reqId: frame?.headers?.req_id });
      };
      this.sendMessage = async (chatid, payload) => {
        this.sent.push({ chatid, payload });
      };
    }
  })();
}

function serviceOptions(client) {
  return {
    modelConfig: { fake: true },
    createClient: () => client,
    createRuntime: () => ({
      run: async () => ({ runId: "run-two-phase-1", status: "succeeded", text: "两段式最终回答" }),
      dispose: () => {},
    }),
  };
}

test("two-phase live: --self-test verifies ack then push over the fake client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-live-"));
  const secretsFile = join(dir, "wecom.env");
  writeFileSync(secretsFile, "WECOM_BOT_ID=bot-x\nWECOM_BOT_SECRET=secret-x\nWECOM_BOT_NAME=Mira\n", "utf8");
  const evidence = join(dir, "evidence.jsonl");
  const client = fakeClient();
  const out = capture();
  const err = capture();

  const code = await main({
    argv: ["--self-test", "--secrets", secretsFile, "--evidence", evidence],
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    serviceOptions: { ...serviceOptions(client), stateDir: join(dir, "state") },
  });

  assert.equal(code, 0, `stderr: ${err.text()}`);
  const result = out
    .text()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.phase === "self_test");
  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.real, false);
  // The fake client saw the ack and then the pushed answer with chat_type single.
  assert.equal(client.replies.length, 1);
  assert.equal(client.replies[0].content, WECOM_DEFAULT_ACK_TEXT);
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].payload.chat_type, 1);
  assert.equal(client.sent[0].payload.markdown.content, "两段式最终回答");
});

test("two-phase live: a group self-test reports chat_type group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-live-group-"));
  const secretsFile = join(dir, "wecom.env");
  writeFileSync(secretsFile, "WECOM_BOT_ID=bot-x\nWECOM_BOT_SECRET=secret-x\nWECOM_BOT_NAME=Mira\n", "utf8");
  const client = fakeClient({ chattype: "group" });
  const out = capture();
  const err = capture();

  const code = await main({
    argv: ["--self-test", "--secrets", secretsFile, "--expect-chat-type", "group", "--evidence", join(dir, "e.jsonl")],
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    serviceOptions: { ...serviceOptions(client), stateDir: join(dir, "state") },
  });

  assert.equal(code, 0, `stderr: ${err.text()}`);
  assert.equal(client.replies.length, 1);
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].payload.chat_type, 2);
});

test("two-phase live: usage errors are exit 2 and never connect", async () => {
  const out = capture();
  const err = capture();
  const code = await main({ argv: ["--inbound-timeout-ms", "10"], env: {}, stdout: out.stream, stderr: err.stream });
  assert.equal(code, 2);
  assert.equal(JSON.parse(err.text().trim()).reason, "invalid_inbound_timeout");

  const unknown = capture();
  const code2 = await main({ argv: ["--nope"], env: {}, stdout: out.stream, stderr: unknown.stream });
  assert.equal(code2, 2);
  assert.equal(JSON.parse(unknown.text().trim()).reason, "unknown_argument");

  const chatType = capture();
  const code3 = await main({
    argv: ["--expect-chat-type", "team"],
    env: {},
    stdout: out.stream,
    stderr: chatType.stream,
  });
  assert.equal(code3, 2);
  assert.equal(JSON.parse(chatType.text().trim()).reason, "invalid_expect_chat_type");
});

test("two-phase live: missing credentials is a configuration error", async () => {
  const out = capture();
  const err = capture();
  const code = await main({ argv: ["--secrets", join(tmpdir(), "nope.env")], env: {}, stdout: out.stream, stderr: err.stream });
  assert.equal(code, 2);
  assert.equal(JSON.parse(err.text().trim()).reason, "missing_bot_credentials");
});

test("two-phase live: the verifier rejects a reply-phase final and a mismatched request id", () => {
  const accepted = { action: "accepted", messageId: "m", chatId: "c", chatType: "single", requestId: "r" };
  const ack = { phase: "ack", action: "acked", messageId: "m", chatId: "c", chatType: "single", requestId: "r", ackMs: 12 };
  const final = {
    phase: "final",
    action: "replied",
    delivery: "push",
    messageId: "m",
    chatId: "c",
    chatType: "single",
    requestId: "r",
    replyDelivered: true,
  };
  assert.deepEqual(verifyTwoPhase({ accepted, ack, final }), { ok: true, reasons: [] });

  const replyPhase = verifyTwoPhase({ accepted, ack, final: { ...final, delivery: "reply" } });
  assert.equal(replyPhase.ok, false);
  assert.ok(replyPhase.reasons.includes("final_not_pushed:reply"));

  const mismatched = verifyTwoPhase({ accepted, ack: { ...ack, requestId: "other" }, final });
  assert.ok(mismatched.reasons.includes("request_id_mismatch"));

  const noAck = verifyTwoPhase({ accepted, final });
  assert.deepEqual(noAck.reasons, ["no_ack"]);
});

test("two-phase live: evidence lines are a whitelist projection with hashed identifiers", () => {
  const line = phaseEvidence(
    {
      phase: "final",
      action: "replied",
      delivery: "push",
      requestId: "req-1",
      chatType: "single",
      chatId: "raw-chat-id",
      messageId: "raw-message-id",
      senderUserId: "raw-user-id",
      runId: "run-1",
      text: "不得出现",
      ackMs: 12,
      segments: 1,
      segmentsDelivered: 1,
      replyDelivered: true,
      platformErrcode: 0,
    },
    { provider: "p", model: "m" },
  );
  assert.equal(line.chat, "id:" + line.chat.slice(3));
  assert.match(line.chat, /^id:[0-9a-f]{8}$/);
  assert.match(line.inboundMessage, /^id:[0-9a-f]{8}$/);
  assert.equal(JSON.stringify(line).includes("raw-chat-id"), false);
  assert.equal(JSON.stringify(line).includes("raw-user-id"), false);
  assert.equal(JSON.stringify(line).includes("不得出现"), false);
});
