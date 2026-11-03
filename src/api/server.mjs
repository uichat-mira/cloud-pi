/**
 * HTTP server plumbing for the local management API.
 *
 * Built on `node:http` only. The server:
 *
 * - refuses every non-loopback bind before a socket exists (see `policy.mjs`);
 * - parses a small JSON body with a hard size cap;
 * - returns the versioned JSON envelope produced by `router.mjs`;
 * - logs only method, route template, status, duration and request id — never
 *   bodies, headers, query values or error messages;
 * - on stop, stops accepting new connections, drains in-flight requests for a
 *   bounded time, then force-closes the remaining sockets.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { API_ERROR, API_LIMITS, ApiError, DEFAULT_API_HOST, DEFAULT_API_PORT, apiErrorRecord } from "./contracts.mjs";
import { createApiController } from "./controller.mjs";
import { formatListenAddress, normalizeApiHost, normalizeApiPort } from "./policy.mjs";
import { createApiRouter } from "./router.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentTypeIsJson(value) {
  return typeof value === "string" && /^application\/json\b/i.test(value.trim());
}

/**
 * Read a bounded JSON control body.
 *
 * @returns {Promise<unknown>} `undefined` when the request has no body
 */
async function readJsonBody(req, maxBodyBytes) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    throw new ApiError(API_ERROR.PAYLOAD_TOO_LARGE, `request body must not exceed ${maxBodyBytes} bytes`);
  }

  const chunks = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) {
    throw new ApiError(API_ERROR.PAYLOAD_TOO_LARGE, `request body must not exceed ${maxBodyBytes} bytes`);
  }
  if (total === 0) return undefined;
  if (!contentTypeIsJson(req.headers["content-type"])) {
    throw new ApiError(API_ERROR.UNSUPPORTED_MEDIA_TYPE, "request body must be application/json");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(API_ERROR.INVALID_REQUEST, "request body is not valid JSON");
  }
}

/**
 * Create one local management API instance bound to an existing scheduler.
 *
 * @param {object} options
 * @param {object} options.scheduler `createScheduler()` instance
 * @param {string} [options.runsDir] research run root (AGT-028 resolves the default)
 * @param {Record<string,string>} [options.env]
 * @param {string} [options.host] must be 127.0.0.1 or ::1
 * @param {number} [options.port] 0 asks the OS for an ephemeral port
 * @param {object} [options.logger] `{ info?, warn? }`, observation only
 * @param {number} [options.shutdownTimeoutMs]
 * @param {() => Date} [options.now]
 */
export function createManagementApi(options = {}) {
  const host = normalizeApiHost(options.host ?? DEFAULT_API_HOST);
  const port = normalizeApiPort(options.port ?? DEFAULT_API_PORT);
  const shutdownTimeoutMs = Number.isFinite(options.shutdownTimeoutMs)
    ? Math.max(50, options.shutdownTimeoutMs)
    : API_LIMITS.defaultShutdownTimeoutMs;
  const logger = options.logger ?? {};

  const delivering = options.deliveringScheduler ?? null;
  if (delivering && options.scheduler && options.scheduler !== delivering.scheduler) {
    throw new TypeError("scheduler must match deliveringScheduler.scheduler");
  }
  const controller = createApiController({
    scheduler: delivering?.scheduler ?? options.scheduler,
    getRunDelivery: typeof delivering?.getRunDelivery === "function"
      ? (runId) => delivering.getRunDelivery(runId)
      : null,
    runsDir: options.runsDir,
    env: options.env,
    now: options.now,
    logger,
  });
  const router = createApiRouter({ controller });

  let server = null;
  let listenAddress = null;
  let startPromise = null;
  let stopPromise = null;
  let closing = false;
  const inFlight = new Set();

  async function handle(req, res) {
    const startedAt = Date.now();
    const requestId = randomBytes(6).toString("hex");
    const entry = { requestId, route: "unmatched" };
    inFlight.add(entry);
    let status = 500;
    let route = "unmatched";

    const write = (result) => {
      status = result.status;
      route = result.route ?? route;
      if (res.writableEnded || res.destroyed) return;
      const payload = JSON.stringify(result.body);
      res.writeHead(result.status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
        ...result.headers,
      });
      res.end(payload);
    };

    try {
      if (closing) {
        write({
          status: 503,
          route: "shutdown",
          body: { ok: false, error: apiErrorRecord(API_ERROR.BUSY, "server is shutting down") },
          headers: { connection: "close" },
        });
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const query = Object.fromEntries(url.searchParams.entries());
      const body = req.method === "POST" || req.method === "PATCH" ? await readJsonBody(req, API_LIMITS.maxBodyBytes) : undefined;
      const result = await router.dispatch({
        method: req.method,
        pathname: url.pathname,
        query,
        body,
      });
      write(result);
    } catch (error) {
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(API_ERROR.INTERNAL_ERROR, "internal error", { cause: error });
      if (apiError.code === API_ERROR.INTERNAL_ERROR) {
        logger.warn?.(`api: internal error (${error?.name ?? "Error"})`);
      }
      write({
        status: apiError.status,
        body: { ok: false, error: apiErrorRecord(apiError.code, apiError.message) },
        headers: apiError.headers,
      });
    } finally {
      inFlight.delete(entry);
      logger.info?.(`api: ${req.method ?? "?"} ${route} -> ${status} (${Date.now() - startedAt}ms) request ${requestId}`);
    }
  }

  async function start() {
    if (stopPromise) {
      throw new ApiError(API_ERROR.CONFLICT, "this management API instance was stopped; create a new instance");
    }
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const httpServer = createServer((req, res) => {
        void handle(req, res);
      });
      httpServer.on("clientError", (_error, socket) => {
        if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
      });
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            httpServer.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            httpServer.off("error", onError);
            resolve();
          };
          httpServer.once("error", onError);
          httpServer.once("listening", onListening);
          httpServer.listen({ host, port });
        });
      } catch (error) {
        throw new ApiError(
          API_ERROR.INVALID_REQUEST,
          `cannot listen on ${host}:${port} (${error?.code ?? "listen error"})`,
          { cause: error },
        );
      }
      server = httpServer;
      listenAddress = formatListenAddress(httpServer.address());
      logger.info?.(`api: listening on ${listenAddress.url} (loopback only)`);
      return listenAddress;
    })();
    return startPromise;
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    closing = true;
    stopPromise = (async () => {
      // A stop that races the initial bind must still own the resulting
      // listener, otherwise the process would keep an unreachable server.
      if (startPromise && !server) await startPromise.catch(() => {});
      const httpServer = server;
      if (!httpServer) {
        return { stopped: true, forced: false };
      }
      const closed = new Promise((resolve) => httpServer.close(() => resolve()));
      httpServer.closeIdleConnections?.();

      const deadline = Date.now() + shutdownTimeoutMs;
      while (inFlight.size > 0 && Date.now() < deadline) await sleep(10);
      const forced = inFlight.size > 0;
      if (forced) httpServer.closeAllConnections?.();
      else httpServer.closeIdleConnections?.();
      await Promise.race([closed, sleep(Math.max(100, shutdownTimeoutMs))]);

      server = null;
      listenAddress = null;
      logger.info?.(`api: stopped (${forced ? "forced" : "drained"})`);
      return { stopped: true, forced };
    })();
    return stopPromise;
  }

  return {
    start,
    stop,
    get address() {
      return listenAddress;
    },
    get listening() {
      return Boolean(server?.listening);
    },
    router,
    controller,
  };
}
