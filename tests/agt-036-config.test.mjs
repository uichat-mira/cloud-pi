import assert from "node:assert/strict";
import test from "node:test";
import {
  WECOM_MAX_CONTENT_BYTES,
  WecomConfigError,
  describeWecomConfig,
  hashId,
  loadWecomConfig,
} from "../src/channels/wecom/config.mjs";

const BOT_ENV = Object.freeze({
  WECOM_BOT_ID: "bot-test-id",
  WECOM_BOT_SECRET: "bot-test-secret",
});

test("loadWecomConfig: requires bot credentials and names the missing fields", () => {
  assert.throws(
    () => loadWecomConfig({}),
    (error) => {
      assert.ok(error instanceof WecomConfigError);
      assert.equal(error.code, "wecom_config_error");
      assert.deepEqual(error.fields, ["WECOM_BOT_ID", "WECOM_BOT_SECRET"]);
      return true;
    },
  );

  assert.throws(
    () => loadWecomConfig({ WECOM_BOT_ID: "id" }),
    (error) => {
      assert.deepEqual(error.fields, ["WECOM_BOT_SECRET"]);
      return true;
    },
  );
});

test("loadWecomConfig: never echoes a credential in the error message", () => {
  try {
    loadWecomConfig({ WECOM_BOT_SECRET: "super-secret-value" });
    assert.fail("expected a config error");
  } catch (error) {
    assert.ok(!String(error.message).includes("super-secret-value"));
    assert.ok(!JSON.stringify(error).includes("super-secret-value"));
  }
});

test("loadWecomConfig: defaults keep the SDK endpoint and stay under the platform byte limit", () => {
  const config = loadWecomConfig({ ...BOT_ENV });
  assert.equal(config.botId, "bot-test-id");
  assert.equal(config.botSecret, "bot-test-secret");
  // Undefined means "use the SDK default endpoint" instead of pinning a URL here.
  assert.equal(config.wsUrl, undefined);
  assert.equal(config.heartbeatIntervalMs, 30_000);
  assert.ok(config.replyMaxBytes < WECOM_MAX_CONTENT_BYTES);
  assert.deepEqual(config.allowedUserIds, []);
  assert.deepEqual(config.allowedChatIds, []);
  assert.ok(Object.isFrozen(config));
});

test("loadWecomConfig: parses allowlists and rejects malformed numbers", () => {
  const config = loadWecomConfig({
    ...BOT_ENV,
    WECOM_ALLOWED_USER_IDS: " u1, u2 ,, u1 ",
    WECOM_ALLOWED_CHAT_IDS: "chat-a",
    WECOM_REPLY_MAX_BYTES: "4096",
  });
  assert.deepEqual(config.allowedUserIds, ["u1", "u2"]);
  assert.deepEqual(config.allowedChatIds, ["chat-a"]);
  assert.equal(config.replyMaxBytes, 4096);

  assert.throws(
    () => loadWecomConfig({ ...BOT_ENV, WECOM_REPLY_MAX_BYTES: "999999" }),
    (error) => error.code === "wecom_config_error",
  );
  assert.throws(
    () => loadWecomConfig({ ...BOT_ENV, WECOM_HEARTBEAT_INTERVAL_MS: "soon" }),
    (error) => error.code === "wecom_config_error",
  );
  assert.throws(
    () => loadWecomConfig({ ...BOT_ENV, WECOM_WS_URL: "https://example.invalid" }),
    (error) => error.code === "wecom_config_error",
  );
});

test("describeWecomConfig: reports presence, never the credential value", () => {
  const config = loadWecomConfig({ ...BOT_ENV, WECOM_BOT_NAME: "MiraBot", WECOM_ALLOWED_USER_IDS: "u1" });
  const summary = describeWecomConfig(config);
  assert.equal(summary.botIdConfigured, true);
  assert.equal(summary.botSecretConfigured, true);
  assert.equal(summary.botNameConfigured, true);
  assert.equal(summary.allowedUserCount, 1);
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes("bot-test-secret"));
  assert.ok(!serialized.includes("bot-test-id"));
});

test("hashId: stable, short, and not a prefix mask of the raw id", () => {
  const value = "zhangsan";
  const first = hashId(value);
  assert.equal(first, hashId(value));
  assert.match(first, /^id:[0-9a-f]{8}$/);
  assert.ok(!first.includes("zhang"));
  assert.ok(!first.includes("san"));
  assert.notEqual(hashId("zhangsan"), hashId("lisi"));
  assert.equal(hashId(undefined), "");
});
