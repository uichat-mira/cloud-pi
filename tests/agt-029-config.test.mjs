/**
 * AGT-029 T1: Feishu channel configuration validation.
 *
 * Secrets must never appear in errors or the safe description, and an invalid
 * configuration must fail before the process can connect.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FEISHU_CONFIG_KEYS,
  FeishuConfigError,
  describeFeishuConfig,
  loadFeishuConfig,
} from "../src/channels/feishu/config.mjs";

const BASE_ENV = Object.freeze({
  FEISHU_APP_ID: "cli_a1b2c3",
  FEISHU_APP_SECRET: "secret-value-do-not-log",
});

describe("AGT-029 T1: Feishu config parsing", () => {
  test("parses a minimal private-chat configuration", () => {
    const config = loadFeishuConfig({ ...BASE_ENV });
    assert.equal(config.appId, "cli_a1b2c3");
    assert.equal(config.domain, "feishu");
    assert.deepEqual(config.allowedChatIds, []);
    assert.equal(config.botOpenId, undefined);
  });

  test("parses comma, semicolon and whitespace separated group allowlists", () => {
    const config = loadFeishuConfig({
      ...BASE_ENV,
      FEISHU_ALLOWED_CHAT_IDS: "oc_aaa, oc_bbb;oc_ccc\noc_aaa",
      FEISHU_BOT_OPEN_ID: "ou_bot1",
      FEISHU_DOMAIN: "lark",
    });
    assert.deepEqual(config.allowedChatIds, ["oc_aaa", "oc_bbb", "oc_ccc"]);
    assert.equal(config.botOpenId, "ou_bot1");
    assert.equal(config.domain, "lark");
  });

  test("rejects missing and malformed values with field names only", () => {
    assert.throws(
      () => loadFeishuConfig({}),
      (error) => {
        assert.ok(error instanceof FeishuConfigError);
        assert.deepEqual(error.fields, [FEISHU_CONFIG_KEYS.appId, FEISHU_CONFIG_KEYS.appSecret]);
        assert.equal(error.message.includes("secret-value"), false);
        return true;
      },
    );

    assert.throws(
      () =>
        loadFeishuConfig({
          ...BASE_ENV,
          FEISHU_ALLOWED_CHAT_IDS: "not-a-chat-id",
          FEISHU_BOT_OPEN_ID: "user_1",
          FEISHU_DOMAIN: "slack",
        }),
      (error) => {
        assert.deepEqual(error.fields, [
          FEISHU_CONFIG_KEYS.domain,
          FEISHU_CONFIG_KEYS.allowedChatIds,
          FEISHU_CONFIG_KEYS.botOpenId,
        ]);
        return true;
      },
    );
  });

  test("rejects a secret containing whitespace without echoing it", () => {
    assert.throws(
      () => loadFeishuConfig({ FEISHU_APP_ID: "cli_a1", FEISHU_APP_SECRET: "abc def" }),
      (error) => {
        assert.deepEqual(error.fields, [FEISHU_CONFIG_KEYS.appSecret]);
        assert.equal(error.message.includes("abc def"), false);
        return true;
      },
    );
  });

  test("the safe description omits the app secret", () => {
    const config = loadFeishuConfig({ ...BASE_ENV, FEISHU_ALLOWED_CHAT_IDS: "oc_aaa" });
    const described = describeFeishuConfig(config);
    assert.deepEqual(described, {
      appId: "cli_a1b2c3",
      domain: "feishu",
      allowedChatCount: 1,
      botOpenIdConfigured: false,
    });
    assert.equal(JSON.stringify(described).includes(BASE_ENV.FEISHU_APP_SECRET), false);
  });
});
