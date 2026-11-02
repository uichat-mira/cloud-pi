/**
 * Bounded HTTP client for research tools.
 *
 * Everything the tools fetch goes through here so the limits and failure
 * taxonomy stay in one place:
 *
 * - per-attempt timeout (`LIMITS.requestTimeoutMs`), linked to the caller's
 *   AbortSignal;
 * - manual redirect chain (max 5) with a re-check hook so redirect targets are
 *   re-validated (SSRF cannot be smuggled through a 302);
 * - streaming byte cap (2 MB): the body is aborted as soon as it grows past the
 *   cap, never buffered whole;
 * - `gzip`/`br`/`deflate` decoding before the cap is applied;
 * - HTTPS proxy from `RESEARCH_HTTPS_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY`
 *   (honouring `NO_PROXY`, and never proxying loopback);
 * - one retry, only for 429/5xx, never for timeouts or cancellation.
 *
 * Failure classification is always a `contracts.ERROR_CODE`; response and
 * request headers that can carry credentials (`authorization`, `cookie`,
 * `set-cookie`, `proxy-authorization`) are never read back, logged or returned.
 */
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { ProxyAgent, request } from "undici";
import { ERROR_CODE, LIMITS } from "../contracts.mjs";
import { normalizeHostname } from "./url-safety.mjs";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const RETRY_DELAY_MS = 200;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Headers that are safe to retain for diagnostics. */
export const SAFE_HEADERS = Object.freeze([
  "cache-control",
  "content-encoding",
  "content-language",
  "content-length",
  "content-type",
  "date",
  "etag",
  "last-modified",
  "location",
  "server",
  "vary",
]);

/** Classified transport failure carrying a `contracts.ERROR_CODE`. */
export class HttpError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.retryable = meta.retryable ?? false;
    this.status = meta.status ?? null;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

/** Build the AbortError that Pi tool callers expect when cancelled. */
export function abortError(message = "Operation aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = ERROR_CODE.ABORTED;
  return error;
}

/** True when the error means "the caller cancelled us". */
export function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === ERROR_CODE.ABORTED;
}

