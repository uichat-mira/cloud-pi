/**
 * V1 authorization boundary (t29).
 *
 * The rule under test: with an external tool service enabled, a WeCom deployment
 * may not run with an implicit "anyone who can message the bot" policy, because
 * every tool call in V1 executes under the maintainer-delegated service identity.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertWecomSessionAuthorization,
  describeSessionAuthorization,
  enabledExternalToolSources,
} from "../src/channels/wecom/authorization.mjs";
import { createWecomChannel } from "../src/channels/wecom/channel.mjs";
import { createWecomDedupeStore } from "../src/channels/wecom/dedupe.mjs";
import { WECOM_CONFIG_KEYS, WecomConfigError } from "../src/channels/wecom/config.mjs";
import { createWecomService } from "../src/channels/wecom/service.mjs";
import { exitCodeFor } from "../src/entry/main.mjs";

const BASE_ENV = Object.freeze({
  WECOM_BOT_ID: "bot-t29",
  WECOM_BOT_SECRET: "secret-t29",
  WECOM_BOT_NAME: "Mira",
});

const TOOL_ENV = Object.freeze({
  ...BASE_ENV,
  GUANLAN_MCP_URL: "https://example.invalid/mcp",
});

/** Minimal validated WeCom config, as `loadWecomConfig()` would return it. */
function config(overrides = {}) {
  return Object.freeze({
    botId: "bot-t29",
    botSecret: "secret-t29",
    botName: "Mira",
    allowedUserIds: Object.freeze([]),
    allowedChatIds: Object.freeze([]),
    deniedReply: undefined,
    wsUrl: undefined,
    heartbeatIntervalMs: 30_000,
    connectTimeoutMs: 20_000,
    replyMaxBytes: 20_000,
    replyTimeoutMs: 15_000,
    ackEnabled: false,
    ackText: "已收到，正在处理…",
    ...overrides,
  });
}

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

function groupFrame(overrides = {}) {
  return singleFrame({
    ...overrides,
    body: { msgid: "msg-g", chattype: "group", chatid: "chat-g", text: { content: "@Mira 查一下" }, ...overrides.body },
  });
}

function denyProbe() {
  const calls = { runs: [], replies: [], outcomes: [] };
  const channel = createWecomChannel({
    runTurn: async (input) => {
      calls.runs.push(input);
      return { status: "succeeded", text: "不该被调用" };
    },
    reply: async (_frame, text) => {
      calls.replies.push(text);
      return { messageId: "reply-1", errcode: 0 };
    },
    policy: { botName: "Mira", allowedUserIds: ["user-allowed"], allowedChatIds: ["chat-allowed"] },
    deniedReply: calls.deniedReply,
    dedupe: createWecomDedupeStore(),
    onOutcome: (outcome) => calls.outcomes.push(outcome),
  });
  return { channel, calls };
}

test("external tools enabled + no allowlist → startup fails as a config error (exit 2)", async () => {
  assert.deepEqual(enabledExternalToolSources(TOOL_ENV), ["GUANLAN_MCP_URL"]);

  let error;
  try {
    assertWecomSessionAuthorization({ env: TOOL_ENV, config: config() });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof WecomConfigError, "a config error must be thrown");
  assert.equal(error.code, "wecom_config_error");
  assert.match(error.message, new RegExp(WECOM_CONFIG_KEYS.ALLOWED_USER_IDS));
  assert.match(error.message, new RegExp(WECOM_CONFIG_KEYS.ALLOWED_CHAT_IDS));
  assert.match(error.message, /maintainer-delegated/u);
  assert.match(error.message, /not Cloud Auth authorization/u);
  // `wecom_config_error` is a configuration code: the entry exits 2, not 1.
  assert.equal(exitCodeFor(error), 2);
});

test("the gate applies to real service construction, not just to the helper", async () => {
  await assert.rejects(
    async () => createWecomService({ env: TOOL_ENV, wecomConfig: config(), log: () => {} }),
    (error) => {
      assert.equal(error.code, "wecom_config_error");
      assert.equal(exitCodeFor(error), 2);
      return true;
    },
  );
});

test("an explicit allowlist satisfies the gate; a chat-only deployment keeps the old default", async () => {
  const enforced = assertWecomSessionAuthorization({
    env: TOOL_ENV,
    config: config({ allowedChatIds: Object.freeze(["chat-allowed"]) }),
  });
  assert.equal(enforced.enforced, true);
  assert.equal(enforced.allowedChatCount, 1);
  assert.equal(enforced.allowedUserCount, 0);
  assert.deepEqual(enforced.sources, ["GUANLAN_MCP_URL"]);

  // No external tools: no allowlist is still legal (the run can only talk).
  const chatOnly = assertWecomSessionAuthorization({ env: BASE_ENV, config: config() });
  assert.equal(chatOnly.enforced, false);
  assert.deepEqual(chatOnly.sources, []);

  // Each documented credential form counts as "tools enabled".
  for (const key of ["GUANLAN_MCP_TOKEN", "GUANLAN_MCP_TOKEN_FILE"]) {
    assert.deepEqual(enabledExternalToolSources({ ...BASE_ENV, [key]: "x" }), [key]);
    assert.throws(() => assertWecomSessionAuthorization({ env: { ...BASE_ENV, [key]: "x" }, config: config() }), WecomConfigError);
  }
});

