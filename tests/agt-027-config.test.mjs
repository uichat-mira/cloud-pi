/**
 * T1: configuration, redaction and failure classification.
 *
 * These are pure tests: no network, no model, no credentials.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_KEYS,
  ConfigError,
  DEFAULT_LIMITS,
  classifyError,
  describeConfig,
  isToolAllowed,
  loadConfig,
  normalizeConfig,
  redactSecrets,
} from "../src/index.mjs";

const BASE_ENV = Object.freeze({
  CLOUD_PI_MODEL_BASE_URL: "https://mira-ai.example.com/v1",
  CLOUD_PI_MODEL_API_KEY: "sk-test-0123456789abcdef",
  CLOUD_PI_MODEL_ID: "test-model",
});

function env(overrides = {}) {
  return { ...BASE_ENV, ...overrides };
}

function configError(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error?.name}`);
    return error;
  }
  assert.fail("expected ConfigError");
}

describe("AGT-027 T1: model configuration", () => {
  test("loads a minimal environment and applies documented defaults", () => {
    const config = loadConfig(env());
    assert.equal(config.baseUrl, "https://mira-ai.example.com/v1");
    assert.equal(config.apiKey, BASE_ENV.CLOUD_PI_MODEL_API_KEY);
    assert.equal(config.modelId, "test-model");
    assert.equal(config.api, DEFAULT_LIMITS.api);
    assert.equal(config.providerId, DEFAULT_LIMITS.providerId);
    assert.equal(config.contextWindow, DEFAULT_LIMITS.contextWindow);
    assert.equal(config.maxOutputTokens, DEFAULT_LIMITS.maxOutputTokens);
    assert.equal(config.runTimeoutMs, DEFAULT_LIMITS.runTimeoutMs);
    assert.equal(config.maxToolCalls, DEFAULT_LIMITS.maxToolCalls);
    assert.ok(Object.isFrozen(config));
  });

  test("trims a trailing slash because Pi appends /chat/completions", () => {
    assert.equal(loadConfig(env({ CLOUD_PI_MODEL_BASE_URL: "https://example.com/v1///" })).baseUrl, "https://example.com/v1");
  });

  test("reports every missing required variable by name, never by value", () => {
    const error = configError(() => loadConfig({}));
    assert.equal(error.code, "config_error");
    for (const field of [CONFIG_KEYS.baseUrl, CONFIG_KEYS.apiKey, CONFIG_KEYS.modelId]) {
      assert.ok(error.fields.includes(field), `missing ${field}`);
      assert.ok(error.message.includes(field), `message mentions ${field}`);
    }
  });

  test("rejects an invalid base URL, unsupported API and non-numeric limits", () => {
    const error = configError(() =>
      loadConfig(
        env({
          CLOUD_PI_MODEL_BASE_URL: "ftp://example.com/v1",
          CLOUD_PI_MODEL_API: "anthropic-messages",
          CLOUD_PI_RUN_TIMEOUT_MS: "soon",
          CLOUD_PI_MAX_TOOL_CALLS: "many",
          CLOUD_PI_MODEL_CONTEXT_WINDOW: "512",
        }),
      ),
    );
    for (const field of [
      CONFIG_KEYS.baseUrl,
      CONFIG_KEYS.api,
      CONFIG_KEYS.runTimeoutMs,
      CONFIG_KEYS.maxToolCalls,
      CONFIG_KEYS.contextWindow,
    ]) {
      assert.ok(error.fields.includes(field), `invalid ${field}`);
    }
  });

  test("rejects credentials embedded in the base URL and output larger than the context", () => {
    const error = configError(() =>
      loadConfig(
        env({
          CLOUD_PI_MODEL_BASE_URL: "https://user:pass@example.com/v1",
          CLOUD_PI_MODEL_MAX_OUTPUT_TOKENS: "999999",
        }),
      ),
    );
    assert.ok(error.fields.includes(CONFIG_KEYS.baseUrl));
    assert.ok(error.fields.includes(CONFIG_KEYS.maxOutputTokens));
  });

  test("describeConfig is serializable and never contains the API key", () => {
    const config = loadConfig(env());
    const view = describeConfig(config);
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes(config.apiKey), false);
    assert.equal("apiKey" in view, false);
    assert.equal(view.modelId, "test-model");
  });

  test("redactSecrets removes the configured key, bearer headers and sk- tokens", () => {
    const key = BASE_ENV.CLOUD_PI_MODEL_API_KEY;
    const text = `auth=Bearer ${key} raw=${key} other=sk-othersecret123 and Authorization: ${key}`;
    const redacted = redactSecrets(text, [key]);
    assert.equal(redacted.includes(key), false);
    assert.equal(redacted.includes("sk-othersecret123"), false);
    assert.match(redacted, /\[redacted\]/);
  });

  test("redacts short secrets too", () => {
    assert.equal(redactSecrets("token=abc", ["abc"]), "token=[redacted]");
  });

  test("normalizeConfig re-validates injected objects and fills defaults", () => {
    const normalized = normalizeConfig({
      baseUrl: "https://mira-ai.example.com/v1",
      apiKey: "short",
      modelId: "test-model",
    });
    assert.equal(normalized.apiKey, "short");
    assert.equal(normalized.maxToolCalls, DEFAULT_LIMITS.maxToolCalls);
    assert.equal(normalized.runTimeoutMs, DEFAULT_LIMITS.runTimeoutMs);
    assert.ok(Object.isFrozen(normalized));

    const error = configError(() => normalizeConfig({ baseUrl: "https://example.com/v1", modelId: "m" }));
    assert.ok(error.fields.includes(CONFIG_KEYS.apiKey));
  });

  test("a modelId failure gets a modelId hint, not an integer range", () => {
    const error = configError(() => loadConfig(env({ CLOUD_PI_MODEL_ID: "x".repeat(201) })));
    assert.match(error.message, /CLOUD_PI_MODEL_ID must be a non-empty string/);
  });
});

describe("AGT-027 T1: failure classification", () => {
  const cases = [
    [Object.assign(new Error("401 Unauthorized"), { status: 401 }), "auth_error"],
    [Object.assign(new Error("403 forbidden"), { status: 403 }), "auth_error"],
    [Object.assign(new Error("404 model not found"), { status: 404 }), "model_not_found"],
    [Object.assign(new Error("429 slow down"), { status: 429 }), "rate_limit"],
    [Object.assign(new Error("503 upstream"), { status: 503 }), "provider_unavailable"],
    [Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }), "network_error"],
    [new Error("request aborted"), "cancelled"],
  ];

  for (const [error, code] of cases) {
    test(`classifies ${code}`, () => {
      assert.equal(classifyError(error).code, code);
    });
  }

  test("explicit timeout and cancellation win over message heuristics", () => {
    assert.equal(classifyError(new Error("socket hang up"), { timedOut: true }).code, "timeout");
    assert.equal(classifyError(new Error("boom"), { cancelled: true }).code, "cancelled");
  });

  test("classifies runtime policy codes", () => {
    assert.equal(classifyError(Object.assign(new Error("denied"), { code: "tool_not_granted" })).code, "tool_denied");
    assert.equal(
      classifyError(Object.assign(new Error("budget"), { code: "tool_budget_exhausted" })).code,
      "tool_budget_exhausted",
    );
  });

  test("never leaks a provider key embedded in an error message", () => {
    const key = BASE_ENV.CLOUD_PI_MODEL_API_KEY;
    const failure = classifyError(new Error(`401 invalid api key: ${key}`), { secrets: [key] });
    assert.equal(failure.code, "auth_error");
    assert.equal(failure.message.includes(key), false);
  });

  test("tool allowlist uses exact names and wildcards, and fails closed", () => {
    assert.equal(isToolAllowed("mcp__guanlan__guanlan_whoami", ["mcp__guanlan__*"]), true);
    assert.equal(isToolAllowed("mcp__guanlan__guanlan_delete", ["mcp__guanlan__guanlan_whoami"]), false);
    assert.equal(isToolAllowed("local_read_text", []), false);
    assert.equal(isToolAllowed("local_read_text", undefined), false);
  });
});
