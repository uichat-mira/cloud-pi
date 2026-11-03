/**
 * Cloud Pi model configuration.
 *
 * The runtime is configured exclusively from the host environment. Secrets are
 * never persisted, logged or returned by these helpers: `describeConfig()` is
 * the only serializable view and it omits the API key entirely.
 */

/** Bumped when the environment contract changes in a breaking way. */
export const CONFIG_VERSION = 1;

/** APIs this runtime has actually implemented and verified. */
export const SUPPORTED_APIS = Object.freeze(["openai-completions"]);

export const CONFIG_KEYS = Object.freeze({
  baseUrl: "CLOUD_PI_MODEL_BASE_URL",
  apiKey: "CLOUD_PI_MODEL_API_KEY",
  modelId: "CLOUD_PI_MODEL_ID",
  api: "CLOUD_PI_MODEL_API",
  providerId: "CLOUD_PI_MODEL_PROVIDER_ID",
  contextWindow: "CLOUD_PI_MODEL_CONTEXT_WINDOW",
  maxOutputTokens: "CLOUD_PI_MODEL_MAX_OUTPUT_TOKENS",
  runTimeoutMs: "CLOUD_PI_RUN_TIMEOUT_MS",
  maxToolCalls: "CLOUD_PI_MAX_TOOL_CALLS",
});

export const DEFAULT_LIMITS = Object.freeze({
  api: "openai-completions",
  providerId: "cloud-pi-live",
  contextWindow: 131_072,
  maxOutputTokens: 4_096,
  runTimeoutMs: 120_000,
  maxToolCalls: 8,
});

const BOUNDS = Object.freeze({
  contextWindow: { min: 1_024, max: 10_000_000 },
  maxOutputTokens: { min: 1, max: 1_000_000 },
  runTimeoutMs: { min: 1_000, max: 86_400_000 },
  maxToolCalls: { min: 0, max: 1_000 },
});

/** A configuration problem the operator can fix; never contains secret values. */
export class ConfigError extends Error {
  constructor(fields, detail) {
    const summary = detail ?? `Cloud Pi model configuration is incomplete or invalid (${fields.join(", ")})`;
    super(summary);
    this.name = "ConfigError";
    this.code = "config_error";
    this.fields = Object.freeze([...fields]);
  }
}

function present(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseBaseUrl(raw, fields) {
  const value = present(raw);
  if (!value) {
    fields.push(CONFIG_KEYS.baseUrl);
    return undefined;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fields.push(CONFIG_KEYS.baseUrl);
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fields.push(CONFIG_KEYS.baseUrl);
    return undefined;
  }
  if (url.username || url.password) {
    fields.push(CONFIG_KEYS.baseUrl);
    return undefined;
  }
  if (url.search || url.hash) {
    fields.push(CONFIG_KEYS.baseUrl);
    return undefined;
  }
  // The Pi OpenAI-completions adapter appends `/chat/completions` itself.
  return value.replace(/\/+$/, "");
}

function parseInteger(raw, fallback, { name, min, max }, fields) {
  const value = present(raw);
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) {
    fields.push(name);
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fields.push(name);
    return undefined;
  }
  return parsed;
}

/**
 * Build and validate the runtime configuration from an environment-like object.
 *
 * Throws `ConfigError` listing every offending variable name (never values).
 */
