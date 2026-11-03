/**
 * AGT-038 review fixes (t33): cursor leakage, pseudo tool text at the channel
 * exit, and `live-mcp.mjs` argument validation.
 *
 * The three are one class of bug: a value that "looked like" something harmless
 * crossed a boundary in a form that could be replayed or copied verbatim.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { createWecomChannel } from "../src/channels/wecom/channel.mjs";
import { createWecomDedupeStore } from "../src/channels/wecom/dedupe.mjs";
import {
  containsPseudoToolText,
  PSEUDO_TOOL_REPLY,
  redactOpaqueHandles,
  sanitizeModelReply,
} from "../src/redaction.mjs";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const CONSUMER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function cursorHandle(account = ACCOUNT, consumer = CONSUMER) {
  return Buffer.from(JSON.stringify({ v: 1, a: account, c: consumer }), "utf8").toString("base64url");
}

/** Decode every base64url-looking token in `text`. */
function decodedTokens(text) {
  return (text.match(/[A-Za-z0-9_-]{20,}/g) ?? []).map((token) =>
    Buffer.from(token, "base64url").toString("utf8"),
  );
}

test("cursor: an encoded handle never survives in a form that decodes to the UUIDs", () => {
  const cursor = cursorHandle();
  const text = `guanlan_news_recent ok\nitems: 2\nNext cursor: ${cursor}`;

  const out = redactOpaqueHandles(text);

  assert.equal(out.includes(ACCOUNT), false);
  assert.equal(out.includes(CONSUMER), false);
  assert.equal(out.includes(cursor), false);
  // Nothing in the projection may decode back to either identifier.
  for (const decoded of decodedTokens(out)) {
    assert.equal(decoded.includes(ACCOUNT), false);
    assert.equal(decoded.includes(CONSUMER), false);
  }
  // The surrounding evidence stays readable and the handle stays observable.
  assert.ok(out.startsWith("guanlan_news_recent ok"));
  assert.match(out, /Next cursor: <handle len=\d+ sha=[0-9a-f]{8}>/);
});

test("cursor: plaintext identifiers are masked, ordinary text is untouched", () => {
  const text = `account=${ACCOUNT} consumer=${CONSUMER} note=all good`;
  const out = redactOpaqueHandles(text);
  assert.equal(out.includes(ACCOUNT), false);
  assert.equal(out.includes(CONSUMER), false);
  assert.match(out, /account=id:[0-9a-f]{8}/);
  assert.match(out, /note=all good/);

  assert.equal(redactOpaqueHandles("plain text with 中文 and numbers 12345"), "plain text with 中文 and numbers 12345");
  // A JSON payload without an identifier is not a handle: it stays intact.
  const benign = Buffer.from(JSON.stringify({ v: 1, page: 3 }), "utf8").toString("base64url");
  assert.ok(redactOpaqueHandles(`page=${benign}`).includes(benign));
});

test("cursor: the digest is stable, so two sightings of one cursor still correlate", () => {
  const cursor = cursorHandle();
  const first = redactOpaqueHandles(`a ${cursor}`);
  const second = redactOpaqueHandles(`b ${cursor}`);
  const digest = (value) => value.match(/sha=([0-9a-f]{8})/)?.[1];
  assert.ok(digest(first));
  assert.equal(digest(first), digest(second));
  // A different handle must not collide with the first one.
  const other = redactOpaqueHandles(`y ${cursorHandle("99999999-8888-7777-6666-555555555555", CONSUMER)}`);
  assert.notEqual(digest(other), digest(first));
});

test("pseudo tool text: detected, replaced, and never returned verbatim", () => {
  const leaked = "好的，我来执行：<||DSML|| invoke bash {\"cmd\":\"ls\"} ||DSML||>";
  assert.equal(containsPseudoToolText(leaked), true);

  const { text, leaked: flagged } = sanitizeModelReply(leaked);
  assert.equal(flagged, true);
  assert.equal(text, PSEUDO_TOOL_REPLY);
  assert.equal(text.includes("DSML"), false);

  const clean = sanitizeModelReply("今天是周三，进度正常。");
  assert.deepEqual(clean, { text: "今天是周三，进度正常。", leaked: false });
});

test("channel exit: a pseudo tool reply is replaced and the turn is recorded as failed", async () => {
  const replies = [];
  const outcomes = [];
  const channel = createWecomChannel({
    runTurn: async () => ({ status: "succeeded", text: "调用工具：<||DSML|| invoke guanlan_news_recent>", runId: "run-t33" }),
    reply: async (_frame, text) => {
      replies.push(text);
      return { messageId: "reply-1", errcode: 0 };
    },
    policy: { botName: "Mira" },
    dedupe: createWecomDedupeStore(),
    onOutcome: (outcome) => outcomes.push(outcome),
  });

  channel.handleEvent({
    cmd: "aibot_msg_callback",
    headers: { req_id: "req-t33" },
    body: {
      msgid: "msg-t33",
      msgtype: "text",
      chattype: "single",
      from: { userid: "user-t33" },
      text: { content: "查一下" },
    },
  });
  await channel.whenIdle();

  assert.equal(replies.length, 1);
  assert.equal(replies[0], PSEUDO_TOOL_REPLY);
  assert.equal(replies[0].includes("DSML"), false);

  const outcome = outcomes.find((entry) => entry.action === "failed");
  assert.ok(outcome, "the turn must be recorded as failed");
  assert.equal(outcome.reason, "pseudo_tool_text");
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.runId, "run-t33");
});

test("live-mcp: a spaced --mode is a usage error, not a silent happy run", async () => {
  const script = join(ROOT, "scripts", "agt-038", "live-mcp.mjs");
  await assert.rejects(
    () => run(process.execPath, [script, "--mode", "expired"], { cwd: ROOT, timeout: 30_000 }),
    (error) => {
      assert.equal(error.code, 2);
      const payload = JSON.parse(error.stdout.trim());
      assert.equal(payload.phase, "usage");
      assert.equal(payload.reason, "unexpected_positional");
      assert.equal(payload.argument, "expired");
      return true;
    },
  );
});

test("live-mcp: an unknown mode is a usage error too", async () => {
  const script = join(ROOT, "scripts", "agt-038", "live-mcp.mjs");
  await assert.rejects(
    () => run(process.execPath, [script, "--mode=nonsense"], { cwd: ROOT, timeout: 30_000 }),
    (error) => {
      assert.equal(error.code, 2);
      const payload = JSON.parse(error.stdout.trim());
      assert.equal(payload.reason, "unknown_mode");
      assert.ok(Array.isArray(payload.allowed));
      return true;
    },
  );
});
