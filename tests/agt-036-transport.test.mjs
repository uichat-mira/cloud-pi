import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadWecomConfig } from "../src/channels/wecom/config.mjs";
import { createInstanceLock } from "../src/channels/wecom/instance.mjs";
import { createWecomService } from "../src/channels/wecom/service.mjs";
import { WecomTransportError, createWecomTransport } from "../src/channels/wecom/transport.mjs";
import { byteLength } from "../src/channels/wecom/text.mjs";

const CONFIG = loadWecomConfig({ WECOM_BOT_ID: "bot-id", WECOM_BOT_SECRET: "bot-secret", WECOM_BOT_NAME: "MiraBot" });

class FakeClient extends EventEmitter {
  constructor({ authenticate = true, hang = false } = {}) {
    super();
    this.authenticate = authenticate;
    this.hang = hang;
    this.connected = false;
    this.disconnected = false;
    this.replies = [];
    this.messages = [];
    this.connect = async () => {
      this.connected = true;
      if (this.hang) return;
      setTimeout(() => {
        if (this.authenticate) this.emit("authenticated");
        else this.emit("auth_failed", new Error("invalid bot_id or secret (853000)"));
      }, 1);
    };
    this.disconnect = async () => {
      this.disconnected = true;
    };
    this.replyStream = async (frame, streamId, content, finish) => {
      this.replies.push({ reqId: frame?.headers?.req_id, streamId, content, finish });
    };
    this.sendMessage = async (chatId, body) => {
      this.messages.push({ chatId, body });
    };
  }
}

function frame(reqId = "req-1") {
  return { cmd: "aibot_msg_callback", headers: { req_id: reqId }, body: { msgid: "m", msgtype: "text" } };
}

test("transport: start authenticates, forwards messages, and replies with finish=true", async () => {
  const events = [];
  const client = new FakeClient();
  const transport = createWecomTransport({ config: CONFIG, createClient: () => client, onEvent: (event) => events.push(event) });

  const started = await transport.start();
  assert.equal(started.authenticated, true);
  assert.equal(transport.isAuthenticated, true);

  client.emit("message", frame("req-7"));
  assert.equal(events.length, 1);
  assert.equal(events[0].frame.headers.req_id, "req-7");
  assert.equal(events[0].type, "text");

  const result = await transport.reply(frame("req-7"), "第一条回复");
  assert.equal(client.replies.length, 1);
  assert.equal(client.replies[0].content, "第一条回复");
  assert.equal(client.replies[0].finish, true);
  assert.match(client.replies[0].streamId, /^req-7-\d+$/);
  assert.equal(result.replyId, client.replies[0].streamId);

  await transport.stop();
  assert.equal(client.disconnected, true);
  assert.equal(transport.isAuthenticated, false);
});

test("transport: a second reply for the same callback gets a distinct stream id", async () => {
  const client = new FakeClient();
  const transport = createWecomTransport({ config: CONFIG, createClient: () => client });
  await transport.start();
  await transport.reply(frame("req-8"), "第一段");
  await transport.reply(frame("req-8"), "第二段");
  assert.notEqual(client.replies[0].streamId, client.replies[1].streamId);
  await transport.stop();
});

test("transport: refuses replies it cannot route or that break a documented limit", async () => {
  const client = new FakeClient();
  const transport = createWecomTransport({ config: CONFIG, createClient: () => client });

  await assert.rejects(
    () => transport.reply(frame("req-1"), "before connect"),
    (error) => error instanceof WecomTransportError && error.code === "not_connected",
  );

  await transport.start();

  await assert.rejects(
    () => transport.reply({ headers: {} }, "no handle"),
    (error) => error.code === "missing_req_id",
  );
  await assert.rejects(
    () => transport.reply(frame("req-1"), ""),
    (error) => error.code === "empty_reply",
  );
  await assert.rejects(
    () => transport.reply(frame("req-1"), "中".repeat(20_480)),
    (error) => error.code === "content_too_large",
  );

  await transport.stop();
});

test("transport: the per-conversation rate limit is enforced and retryable", async () => {
  const client = new FakeClient();
  const transport = createWecomTransport({ config: CONFIG, createClient: () => client });
  await transport.start();

  for (let index = 0; index < 30; index += 1) {
    await transport.reply(frame("req-rate"), `第 ${index} 条`);
  }
  assert.equal(client.replies.length, 30);

  await assert.rejects(
    () => transport.reply(frame("req-rate"), "第 31 条"),
    (error) => {
      assert.equal(error.code, "rate_limited");
      assert.equal(error.retryable, true);
      return true;
    },
  );

  // A different conversation is unaffected.
  await transport.reply(frame("req-other"), "另一会话");
  assert.equal(client.replies.length, 31);
  await transport.stop();
});