export function loadConfig(env = process.env) {
  const fields = [];

  const baseUrl = parseBaseUrl(env[CONFIG_KEYS.baseUrl], fields);

  const apiKey = present(env[CONFIG_KEYS.apiKey]);
  if (!apiKey) fields.push(CONFIG_KEYS.apiKey);

  const modelId = present(env[CONFIG_KEYS.modelId]);
  if (!modelId || modelId.length > 200) fields.push(CONFIG_KEYS.modelId);

  const api = present(env[CONFIG_KEYS.api]) || DEFAULT_LIMITS.api;
  if (!SUPPORTED_APIS.includes(api)) fields.push(CONFIG_KEYS.api);

  const providerId = present(env[CONFIG_KEYS.providerId]) || DEFAULT_LIMITS.providerId;
  if (!/^[A-Za-z0-9._-]+$/.test(providerId) || providerId.length > 100) fields.push(CONFIG_KEYS.providerId);

  const contextWindow = parseInteger(
    env[CONFIG_KEYS.contextWindow],
    DEFAULT_LIMITS.contextWindow,
    { name: CONFIG_KEYS.contextWindow, ...BOUNDS.contextWindow },
    fields,
  );
  const maxOutputTokens = parseInteger(
    env[CONFIG_KEYS.maxOutputTokens],
    DEFAULT_LIMITS.maxOutputTokens,
    { name: CONFIG_KEYS.maxOutputTokens, ...BOUNDS.maxOutputTokens },
    fields,
  );
  if (contextWindow && maxOutputTokens && maxOutputTokens > contextWindow) {
    fields.push(CONFIG_KEYS.maxOutputTokens);
  }
  const runTimeoutMs = parseInteger(
    env[CONFIG_KEYS.runTimeoutMs],
    DEFAULT_LIMITS.runTimeoutMs,
    { name: CONFIG_KEYS.runTimeoutMs, ...BOUNDS.runTimeoutMs },
    fields,
  );
  const maxToolCalls = parseInteger(
    env[CONFIG_KEYS.maxToolCalls],
    DEFAULT_LIMITS.maxToolCalls,
    { name: CONFIG_KEYS.maxToolCalls, ...BOUNDS.maxToolCalls },
    fields,
  );

  if (fields.length > 0) {
    throw new ConfigError(fields, describeConfigProblem(fields, env));
  }

  return deepFreeze({
    version: CONFIG_VERSION,
    baseUrl,
    apiKey,
    modelId,
    api,
    providerId,
    contextWindow,
    maxOutputTokens,
    runTimeoutMs,
    maxToolCalls,
  });
}

function describeConfigProblem(fields, env) {
  const hints = fields.map((field) => {
    const raw = present(env[field]);
    if (!raw) return `${field} is required`;
    switch (field) {
      case CONFIG_KEYS.baseUrl:
        return `${field} must be an http(s) URL without credentials, query or fragment`;
      case CONFIG_KEYS.api:
        return `${field} must be one of: ${SUPPORTED_APIS.join(", ")}`;
      case CONFIG_KEYS.providerId:
        return `${field} may contain only letters, digits, dot, underscore and dash`;
      case CONFIG_KEYS.maxOutputTokens:
        return `${field} must be a positive integer no larger than ${CONFIG_KEYS.contextWindow}`;
      case CONFIG_KEYS.modelId:
        return `${field} must be a non-empty string no longer than 200 characters`;
      default:
        return `${field} must be an integer within ${BOUNDS[fieldKey(field)]?.min ?? 0}..${BOUNDS[fieldKey(field)]?.max ?? "?"}`;
    }
  });
  return `Invalid Cloud Pi model configuration: ${hints.join("; ")}`;
}

function fieldKey(field) {
  for (const [key, name] of Object.entries(CONFIG_KEYS)) {
    if (name === field) return key;
  }
  return field;
}

/**
 * Re-validate and normalize an injected config object through the same rules
 * used for environment input, filling defaults and rejecting missing secrets.
 */
export function normalizeConfig(config) {
  if (!config || typeof config !== "object") {
    throw new TypeError("config must be an object");
  }
  const value = (input) => (input === undefined || input === null ? undefined : String(input));
  return loadConfig({
    [CONFIG_KEYS.baseUrl]: value(config.baseUrl),
    [CONFIG_KEYS.apiKey]: value(config.apiKey),
    [CONFIG_KEYS.modelId]: value(config.modelId),
    [CONFIG_KEYS.api]: value(config.api),
    [CONFIG_KEYS.providerId]: value(config.providerId),
    [CONFIG_KEYS.contextWindow]: value(config.contextWindow),
    [CONFIG_KEYS.maxOutputTokens]: value(config.maxOutputTokens),
    [CONFIG_KEYS.runTimeoutMs]: value(config.runTimeoutMs),
    [CONFIG_KEYS.maxToolCalls]: value(config.maxToolCalls),
  });
}

/**
 * A serializable view safe to print or attach to a run record.
 * The API key is intentionally absent, not masked.
 */
export function describeConfig(config) {
  return {
    version: config.version,
    providerId: config.providerId,
    modelId: config.modelId,
    api: config.api,
    baseUrl: config.baseUrl,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
    runTimeoutMs: config.runTimeoutMs,
    maxToolCalls: config.maxToolCalls,
  };
}

/** Remove credentials from arbitrary text before it reaches a log or a report. */
export function redactSecrets(text, secrets = []) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-[redacted]");
  out = out.replace(/\b(api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return out;
}

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") deepFreeze(nested);
  }
  return Object.freeze(value);
}