/** Drop every header that could carry credentials. */
export function sanitizeHeaders(headers = {}) {
  const out = {};
  for (const name of SAFE_HEADERS) {
    const value = headers[name] ?? headers[name.toUpperCase()];
    if (value === undefined || value === null) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/** Map an HTTP status to the frozen error taxonomy, or `null` for 2xx/3xx. */
export function classifyHttpStatus(status) {
  if (status === 429) return { code: ERROR_CODE.RATE_LIMITED, retryable: true };
  if (status === 408) return { code: ERROR_CODE.TIMEOUT, retryable: true };
  if (status >= 500) return { code: ERROR_CODE.HTTP_ERROR, retryable: true };
  if (status >= 400) return { code: ERROR_CODE.HTTP_ERROR, retryable: false };
  return null;
}

/** Map a Node/undici transport error to the frozen error taxonomy. */
export function classifyNetworkError(error) {
  if (!error) return { code: ERROR_CODE.CONNECT_ERROR, retryable: false };
  if (isAbortError(error)) return { code: ERROR_CODE.ABORTED, retryable: false };
  if (error instanceof HttpError) return { code: error.code, retryable: error.retryable };
  const text = [error.code, error.name, error.cause?.code, error.cause?.name]
    .filter(Boolean)
    .join(" ");
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO|ERR_TLS/i.test(text)) {
    return { code: ERROR_CODE.TLS_ERROR, retryable: false };
  }
  if (/ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME|ENODATA/i.test(text)) {
    return { code: ERROR_CODE.DNS_ERROR, retryable: /EAI_AGAIN/.test(text) };
  }
  if (/ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|TIMEOUT/i.test(text)) {
    return { code: ERROR_CODE.TIMEOUT, retryable: true };
  }
  if (
    /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET|ECONNABORTED|ENETDOWN/i.test(
      text,
    )
  ) {
    return { code: ERROR_CODE.CONNECT_ERROR, retryable: /ECONNRESET/.test(text) };
  }
  return { code: ERROR_CODE.CONNECT_ERROR, retryable: false };
}

/** Redacted one-line description of a transport error (never headers/URLs). */
export function describeNetworkError(error) {
  const code = error?.code ?? error?.cause?.code ?? error?.name ?? "unknown_error";
  const message = String(error?.cause?.message ?? error?.message ?? error);
  return `${code}: ${message}`.slice(0, 300);
}

function isLoopbackHost(hostname) {
  const host = normalizeHostname(hostname);
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function matchesNoProxy(hostname, noProxy) {
  const host = normalizeHostname(hostname);
  for (const rawEntry of String(noProxy ?? "").split(",")) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const withoutPort = entry.replace(/:\d+$/, "").replace(/^\[/, "").replace(/\]$/, "");
    if (!withoutPort) continue;
    const bare = withoutPort.startsWith(".") ? withoutPort.slice(1) : withoutPort;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/**
 * Proxy URL for a host, or `null`. `RESEARCH_HTTPS_PROXY` wins over the generic
 * variables so the research tools can be isolated from ambient proxy settings.
 * Loopback destinations always bypass the proxy: a proxy cannot reach the
 * caller's own fixture server anyway.
 */
export function proxyUrlFor(hostname, env = process.env) {
  if (isLoopbackHost(hostname)) return null;
  const raw =
    env.RESEARCH_HTTPS_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "";
  if (!raw) return null;
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? "";
  if (matchesNoProxy(hostname, noProxy)) return null;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

const proxyAgents = new Map();

function dispatcherFor(proxyUrl) {
  if (!proxyUrl) return undefined;
  let agent = proxyAgents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgents.set(proxyUrl, agent);
  }
  return agent;
}

function decodeStream(body, contentEncoding) {
  const encoding = String(contentEncoding ?? "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && part !== "identity")
    .pop();
  if (encoding === "gzip" || encoding === "x-gzip") return body.pipe(createGunzip());
  if (encoding === "deflate") return body.pipe(createInflate());
  if (encoding === "br") return body.pipe(createBrotliDecompress());
  return body;
}

async function readBounded(body, { maxBytes, contentEncoding }) {
  if (!body) return { buffer: Buffer.alloc(0), bytes: 0 };
  const stream = decodeStream(body, contentEncoding);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy?.();
        throw new HttpError(ERROR_CODE.TOO_LARGE, `Response body exceeded the ${maxBytes} byte cap`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    body.destroy?.();
    stream.destroy?.();
    throw error;
  }
  return { buffer: Buffer.concat(chunks), bytes: size };
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestOnce(url, options) {
  const {
    method,
    headers,
    signal,
    timeoutMs,
    maxBytes,
    requestImpl,
    dispatcher,
  } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  timer.unref?.();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw abortError();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await requestImpl(url.href, {
      method,
      headers,
      signal: controller.signal,
      maxRedirections: 0,
      dispatcher,
    });
    const contentType = String(response.headers["content-type"] ?? "");
    const contentEncoding = String(response.headers["content-encoding"] ?? "");
    const { buffer, bytes } = await readBounded(response.body, { maxBytes, contentEncoding });
    return {
      status: response.statusCode,
      headers: sanitizeHeaders(response.headers),
      contentType,
      buffer,
      bytes,
      url: url.href,
    };
  } catch (error) {
    if (timedOut) {
      throw new HttpError(ERROR_CODE.TIMEOUT, `Request timed out after ${Math.max(1, timeoutMs)}ms`, {
        retryable: true,
        cause: error,
      });
    }
    if (signal?.aborted) throw abortError();
    if (error instanceof HttpError) throw error;
    const { code, retryable } = classifyNetworkError(error);
    throw new HttpError(code, describeNetworkError(error), { retryable, cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Perform a bounded GET (or other method) with manual redirects.
 *
 * @param {string} rawUrl
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs] Per attempt.
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxRedirects]
 * @param {(url: URL) => Promise<void>|void} [options.checkUrl] Runs before every hop (URL safety).
 * @param {boolean} [options.retryTransient] Single retry on 429/5xx. Default true.
 * @param {typeof request} [options.request] Injectable transport (tests).
 * @param {string|null} [options.proxyUrl] Override proxy detection.
 * @param {Record<string,string>} [options.env]
 * @returns {Promise<{status:number, ok:boolean, headers:Record<string,string>,
 *   contentType:string, buffer:Buffer, bytes:number, finalUrl:string,
 *   redirects:string[], elapsedMs:number}>}
 */
export async function requestBounded(rawUrl, options = {}) {
  const started = Date.now();
  const {
    signal,
    method = "GET",
    headers: callerHeaders = {},
    maxBytes = MAX_BODY_BYTES,
    maxRedirects = MAX_REDIRECTS,
    timeoutMs = LIMITS.requestTimeoutMs.default,
    checkUrl,
    retryTransient = true,
    requestImpl = request,
    proxyUrl = undefined,
    env = process.env,
  } = options;

  let current;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new HttpError(ERROR_CODE.INVALID_URL, "Malformed URL");
  }
  const redirects = [];
  let retried = false;
  const requestHeaders = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "accept-encoding": "gzip, br, deflate",
    "user-agent": "cloud-pi-research/1.0 (read-only research tool)",
    ...callerHeaders,
  };

  for (;;) {
    if (signal?.aborted) throw abortError();
    if (typeof checkUrl === "function") await checkUrl(current);
    const effectiveProxy = proxyUrl === undefined ? proxyUrlFor(current.hostname, env) : proxyUrl;
    const response = await requestOnce(current, {
      method,
      headers: requestHeaders,
      signal,
      timeoutMs,
      maxBytes,
      requestImpl,
      dispatcher: dispatcherFor(effectiveProxy),
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.location;
      response.buffer = null;
      if (!location) {
        throw new HttpError(ERROR_CODE.HTTP_ERROR, `Redirect ${response.status} without a Location header`, {
          status: response.status,
        });
      }
      if (redirects.length >= maxRedirects) {
        throw new HttpError(ERROR_CODE.HTTP_ERROR, `Too many redirects (limit ${maxRedirects})`, {
          status: response.status,
        });
      }
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new HttpError(ERROR_CODE.HTTP_ERROR, "Redirect Location is not a valid URL", {
          status: response.status,
        });
      }
      redirects.push(next.href);
      current = next;
      continue;
    }

    const statusError = classifyHttpStatus(response.status);
    if (statusError && retryTransient && !retried) {
      retried = true;
      await sleepAbortable(RETRY_DELAY_MS, signal);
      continue;
    }

    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: response.headers,
      contentType: response.contentType,
      buffer: response.buffer,
      bytes: response.bytes,
      finalUrl: current.href,
      redirects,
      elapsedMs: Date.now() - started,
    };
  }
}
