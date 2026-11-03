/**
 * WeCom (企业微信智能机器人) channel configuration.
 *
 * Credentials are read from the environment only. They are never returned in a
 * printable form: `describeWecomConfig()` reports whether a value is configured,
 * never the value, and `WecomConfigError` never echoes a secret.
 *
 * Only the credentials and the deployment switches belong here. Model
 * configuration stays in `src/config.mjs` so the channel and the CLI share one
 * model contract.
 */

export const WECOM_CONFIG_KEYS = Object.freeze({
  BOT_ID: "WECOM_BOT_ID",
  BOT_SECRET: "WECOM_BOT_SECRET",
  /** Display name used to recognise `@<bot>` in group text (no structured mentions). */
  BOT_NAME: "WECOM_BOT_NAME",
  ALLOWED_USER_IDS: "WECOM_ALLOWED_USER_IDS",
  ALLOWED_CHAT_IDS: "WECOM_ALLOWED_CHAT_IDS",
  WS_URL: "WECOM_WS_URL",
  HEARTBEAT_INTERVAL_MS: "WECOM_HEARTBEAT_INTERVAL_MS",
  CONNECT_TIMEOUT_MS: "WECOM_CONNECT_TIMEOUT_MS",
  REPLY_MAX_BYTES: "WECOM_REPLY_MAX_BYTES",
  REPLY_TIMEOUT_MS: "WECOM_REPLY_TIMEOUT_MS",
});

/** Documented platform limit for one markdown/stream payload, in UTF-8 bytes. */
export const WECOM_MAX_CONTENT_BYTES = 20_480;

export const WECOM_DEFAULTS = Object.freeze({
  /**
   * Undefined means "let the official SDK use its own default endpoint"
   * (`wss://openws.work.weixin.qq.com` in `@wecom/aibot-node-sdk` 1.0.7).
   * Hardcoding an endpoint here would silently pin a value the SDK may change.
   */
  wsUrl: undefined,
  heartbeatIntervalMs: 30_000,
  connectTimeoutMs: 20_000,
  /** Headroom under the platform limit so the continuation suffix always fits. */
  replyMaxBytes: 20_000,
  replyTimeoutMs: 15_000,
});

export class WecomConfigError extends Error {
  constructor(fields, detail) {
    const list = Array.isArray(fields) ? fields : [fields];
    super(`Invalid WeCom channel configuration: ${detail ?? list.join(", ")}`);
    this.name = "WecomConfigError";
    this.code = "wecom_config_error";
    this.fields = Object.freeze(list.filter(Boolean));
  }
}

function readString(env, key) {
  const raw = env?.[key];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function readInteger(env, key, { min, max, fallback }) {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new WecomConfigError([key], `${key} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WecomConfigError([key], `${key} must be between ${min} and ${max}`);
  }
  return value;
}

function readIdList(env, key) {
  const raw = readString(env, key);
  if (raw === undefined) return Object.freeze([]);
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const invalid = parts.filter((part) => part.length > 128 || /\s/.test(part));
  if (invalid.length > 0) {
    throw new WecomConfigError([key], `${key} contains an invalid id`);
  }
  return Object.freeze([...new Set(parts)]);
}

/**
 * @param {Record<string,string|undefined>} [env]
 * @returns {Readonly<object>} frozen configuration; credentials included for
 *   transport use but never printed by `describe*`.
 */
export function loadWecomConfig(env = process.env) {
  const botId = readString(env, WECOM_CONFIG_KEYS.BOT_ID);
  const botSecret = readString(env, WECOM_CONFIG_KEYS.BOT_SECRET);
  const botName = readString(env, WECOM_CONFIG_KEYS.BOT_NAME);

  const missing = [];
  if (!botId) missing.push(WECOM_CONFIG_KEYS.BOT_ID);
  if (!botSecret) missing.push(WECOM_CONFIG_KEYS.BOT_SECRET);
  if (missing.length > 0) {
    throw new WecomConfigError(missing, `${missing.join(" and ")} must be set`);
  }

  // Absent means "use the official SDK's own default endpoint".
  const wsUrl = readString(env, WECOM_CONFIG_KEYS.WS_URL);
  if (wsUrl !== undefined && !/^wss?:\/\//i.test(wsUrl)) {
    throw new WecomConfigError([WECOM_CONFIG_KEYS.WS_URL], "WECOM_WS_URL must be a ws:// or wss:// URL");
  }

  const replyMaxBytes = readInteger(env, WECOM_CONFIG_KEYS.REPLY_MAX_BYTES, {
    min: 256,
    max: WECOM_MAX_CONTENT_BYTES,
    fallback: WECOM_DEFAULTS.replyMaxBytes,
  });

  return Object.freeze({
    botId,
    botSecret,
    botName,
    allowedUserIds: readIdList(env, WECOM_CONFIG_KEYS.ALLOWED_USER_IDS),
    allowedChatIds: readIdList(env, WECOM_CONFIG_KEYS.ALLOWED_CHAT_IDS),
    wsUrl,
    heartbeatIntervalMs: readInteger(env, WECOM_CONFIG_KEYS.HEARTBEAT_INTERVAL_MS, {
      min: 5_000,
      max: 300_000,
      fallback: WECOM_DEFAULTS.heartbeatIntervalMs,
    }),
    connectTimeoutMs: readInteger(env, WECOM_CONFIG_KEYS.CONNECT_TIMEOUT_MS, {
      min: 1_000,
      max: 120_000,
      fallback: WECOM_DEFAULTS.connectTimeoutMs,
    }),
    replyMaxBytes,
    replyTimeoutMs: readInteger(env, WECOM_CONFIG_KEYS.REPLY_TIMEOUT_MS, {
      min: 1_000,
      max: 60_000,
      fallback: WECOM_DEFAULTS.replyTimeoutMs,
    }),
  });
}

/**
 * Stable, non-reversible short label for a WeCom id.
 *
 * Enterprise `userid` values are stable employee identifiers (often an
 * initialism of a real name), so the Feishu "first 6 + last 4" mask is not
 * anonymisation here. A truncated SHA-256 lets two log lines be correlated
 * without exposing the identifier.
 */
export function hashId(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `id:${hash.toString(16).padStart(8, "0")}`;
}

/** Non-secret projection for logs and `GET /status`-style summaries. */
export function describeWecomConfig(config) {
  return Object.freeze({
    botIdConfigured: typeof config?.botId === "string" && config.botId.length > 0,
    botSecretConfigured: typeof config?.botSecret === "string" && config.botSecret.length > 0,
    botNameConfigured: typeof config?.botName === "string" && config.botName.length > 0,
    wsUrl: config?.wsUrl,
    allowedUserCount: config?.allowedUserIds?.length ?? 0,
    allowedChatCount: config?.allowedChatIds?.length ?? 0,
    replyMaxBytes: config?.replyMaxBytes,
    heartbeatIntervalMs: config?.heartbeatIntervalMs,
  });
}
