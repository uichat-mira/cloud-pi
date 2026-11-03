/**
 * Frozen, versioned contract for the Cloud Pi local management API (AGT-034).
 *
 * This is a *thin control plane*: the HTTP layer validates a request, calls the
 * existing Scheduler / Research public modules, and projects a reviewed subset
 * of the result. It never reads or writes schedule/run JSON files itself and it
 * never owns a second copy of task state.
 *
 * The API is intentionally local-only. There is no account system, token
 * scheme, CORS policy or public listener in this contract; Cloud Auth
 * delegation belongs to a later card.
 */

/** Bump when a route, field or status meaning changes incompatibly. */
export const API_CONTRACT_VERSION = 1;

export const API_PREFIX = "/v1";

/** Bind policy: literal loopback addresses only (no hostname resolution). */
export const DEFAULT_API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 8787;
export const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "::1"]);

export const API_LIMITS = Object.freeze({
  /** Request bodies are small JSON control documents, never artifacts. */
  maxBodyBytes: 64 * 1024,
  defaultRunListLimit: 50,
  maxRunListLimit: 100,
  /** Triggers returned by default in a schedule detail. */
  maxRecentTriggers: 20,
  /** Sources returned by a report read. */
  maxReportSources: 100,
  /** Bounded drain when the server stops. */
  defaultShutdownTimeoutMs: 2_000,
});

/**
 * Stable machine-readable failure classes. `status` is the HTTP status; the
 * `code` is what clients branch on.
 */
export const API_ERROR = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  BUSY: "busy",
  INTERNAL_ERROR: "internal_error",
  METHOD_NOT_ALLOWED: "method_not_allowed",
  UNSUPPORTED_MEDIA_TYPE: "unsupported_media_type",
  PAYLOAD_TOO_LARGE: "payload_too_large",
});

export const API_HTTP_STATUS = Object.freeze({
  [API_ERROR.INVALID_REQUEST]: 400,
  [API_ERROR.NOT_FOUND]: 404,
  [API_ERROR.CONFLICT]: 409,
  [API_ERROR.BUSY]: 503,
  [API_ERROR.INTERNAL_ERROR]: 500,
  [API_ERROR.METHOD_NOT_ALLOWED]: 405,
  [API_ERROR.UNSUPPORTED_MEDIA_TYPE]: 415,
  [API_ERROR.PAYLOAD_TOO_LARGE]: 413,
});

/** API error carrying a stable code and a caller-safe message. */
export class ApiError extends Error {
  /**
   * @param {string} code one of API_ERROR
   * @param {string} message caller-safe message (never a stack/path/secret)
   * @param {{ cause?: unknown, headers?: Record<string,string> }} [options]
   */
  constructor(code, message, { cause, headers } = {}) {
    super(message, { cause });
    this.name = "ApiError";
    this.code = code;
    this.status = API_HTTP_STATUS[code] ?? 500;
    this.headers = headers ?? {};
  }
}

export function apiErrorRecord(code, message) {
  const stableCode = API_HTTP_STATUS[code] ? code : API_ERROR.INTERNAL_ERROR;
  return { code: stableCode, message: String(message ?? "") };
}

export function isApiErrorCode(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(API_HTTP_STATUS, value);
}