test("transport: single-chat push is refused instead of being sent as a group message", async () => {
  const client = new FakeClient();
  const transport = createWecomTransport({ config: CONFIG, createClient: () => client });
  await transport.start();

  await assert.rejects(
    () => transport.send({ chatId: "user-a", chatType: "single", text: "hi" }),
    (error) => {
      assert.equal(error.code, "chat_type_unsupported");
      return true;
    },
  );
  assert.equal(client.messages.length, 0);

  const result = await transport.send({ chatId: "chat-a", chatType: "group", text: "群消息" });
  assert.equal(result.delivered, true);
  assert.equal(client.messages.length, 1);
  assert.equal(client.messages[0].body.msgtype, "markdown");

  await transport.stop();
});

test("transport: authentication failure rejects start and leaves the transport stopped", async () => {
  const client = new FakeClient({ authenticate: false });
  const transport = createWecomTransport({
    config: { ...CONFIG, connectTimeoutMs: 2_000 },
    createClient: () => client,
  });

  await assert.rejects(
    () => transport.start(),
    (error) => {
      assert.equal(error.code, "auth_failed");
      return true;
    },
  );
  assert.equal(transport.isAuthenticated, false);
  assert.equal(client.disconnected, true);
});

test("transport: a silent endpoint times out instead of hanging the process", async () => {
  const client = new FakeClient({ hang: true });
  const transport = createWecomTransport({ config: { ...CONFIG, connectTimeoutMs: 200 }, createClient: () => client });
  await assert.rejects(
    () => transport.start(),
    (error) => {
      assert.equal(error.code, "connect_timeout");
      return true;
    },
  );
});

test("transport: SDK errors are surfaced without leaking the secret", async () => {
  const transport = createWecomTransport({
    config: CONFIG,
    createClient: () => {
      throw new Error("cannot connect with secret bot-secret");
    },
  });
  await assert.rejects(
    () => transport.start(),
    (error) => {
      assert.equal(error.code, "client_create_failed");
      assert.ok(!String(error.message).includes("bot-secret"));
      return true;
    },
  );
});

test("transport: describe() exposes configuration state, never the credential", () => {
  const transport = createWecomTransport({ config: CONFIG, createClient: () => new FakeClient() });
  const summary = JSON.stringify(transport.describe());
  assert.ok(!summary.includes("bot-secret"));
  assert.ok(!summary.includes("bot-id"));
  assert.match(summary, /"state":"connecting"/);
});

test("instance lock: a live owner refuses a second process, a stale owner is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "wecom-lock-"));

  const primary = createInstanceLock({ dir });
  assert.equal(primary.acquire().acquired, true);
  assert.equal(existsSync(primary.path), true);

  const second = createInstanceLock({ dir, pid: process.pid + 1 });
  assert.throws(
    () => second.acquire(),
    (error) => {
      assert.equal(error.code, "already_running");
      assert.ok(String(error.message).includes("one connection per bot"));
      return true;
    },
  );

  assert.equal(primary.release(), true);
  assert.equal(existsSync(primary.path), false);

  // A lock left behind by a dead process is recovered.
  writeFileSync(join(dir, "wecom-channel.lock"), JSON.stringify({ pid: 2_147_483_000 }), "utf8");
  const recovered = createInstanceLock({ dir });
  const result = recovered.acquire();
  assert.equal(result.acquired, true);
  assert.equal(result.recoveredStale, true);
  recovered.release();
});

test("service: wires transport → channel → runner, records known sessions, and releases the lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wecom-service-"));
  const client = new FakeClient();
  const runs = [];
  const service = createWecomService({
    wecomConfig: { ...CONFIG, allowedUserIds: [], allowedChatIds: [] },
    modelConfig: { fake: true },
    stateDir: dir,
    createClient: () => client,
  });

  await service.start();
  assert.equal(service.describe().started, true);
  assert.equal(existsSync(join(dir, "wecom-channel.lock")), true);

  client.emit("message", {
    cmd: "aibot_msg_callback",
    headers: { req_id: "req-svc" },
    body: { msgid: "svc-1", msgtype: "text", chattype: "single", from: { userid: "user-a" }, text: { content: "hi" } },
  });
  assert.equal(service.channel.pendingCount, 1);

  await service.stop();
  assert.equal(service.describe().stopped, true);
  assert.equal(existsSync(join(dir, "wecom-channel.lock")), false);
  assert.equal(runs.length, 0);
});

test("service: a second service on the same state directory is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wecom-service-dup-"));
  const first = createWecomService({
    wecomConfig: CONFIG,
    modelConfig: { fake: true },
    stateDir: dir,
    createClient: () => new FakeClient(),
  });
  await first.start();

  const second = createWecomService({
    wecomConfig: CONFIG,
    modelConfig: { fake: true },
    stateDir: dir,
    pid: process.pid + 1,
    createClient: () => new FakeClient(),
  });
  await assert.rejects(
    () => second.start(),
    (error) => error.code === "already_running",
  );

  await first.stop();
});

test("service: an unconfigured channel fails before connecting", () => {
  assert.throws(
    () => createWecomService({ env: {}, modelConfig: { fake: true } }),
    (error) => error.code === "wecom_config_error",
  );
});

test("text: byteLength measures UTF-8 bytes, not characters", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("中文"), 6);
  assert.equal(byteLength("🙂"), 4);
});
