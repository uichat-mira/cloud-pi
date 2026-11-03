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
  /**
   * Optional fixed sentence sent to a rejected sender. Empty by default so a
   * rejection gives no signal at all; set it only when a deployment wants to tell
   * a colleague why the bot stayed silent.
   */
  DENIED_REPLY: "WECOM_DENIED_REPLY",
  WS_URL: "WECOM_WS_URL",
  HEARTBEAT_INTERVAL_MS: "WECOM_HEARTBEAT_INTERVAL_MS",
  CONNECT_TIMEOUT_MS: "WECOM_CONNECT_TIMEOUT_MS",
  REPLY_MAX_BYTES: "WECOM_REPLY_MAX_BYTES",
  REPLY_TIMEOUT_MS: "WECOM_REPLY_TIMEOUT_MS",
  /**
   * Two-phase replies (AGT-036 follow-up): the callback `req_id` is short-lived,
   * so the first message is an immediate acknowledgement and the answer is pushed
   * with `aibot_send_msg` afterwards. Disabling the ack restores the old
   * "answer inside the callback reply" behaviour for fast answers only.
   */
  ACK_ENABLED: "WECOM_ACK_ENABLED",
  ACK_TEXT: "WECOM_ACK_TEXT",
  /**
   * Ack merge window (ms). A chat answer that finishes inside this window is sent
   * alone: short questions must not get "收到" plus the answer (rubric A3a).
   * `0` restores "ack every accepted message".
   */
  ACK_MERGE_MS: "WECOM_ACK_MERGE_MS",
  /** Per-conversation segment caps for chat replies (rubric L2/L4). */
  SINGLE_MAX_SEGMENTS: "WECOM_SINGLE_MAX_SEGMENTS",
  GROUP_MAX_SEGMENTS: "WECOM_GROUP_MAX_SEGMENTS",
});

/** Documented platform limit for one markdown/stream payload, in UTF-8 bytes. */
export const WECOM_MAX_CONTENT_BYTES = 20_480;

/**
 * Default acknowledgement text (configurable via `WECOM_ACK_TEXT`).
 *
 * Rubric §3 A3b: a long task says what will happen next, not "收到，正在处理…".
 */
export const WECOM_DEFAULT_ACK_TEXT = "收到，这个要跑一会儿。跑完我直接发结论，中间不用等。";

/**
 * Platform error codes this channel can name precisely.
 *
 * - `93006`: the conversation is not known to the platform, i.e. the bot has
 *   never received a message from it. A proactive push cannot create it.
 * - `40058`: the payload exceeded the per-message limit.
 *
 * Both were observed in the real long-connection work for AGT-036 (see
 * `docs/engineering/agt-036-wecom-channel.md`); they are reported as codes so an
 * operator recognises the platform semantics instead of reading a generic
 * transport error.
 */
export const WECOM_PLATFORM_ERROR = Object.freeze({
  SESSION_UNKNOWN: 93006,
  PAYLOAD_TOO_LARGE: 40058,
});

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
  ackEnabled: true,
  /** A chat answer that finishes inside this window is sent without an ack. */
  ackMergeMs: 1_500,
  /** Chat replies: a direct chat may continue across 3 messages, a group stays 1. */
  singleMaxSegments: 3,
  groupMaxSegments: 1,
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

function readIdList(env, key) {  const raw = readString(env, key);
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

function readBool(env, key, fallback) {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new WecomConfigError([key], `${key} must be a boolean (1/0, true/false, yes/no, on/off)`);
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
    deniedReply: readString(env, WECOM_CONFIG_KEYS.DENIED_REPLY),
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
    ackEnabled: readBool(env, WECOM_CONFIG_KEYS.ACK_ENABLED, WECOM_DEFAULTS.ackEnabled),
    ackText: readString(env, WECOM_CONFIG_KEYS.ACK_TEXT) ?? WECOM_DEFAULT_ACK_TEXT,
    ackMergeMs: readInteger(env, WECOM_CONFIG_KEYS.ACK_MERGE_MS, {
      min: 0,
      max: 30_000,
      fallback: WECOM_DEFAULTS.ackMergeMs,
    }),
    singleMaxSegments: readInteger(env, WECOM_CONFIG_KEYS.SINGLE_MAX_SEGMENTS, {
      min: 1,
      max: 8,
      fallback: WECOM_DEFAULTS.singleMaxSegments,
    }),
    groupMaxSegments: readInteger(env, WECOM_CONFIG_KEYS.GROUP_MAX_SEGMENTS, {
      min: 1,
      max: 8,
      fallback: WECOM_DEFAULTS.groupMaxSegments,
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
    deniedReplyConfigured: typeof config?.deniedReply === "string" && config.deniedReply.length > 0,
    replyMaxBytes: config?.replyMaxBytes,
    replyTimeoutMs: config?.replyTimeoutMs,
    ackEnabled: config?.ackEnabled ?? true,
    ackMergeMs: config?.ackMergeMs,
    singleMaxSegments: config?.singleMaxSegments,
    groupMaxSegments: config?.groupMaxSegments,
    heartbeatIntervalMs: config?.heartbeatIntervalMs,
  });
}
