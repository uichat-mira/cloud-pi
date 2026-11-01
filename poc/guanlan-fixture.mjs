/**
 * Isolated Guanlan fixture for the Cloud Pi P0.
 *
 * The MCP subject is the real `uichat-mira/cloud-mcp-guanlan` workerd worker built
 * from the pinned commit below, running on Miniflare with a real D1 database and
 * the repository's own migrations and fixture-token verifier. Nothing about the
 * MCP server is mocked here.
 *
 * Miniflare dispatches requests in-process; it does not expose a TCP listener.
 * `createTcpBridge` therefore forwards real HTTP requests from the Pi SDK's
 * streamable-HTTP transport into `mf.dispatchFetch` byte for byte. The only
 * injected fault is response latency, used by the timeout/cancel cases, and it
 * is applied after the worker has already produced its real response.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

/** Guanlan dev commit the fixture is built from. */
export const GUANLAN_FIXTURE_COMMIT = "3362ef9254be154694cb786fc35921884c62b792";
/** Guanlan's own workerd/D1 test fixture identity. */
const D1_DATABASE_ID = "00000000-0000-4000-8000-000000000008";
const MIGRATIONS = [
  "0001_poc.sql",
  "0002_source_leases.sql",
  "0003_guanlan_accounts.sql",
  "0004_consumer_news_state.sql",
];

export function resolveGuanlanDir(options = {}) {
  return resolve(options.guanlanDir ?? process.env.GUANLAN_DIR ?? join(tmpdir(), "cloud-pi-guanlan"));
}

/**
 * Load the exact Miniflare/workerd pair pinned by the Guanlan checkout. The
 * fixture must run under the same runtime as Guanlan's own MCP tests, and using
 * the checkout's install avoids a second workerd build in this repository.
 */
async function loadMiniflare(guanlanDir) {
  const entry = join(guanlanDir, "node_modules/miniflare/dist/src/index.js");
  try {
    return await import(pathToFileURL(entry).href);
  } catch (error) {
    throw new Error(
      `Cannot load Miniflare from the Guanlan checkout at ${entry}. Run "npm run prepare:guanlan" first.`,
      { cause: error },
    );
  }
}

export async function startGuanlanFixture(options = {}) {
  const guanlanDir = resolveGuanlanDir(options);
  const { Miniflare } = await loadMiniflare(guanlanDir);
  const fixtures = await import(pathToFileURL(join(guanlanDir, "dist/mcp-fixtures.mjs")).href);

  const mf = new Miniflare({
    modules: true,
    scriptPath: join(guanlanDir, "dist/mcp-test-worker.mjs"),
    modulesRoot: join(guanlanDir, "dist"),
    compatibilityDate: "2026-08-06",
    cf: false,
    d1Databases: { DB: D1_DATABASE_ID },
    bindings: {
      MCP_RESOURCE_URL: fixtures.MCP_TEST_RESOURCE_URL,
      CLOUD_AUTH_ISSUER: fixtures.MCP_TEST_ISSUER,
      CLOUD_AUTH_JWKS_URL: fixtures.MCP_TEST_JWKS_URL,
      MCP_AUDIENCE: fixtures.MCP_TEST_AUDIENCE,
      MCP_REQUIRED_SCOPES: fixtures.MCP_TEST_SCOPE,
    },
  });

  const db = await mf.getD1Database("DB");
  for (const name of MIGRATIONS) {
    const sql = await readFile(join(guanlanDir, "migrations", name), "utf8");
    for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }

  const bridge = await createTcpBridge(mf);
  return {
    mf,
    db,
    bridge,
    url: bridge.url,
    fixtures,
    /** Bindings/values the fixture negotiated with; safe to log. */
    meta: {
      guanlanDir,
      fixtureCommit: GUANLAN_FIXTURE_COMMIT,
      resourceUrl: fixtures.MCP_TEST_RESOURCE_URL,
      audience: fixtures.MCP_TEST_AUDIENCE,
      scope: fixtures.MCP_TEST_SCOPE,
    },
    async dispose() {
      await bridge.close();
      await mf.dispose();
    },
  };
}

