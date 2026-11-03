import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { loadWecomConfig } from "../src/channels/wecom/config.mjs";
import { loadEnvFiles, main, parseEnvText } from "../scripts/agt-036/wecom-live.mjs";

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

function fakeClient({ message = true } = {}) {
  return new (class extends EventEmitter {
    constructor() {
      super();
      this.replies = [];
      this.connect = async () => {
        setTimeout(() => {
          this.emit("authenticated");
          if (!message) return;
          setTimeout(() => {
            this.emit("message", {
              cmd: "aibot_msg_callback",
              headers: { req_id: "live-req-1" },
              body: {
                msgid: "live-msg-1",
                msgtype: "text",
                chattype: "single",
                from: { userid: "live-user-1" },
                text: { content: "你好" },
              },
            });
          }, 10);
        }, 1);
      };
      this.disconnect = async () => {};
      this.replyStream = async (frame, streamId, content, finish) => {
        this.replies.push({ streamId, content, finish });
      };
      this.sendMessage = async () => {};
    }
  })();
}

test("parseEnvText: reads KEY=VALUE, ignores comments, strips quotes and export", () => {
  const parsed = parseEnvText(
    [
      "# a comment",
      "",
      "WECOM_BOT_ID=bot-abc",
      "export WECOM_BOT_SECRET='secret-xyz'",
      'QUOTED="dq-value"',
      "BAD KEY=1",
      "NO_EQUALS",
      "EMPTY=",
    ].join("\n"),
  );
  assert.equal(parsed.WECOM_BOT_ID, "bot-abc");
  assert.equal(parsed.WECOM_BOT_SECRET, "secret-xyz");
  assert.equal(parsed.QUOTED, "dq-value");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed["BAD KEY"], undefined);
  assert.equal(parsed.NO_EQUALS, undefined);
});

test("loadEnvFiles: later files win and missing files are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "wecom-live-env-"));
  const first = join(dir, "a.env");
  const second = join(dir, "b.env");
  writeFileSync(first, "A=1\nB=1\n", "utf8");
  writeFileSync(second, "B=2\n", "utf8");
  const merged = loadEnvFiles([first, join(dir, "missing.env"), second]);
  assert.equal(merged.A, "1");
  assert.equal(merged.B, "2");
});

test("live: missing credentials is a configuration error, not a connection attempt", async () => {
  const out = capture();
  const err = capture();
  const code = await main({
    argv: ["--secrets", join(tmpdir(), "does-not-exist.env")],
    env: {},
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(code, 2);
  const payload = JSON.parse(err.text().trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "missing_bot_credentials");
});

test("live: one inbound message is answered and the evidence is redacted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wecom-live-run-"));
  const secretsFile = join(dir, "wecom.env");
  const modelEnvFile = join(dir, "model.env");
  writeFileSync(secretsFile, "WECOM_BOT_ID=bot-from-file\nWECOM_BOT_SECRET=secret-from-file\nWECOM_BOT_NAME=MiraBot\n", "utf8");
  writeFileSync(modelEnvFile, "CLOUD_PI_MODEL_ID=stub\n", "utf8");

  const out = capture();
  const err = capture();
  const client = fakeClient();
  const code = await main({
    argv: ["--secrets", secretsFile, "--env-file", modelEnvFile, "--timeout-ms", "5000", "--evidence", join(dir, "evidence.jsonl")],
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    serviceOptions: {
      stateDir: join(dir, "state"),
      modelConfig: { fake: true },
      createClient: () => client,
      createRuntime: () => ({
        run: async () => ({ runId: "run-live-1", status: "succeeded", text: "你好，我是 Mira。" }),
        dispose: () => {},
      }),
    },
  });

  assert.equal(code, 0, `stderr: ${err.text()}`);
  assert.equal(client.replies.length, 1);
  assert.equal(client.replies[0].content, "你好，我是 Mira。");
  assert.equal(client.replies[0].finish, true);

  const combined = `${out.text()}\n${err.text()}`;
  // Credentials from the file never appear in any output.
  assert.ok(!combined.includes("secret-from-file"));
  assert.ok(!combined.includes("bot-from-file"));
  // Raw platform identifiers are hashed.
  assert.ok(!combined.includes("live-msg-1"));
  assert.ok(!combined.includes("live-user-1"));

  const result = out
    .text()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.event === "wecom_live_result");
  assert.equal(result.ok, true);
  assert.equal(result.runId, "run-live-1");
  assert.equal(result.replyDelivered, true);
  assert.match(result.inboundChat, /^id:[0-9a-f]{8}$/);

  // The JSONL evidence file is the same whitelist projection: no credentials, no
  // raw platform identifiers, no message body.
  const evidence = readFileSync(join(dir, "evidence.jsonl"), "utf8");
  assert.ok(evidence.length > 0);
  assert.ok(!evidence.includes("secret-from-file"));
  assert.ok(!evidence.includes("live-msg-1"));
  assert.ok(!evidence.includes("live-user-1"));
  assert.ok(!evidence.includes("你好，我是 Mira。"));
  assert.ok(evidence.includes("run-live-1"));
});

test("live: an unknown --expect mode is a usage error", async () => {
  const out = capture();
  const err = capture();
  const code = await main({ argv: ["--expect", "nonsense"], env: {}, stdout: out.stream, stderr: err.stream });
  assert.equal(code, 2);
  assert.equal(JSON.parse(err.text().trim()).reason, "invalid_expect");
});

test("live: no inbound message within the window is a reported failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wecom-live-timeout-"));
  const out = capture();
  const err = capture();
  const code = await main({
    argv: ["--env-file", join(dir, "none.env"), "--timeout-ms", "1000", "--evidence", join(dir, "evidence.jsonl")],
    env: { WECOM_BOT_ID: "bot-x", WECOM_BOT_SECRET: "secret-x" },
    stdout: out.stream,
    stderr: err.stream,
    serviceOptions: {
      wecomConfig: loadWecomConfig({ WECOM_BOT_ID: "bot-x", WECOM_BOT_SECRET: "secret-x" }),
      stateDir: join(dir, "state"),
      modelConfig: { fake: true },
      createClient: () => fakeClient({ message: false }),
      createRuntime: () => ({ run: async () => ({ status: "succeeded", text: "x" }), dispose: () => {} }),
    },
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(err.text().trim().split("\n").pop()).reason, "no_inbound_message");
});
