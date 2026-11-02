/**
 * Failure classification for Cloud Pi runs.
 *
 * Run records and CLI output use the classified shape only: a stable `code`,
 * a short redacted `message` and whether a caller may retry. Provider stacks and
 * request headers never leave this module.
 */
import { redactSecrets } from "./config.mjs";

const RETRYABLE = new Set(["rate_limit", "provider_unavailable", "network_error"]);

/** Error raised by the runtime itself; carries a stable machine-readable code. */
export class RuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "RuntimeError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }
}

function statusOf(error) {
  for (const value of [error?.status, error?.statusCode, error?.response?.status]) {
    if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  const match = /\b(4\d\d|5\d\d)\b/.exec(messageText(error));
  return match ? Number(match[1]) : undefined;
}

function messageText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message.length > 0) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function codeOf(error) {
  return typeof error?.code === "string" ? error.code : undefined;
}

/**
 * Classify any thrown value into a stable, safe failure record.
 *
 * `secrets` must contain the configured API key (and any other live credential)
 * so provider echoes cannot leak it into a run record.
 */
export function classifyError(error, { secrets = [], timedOut = false, cancelled = false, phase = "run" } = {}) {
  const raw = messageText(error);
  const message = redactSecrets(raw, secrets).replace(/\s+/g, " ").trim().slice(0, 800);
  const status = statusOf(error);

  const build = (code, extra = {}) => ({
    code,
    message: message || code,
    retryable: RETRYABLE.has(code),
    ...(status ? { status } : {}),
    ...extra,
  });

  if (timedOut) return build("timeout");
  if (cancelled) return build("cancelled");

  const explicit = codeOf(error);
  if (explicit === "config_error") return build("config_error");
  if (explicit === "tool_not_granted") return build("tool_denied");
  if (explicit === "tool_budget_exhausted") return build("tool_budget_exhausted");
  if (explicit === "aborted" || error?.name === "AbortError") return build("cancelled");
  if (explicit === "ETIMEDOUT" || /timed?\s*out/i.test(message)) return build("timeout");
  if (/aborted|cancell?ed/i.test(message)) return build("cancelled");

  if (status === 401 || status === 403) return build("auth_error");
  if (status === 404) return build("model_not_found");
  if (status === 429) return build("rate_limit");
  if (status === 408 || status === 504) return build("timeout");
  if (status && status >= 500) return build("provider_unavailable");
  if (status === 400) return build("invalid_request");

  if (explicit === "ENOTFOUND" || explicit === "ECONNREFUSED" || explicit === "ECONNRESET" || explicit === "EAI_AGAIN") {
    return build("network_error");
  }
  if (/unauthorized|invalid api key|invalid_api_key|authentication failed|incorrect api key|forbidden/i.test(message)) {
    return build("auth_error");
  }
  if (/model.*(not found|does not exist|unknown model)|unknown model/i.test(message)) {
    return build("model_not_found");
  }
  if (/rate limit|too many requests|quota|insufficient balance|insufficient_quota/i.test(message)) {
    return build("rate_limit");
  }
  if (/fetch failed|network|socket hang up|certificate|getaddrinfo/i.test(message)) {
    return build("network_error");
  }
  if (phase === "tool") return build("tool_error");
  if (phase === "config") return build("config_error");
  return build("provider_error");
}