/**
 * Transparent TCP -> Miniflare bridge. Records every request so tests can prove
 * which calls actually reached the MCP server, and can inject response latency
 * after the worker has produced its response.
 */
async function createTcpBridge(mf, requestedPort = 0) {
  const state = {
    requests: [],
    /** (record) => milliseconds to hold the real response before writing it. */
    responseDelayMs: () => 0,
    sockets: new Set(),
    port: requestedPort,
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${state.port}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"].includes(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    const record = {
      method: req.method ?? "GET",
      path: url.pathname,
      headers,
      body,
      json: parseJson(body),
      at: Date.now(),
      status: undefined,
    };
    state.requests.push(record);

    const init = {
      method: record.method,
      headers,
      ...(record.method === "GET" || record.method === "HEAD" ? {} : { body }),
    };

    let response;
    try {
      response = await mf.dispatchFetch(url.href, init);
    } catch (error) {
      record.status = 502;
      if (!res.destroyed) {
        res.statusCode = 502;
        res.end(`fixture bridge dispatch failed: ${String(error)}`);
      }
      return;
    }
    record.status = response.status;

    const delayMs = state.responseDelayMs(record);
    if (delayMs > 0) await sleep(delayMs);
    if (res.destroyed) return;

    res.statusCode = response.status;
    for (const [name, value] of response.headers) {
      if (["content-length", "content-encoding", "transfer-encoding"].includes(name)) continue;
      res.setHeader(name, value);
    }
    const contentType = response.headers.get("content-type") ?? "";
    record.responseType = contentType;
    if (contentType.includes("application/json")) {
      const text = await response.text();
      record.responseText = text;
      record.responseJson = parseJson(text);
      res.end(text);
      return;
    }
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    const cancel = () => void reader.cancel().catch(() => {});
    res.on("close", cancel);
    const shouldCapture = record.json?.method === "initialize" || record.json?.method === "tools/list";
    const captured = [];
    try {
      while (!res.destroyed) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (shouldCapture && captured.length < 64) captured.push(chunk);
        res.write(chunk);
      }
    } catch {
      // The client aborted or the socket closed; the record above still proves
      // the request reached the real worker.
    } finally {
      res.off("close", cancel);
      if (shouldCapture) record.responseText = Buffer.concat(captured).toString("utf8");
      if (!res.destroyed) res.end();
    }
  }

  server.on("connection", (socket) => {
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
  });

  await new Promise((resolveListen) => server.listen(state.port, "127.0.0.1", resolveListen));
  state.port = server.address().port;

  const bridge = {
    get url() {
      return `http://127.0.0.1:${state.port}/mcp`;
    },
    get port() {
      return state.port;
    },
    get requests() {
      return state.requests;
    },
    set responseDelayMs(fn) {
      state.responseDelayMs = fn;
    },
    /** Requests whose JSON-RPC method matches `method`. */
    rpcCalls(method) {
      return state.requests.filter((record) => record.json?.method === method);
    },
    /** tools/call records for one tool name. */
    toolCalls(toolName) {
      return bridge
        .rpcCalls("tools/call")
        .filter((record) => record.json?.params?.name === toolName);
    },
    async waitFor(predicate, { timeoutMs = 5000, label = "bridge request" } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = state.requests.find(predicate);
        if (match) return match;
        await sleep(25);
      }
      throw new Error(`Timed out waiting for ${label}`);
    },
    /** Simulate an interrupted network connection without stopping the listener. */
    dropConnections() {
      for (const socket of state.sockets) socket.destroy();
      state.sockets.clear();
    },
    async stop() {
      for (const socket of state.sockets) socket.destroy();
      state.sockets.clear();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
    async start() {
      await new Promise((resolveListen) => server.listen(state.port, "127.0.0.1", resolveListen));
    },
    async close() {
      await bridge.stop();
    },
  };
  return bridge;
}

function parseJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