test("a non-listed sender is refused before any model or tool work", async () => {
  const { channel, calls } = denyProbe();

  const outcome = channel.handleEvent(singleFrame()); // sender user-a is not in the list
  await channel.whenIdle();

  assert.equal(outcome.action, "ignored");
  assert.equal(outcome.reason, "user_not_allowed");
  assert.equal(calls.runs.length, 0, "no model run");
  assert.equal(calls.replies.length, 0, "silent by default: the allowlist cannot be probed");
  assert.equal(calls.outcomes.filter((entry) => entry.action === "accepted").length, 0);
});

test("a group that is not on the chat allowlist is refused entirely", async () => {
  const { channel, calls } = denyProbe();

  const outcome = channel.handleEvent(groupFrame());
  await channel.whenIdle();

  assert.equal(outcome.action, "ignored");
  assert.equal(outcome.reason, "chat_not_allowed");
  assert.equal(calls.runs.length, 0);
  assert.equal(calls.replies.length, 0);
});

test("a listed sender is still served, and an optional denied reply is a fixed sentence", async () => {
  const allowed = denyProbe();
  const allowedOutcome = allowed.channel.handleEvent(singleFrame({ body: { from: { userid: "user-allowed" }, msgid: "msg-2" } }));
  await allowed.channel.whenIdle();
  assert.equal(allowedOutcome.action, "accepted");
  assert.equal(allowed.calls.runs.length, 1);

  const deniedReply = "该会话未授权使用本机器人。";
  const replies = [];
  const channel = createWecomChannel({
    runTurn: async () => {
      throw new Error("must not run");
    },
    reply: async (_frame, text) => {
      replies.push(text);
      return { messageId: "reply-2", errcode: 0 };
    },
    policy: { botName: "Mira", allowedUserIds: ["user-allowed"], allowedChatIds: [] },
    deniedReply,
    dedupe: createWecomDedupeStore(),
    onOutcome: () => {},
  });
  const outcome = channel.handleEvent(singleFrame({ body: { msgid: "msg-3" } }));
  // The denied reply is fire-and-forget, like the stop acknowledgement.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(outcome.reason, "user_not_allowed");
  assert.deepEqual(replies, [deniedReply]);
});

test("the allowlist projection exposes counts only, never identifiers", () => {
  const projection = describeSessionAuthorization({ allowedUserIds: ["zhangsan"], allowedChatIds: ["chat-1"] });
  assert.deepEqual(projection, { allowedUserCount: 1, allowedChatCount: 1, explicitlyAuthorized: true });
  assert.equal(JSON.stringify(projection).includes("zhangsan"), false);
});

/**
 * The real acceptance is the process exit code, not the helper: run the entry
 * with external tools enabled and look at what an operator would see.
 */
function entryEnv(extra = {}) {
  const inherited = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
  };
  return { ...inherited, ...extra };
}

async function runEntry(t, env) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const script = join(root, "src", "entry", "main.mjs");
  return promisify(execFile)(process.execPath, [script, "--channels", "wecom", "--check"], {
    cwd: root,
    env,
    timeout: 60_000,
  }).then(
    (result) => ({ code: 0, ...result }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
}

test("entry --check: tools enabled without an allowlist exits 2 and explains why", async (t) => {
  const result = await runEntry(
    t,
    entryEnv({
      ...BASE_ENV,
      GUANLAN_MCP_URL: "https://example.invalid/mcp",
    }),
  );
  assert.equal(result.code, 2);
  const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const failure = lines.find((line) => line.event === "cloud_agent_config_invalid");
  assert.ok(failure, "a config error line is required");
  assert.equal(failure.code, "wecom_config_error");
  assert.match(failure.message, /maintainer-delegated/u);
  assert.deepEqual(failure.fields, [WECOM_CONFIG_KEYS.ALLOWED_USER_IDS, WECOM_CONFIG_KEYS.ALLOWED_CHAT_IDS]);
});

test("entry --check: an explicit chat allowlist passes and reports what is enforced", async (t) => {
  const result = await runEntry(
    t,
    entryEnv({
      ...BASE_ENV,
      GUANLAN_MCP_URL: "https://example.invalid/mcp",
      WECOM_ALLOWED_CHAT_IDS: "chat-1,chat-2",
    }),
  );
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const gate = lines.find((line) => line.event === "wecom_session_authorization");
  assert.ok(gate);
  assert.equal(gate.enforced, true);
  assert.equal(gate.allowedChatCount, 2);
  assert.deepEqual(gate.sources, ["GUANLAN_MCP_URL"]);
  assert.ok(lines.some((line) => line.event === "cloud_agent_config_ok"));
});

test("entry --check: a chat-only deployment needs no allowlist", async (t) => {
  const result = await runEntry(t, entryEnv(BASE_ENV));
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const gate = lines.find((line) => line.event === "wecom_session_authorization");
  assert.equal(gate.enforced, false);
  assert.deepEqual(gate.sources, []);
});
