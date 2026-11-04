/** Owner-only portal bridge. Unauthenticated AGT-034 stays on loopback. */
import { createServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

const SESSION = /^Bearer mcs_v1\.[A-Za-z0-9._-]{12,1024}$/;
const ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const MAX_BODY = 16_384;

function localOrigin(input) {
  const url = new URL(input);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" ||
      url.search || url.hash || url.username || url.password) {
    throw new Error("only exact 127.0.0.1 HTTP origins are permitted");
  }
  return url.origin;
}

export function loadOwnerGatewayConfig(env = process.env) {
  const ownerId = String(env.CLOUD_AGENT_OWNER_ACCOUNT_ID ?? "").trim();
  if (!/^[A-Za-z0-9._-]{3,128}$/.test(ownerId)) throw new Error("CLOUD_AGENT_OWNER_ACCOUNT_ID required");
  const portalOrigin = String(env.CLOUD_AGENT_PORTAL_ORIGIN ?? "https://cloud-auth.tomzlab.cn");
  if (!portalOrigin.startsWith("https://") || new URL(portalOrigin).origin !== portalOrigin) {
    throw new Error("portal origin must be an exact HTTPS origin");
  }
  const port = Number(env.CLOUD_AGENT_OWNER_GATEWAY_PORT ?? 8793);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid owner port");
  return {
    ownerId, portalOrigin, port,
    authOrigin: localOrigin(env.CLOUD_AGENT_AUTH_ORIGIN ?? "http://127.0.0.1:8788"),
    agentOrigin: localOrigin(env.CLOUD_AGENT_API_ORIGIN ?? "http://127.0.0.1:8787"),
  };
}

function routeAllowed(method, raw) {
  if (/%2f|%5c|%2e/i.test(raw)) return false;
  const u = new URL(raw, "http://127.0.0.1");
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1") return false;
  if (["health", "status"].includes(parts[1])) return method === "GET" && parts.length === 2 && !u.search;
  if (parts[1] === "schedules") {
    if (parts.length === 2) return ["GET", "POST"].includes(method) && !u.search;
    if (!ID.test(parts[2])) return false;
    if (parts.length === 3) return ["GET", "PATCH", "DELETE"].includes(method) && !u.search;
    return parts.length === 4 && method === "POST" &&
      ["pause", "enable", "run-now", "cancel"].includes(parts[3]) && !u.search;
  }
  if (parts[1] === "runs" && method === "GET") {
    if (parts.length === 2) return [...u.searchParams.keys()].every(k => k === "limit" || k === "scheduleId");
    return ID.test(parts[2]) && !u.search &&
      (parts.length === 3 || (parts.length === 4 && ["report", "delivery"].includes(parts[3])));
  }
  return false;
}

function respond(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(body);
}

/**
 * A network boundary, not a generic HTTP proxy: this always connects to the
 * numeric loopback IP. The requested route was enumerated by routeAllowed().
 * The caller cannot choose scheme, host, port or redirect destination.
 */
async function requestLocalAgent({ config, path, method, body }) {
  const port = Number(new URL(config.agentOrigin).port || 80);
  return await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: body?.length ? { "content-type": "application/json", "content-length": body.length } : {},
      agent: false,
      timeout: 10_000,
    }, (res) => {
      const parts = [];
      let length = 0;
      res.on("data", (chunk) => {
        length += chunk.length;
        if (length > 1_048_576) {
          req.destroy(Object.assign(new Error("local API response exceeds limit"), { status: 502 }));
          return;
        }
        parts.push(chunk);
      });
      res.on("end", () => resolve({
        status: res.statusCode || 502,
        data: Buffer.concat(parts),
      }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("local API timeout")));
    req.end(body?.length ? body : undefined);
  });
}

async function collectBody(req) {
  if (Number(req.headers["content-length"]) > MAX_BODY) return null;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function verifyCloudOwner(bearer, config, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(config.authOrigin + "/v1/auth/session", {
      method: "GET", headers: { authorization: bearer, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(3000),
    });
    if (r.status === 401 || r.status === 403) return 401;
    if (r.status !== 200) return 503;
    const data = await r.json();
    return data?.account?.id === config.ownerId ? 200 : 403;
  } catch { return 503; }
}

export function createOwnerGateway({ config, fetchImpl = fetch, authorize, requestAgent = requestLocalAgent } = {}) {
  if (!config) throw new TypeError("config required");
  const verify = authorize ?? (bearer => verifyCloudOwner(bearer, config, fetchImpl));
  let server = null;
  async function handle(req, res) {
    try {
      const method = req.method ?? "";
      const path = req.url ?? "/";
      if (!routeAllowed(method, path)) return respond(res, 404, { error: "not_found" });
      const bearer = req.headers.authorization ?? "";
      if (!SESSION.test(bearer)) return respond(res, 401, { error: "authentication_required" });
      const auth = await verify(bearer);
      if (auth !== 200) return respond(res, auth === 401 ? 401 : auth === 403 ? 403 : 503, { error: "not_authorized" });
      if (method !== "GET" && req.headers.origin !== config.portalOrigin) {
        return respond(res, 403, { error: "origin_not_allowed" });
      }
      const body = ["POST", "PATCH"].includes(method) ? await collectBody(req) : undefined;
      if (body === null) return respond(res, 413, { error: "request_too_large" });
      if (body?.length && !/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")) {
        return respond(res, 415, { error: "json_required" });
      }
      const result = await requestAgent({ config, path, method, body });
      if (result.data.length > 1_048_576) return respond(res, 502, { error: "response_too_large" });
      res.writeHead(result.status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": result.data.length, "cache-control": "no-store",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY",
      });
      res.end(result.data);
    } catch { respond(res, 503, { error: "gateway_unavailable" }); }
  }
  return {
    async start(port = config.port) {
      if (server) throw new Error("already started");
      const created = createServer((req, res) => { void handle(req, res); });
      await new Promise((resolve, reject) => {
        created.once("error", reject);
        created.listen(port, "127.0.0.1", resolve);
      });
      server = created;
      return "http://127.0.0.1:" + created.address().port;
    },
    async stop() {
      if (!server) return;
      const current = server;
      server = null;
      await new Promise((resolve, reject) => current.close(err => err ? reject(err) : resolve()));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadOwnerGatewayConfig();
  const gateway = createOwnerGateway({ config });
  await gateway.start();
  process.stdout.write(JSON.stringify({ event: "owner_gateway_started", port: config.port }) + "\n");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { void gateway.stop().then(() => process.exit(0), () => process.exit(1)); });
  }
}
