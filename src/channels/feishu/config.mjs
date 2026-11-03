/**
 * Feishu channel configuration.
 *
 * The channel is configured from the host environment only. The app secret is
 * never persisted, logged or returned by `describeFeishuConfig()`; every
 * validation error names the offending variable, never its value.
 *
 * Group authorization is a local, trusted POC allowlist (`FEISHU_ALLOWED_CHAT_IDS`).
 * It is not Cloud Auth authorization and it grants no member any account,
 * Guanlan or tool privilege.
 *
 * Fail closed: an invalid or incomplete configuration stops the process before
 * it connects, and a group message from a chat that is not listed is ignored.
 */

export const FEISHU_CONFIG_KEYS = Object.freeze({
  appId: "FEISHU_APP_ID",
  appSecret: "FEISHU_APP_SECRET",
  allowedChatIds: "FEISHU_ALLOWED_CHAT_IDS",
  botOpenId: "FEISHU_BOT_OPEN_ID",
  domain: "FEISHU_DOMAIN",
});

/** Only the domains this adapter has actually been written against. */
export const SUPPORTED_DOMAINS = Object.freeze(["feishu", "lark"]);

const APP_ID = /^cli_[A-Za-z0-9]+$/;
const OPEN_ID = /^ou_[A-Za-z0-9]+$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;

/** A configuration problem the operator can fix; never contains secret values. */
export class FeishuConfigError extends Error {
  constructor(fields, detail) {
    super(detail ?? `Feishu channel configuration is incomplete or invalid (${fields.join(", ")})`);
    this.name = "FeishuConfigError";
    this.code = "feishu_config_error";
    this.fields = Object.freeze([...fields]);
  }
}

function present(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseAllowedChatIds(raw, fields) {
  const value = present(raw);
  if (!value) return [];
  const entries = value.split(/[\s,;]+/).filter(Boolean);
  const ids = [];
  let invalid = false;
  for (const entry of entries) {
    if (!CHAT_ID.test(entry)) {
      invalid = true;
      continue;
    }
    if (!ids.includes(entry)) ids.push(entry);
  }
  if (invalid) fields.push(FEISHU_CONFIG_KEYS.allowedChatIds);
  return ids;
}

/**
 * Build and validate the channel configuration from an environment-like object.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{appId:string, appSecret:string, domain:"feishu"|"lark", allowedChatIds:string[], botOpenId:string|undefined}}
 */
export function loadFeishuConfig(env = process.env) {
  const fields = [];

  const appId = present(env[FEISHU_CONFIG_KEYS.appId]);
  if (!APP_ID.test(appId)) fields.push(FEISHU_CONFIG_KEYS.appId);

  const appSecret = present(env[FEISHU_CONFIG_KEYS.appSecret]);
  if (!appSecret || appSecret.length > 256 || /\s/.test(appSecret)) {
    fields.push(FEISHU_CONFIG_KEYS.appSecret);
  }

  const domain = present(env[FEISHU_CONFIG_KEYS.domain]) || "feishu";
  if (!SUPPORTED_DOMAINS.includes(domain)) fields.push(FEISHU_CONFIG_KEYS.domain);

  const allowedChatIds = parseAllowedChatIds(env[FEISHU_CONFIG_KEYS.allowedChatIds], fields);

  const botOpenId = present(env[FEISHU_CONFIG_KEYS.botOpenId]) || undefined;
  if (botOpenId !== undefined && !OPEN_ID.test(botOpenId)) fields.push(FEISHU_CONFIG_KEYS.botOpenId);

  if (fields.length > 0) {
    throw new FeishuConfigError(fields, describeProblem(fields));
  }

  return Object.freeze({
    appId,
    appSecret,
    domain,
    allowedChatIds: Object.freeze(allowedChatIds),
    botOpenId,
  });
}

function describeProblem(fields) {
  const hints = fields.map((field) => {
    switch (field) {
      case FEISHU_CONFIG_KEYS.appId:
        return `${field} must be a Feishu app id starting with "cli_"`;
      case FEISHU_CONFIG_KEYS.appSecret:
        return `${field} is required and must not contain whitespace`;
      case FEISHU_CONFIG_KEYS.allowedChatIds:
        return `${field} must be a comma/space separated list of chat ids starting with "oc_"`;
      case FEISHU_CONFIG_KEYS.botOpenId:
        return `${field} must be a Feishu open id starting with "ou_"`;
      case FEISHU_CONFIG_KEYS.domain:
        return `${field} must be one of: ${SUPPORTED_DOMAINS.join(", ")}`;
      default:
        return `${field} is invalid`;
    }
  });
  return `Invalid Feishu channel configuration: ${hints.join("; ")}`;
}

/**
 * A serializable view safe to print or attach to a log.
 * The app secret is intentionally absent, not masked.
 */
export function describeFeishuConfig(config) {
  return {
    appId: config.appId,
    domain: config.domain,
    allowedChatCount: config.allowedChatIds.length,
    botOpenIdConfigured: Boolean(config.botOpenId),
  };
}

/**
 * Mask an identifier for evidence: keep a short prefix and suffix so an operator
 * can correlate it locally without publishing the full id.
 */
export function maskId(value, { head = 6, tail = 4 } = {}) {
  if (typeof value !== "string" || value.length <= head + tail + 1) return value ?? "";
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
