/**
 * Guanlan MCP binding (AGT-038).
 *
 * The agent reaches Guanlan through **Pi's built-in MCP extension** — the same
 * extension the P0 card used (`createMcpExtension`) — over the SDK's own
 * streamable-HTTP transport (`StreamableHttpTransport`). Nothing here speaks
 * JSON-RPC by hand and nothing here spawns a stdio server.
 *
 * Three properties are deliberate:
 *
 * 1. **The endpoint comes from the process environment, not from a file.** The
 *    extension's config loader returns exactly one server and ignores any
 *    `mcp.json`, so a repository cannot redirect a run to another MCP server.
 * 2. **The credential never becomes data.** The token is read at request time and
 *    written into the `Authorization` header of the outgoing HTTP request. It is
 *    not part of the server config, the model prompt, tool arguments, the run
 *    record or a log line; logs carry only a fingerprint, `exp` and `kid`.
 * 3. **A missing or stale credential fails closed.** Every request re-resolves the
 *    credential (with an mtime/size cache), and an expired token, a wrong
 *    audience or a missing scope raises `mcp_credential_unavailable` instead of
 *    reusing the previous token, skipping the tool or falling back to a fixture.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { statSync } from "node:fs";
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import { StreamableHttpTransport } from "@earendil-works/pi-mcp";

export const GUANLAN_SERVER_NAME = "guanlan";
export const GUANLAN_AUDIENCE = "mira:cloud-guanlan";
export const GUANLAN_READ_SCOPE = "guanlan.read";
export const GUANLAN_WRITE_SCOPE = "guanlan.write";

/** Tools this binding knows about, in the name the server declares. */
export const GUANLAN_TOOL = Object.freeze({
  WHOAMI: "guanlan_whoami",
  NEWS_RECENT: "guanlan_news_recent",
  NEWS_DECIDE: "guanlan_news_decide",
});

/** Tools exposed without an explicit write opt-in. */
export const READ_ONLY_TOOLS = Object.freeze([GUANLAN_TOOL.WHOAMI, GUANLAN_TOOL.NEWS_RECENT]);

export const GUANLAN_ENV = Object.freeze({
  url: "GUANLAN_MCP_URL",
  tokenFile: "GUANLAN_MCP_TOKEN_FILE",
  token: "GUANLAN_MCP_TOKEN",
  allowWrite: "GUANLAN_MCP_ALLOW_WRITE",
  audience: "GUANLAN_MCP_AUDIENCE",
  timeoutSec: "GUANLAN_MCP_TIMEOUT_SEC",
  /**
   * Outbound proxy for the MCP endpoint, if the deployment needs one. It is a
   * separate setting on purpose: the research proxy (`RESEARCH_HTTPS_PROXY`) is
   * for search/read tools and must not be inherited implicitly by a channel
   * process.
   */
  proxy: "GUANLAN_MCP_PROXY",
});

/** A configuration problem the operator can fix. Never carries a secret value. */
export class GuanlanMcpConfigError extends Error {
  constructor(fields, detail) {
    super(detail ?? `Guanlan MCP configuration is incomplete or invalid (${fields.join(", ")})`);
    this.name = "GuanlanMcpConfigError";
    this.code = "guanlan_mcp_config_error";
    this.fields = Object.freeze([...fields]);
  }
}

/** The credential is absent, unreadable, expired or for the wrong audience. */
export class McpCredentialUnavailableError extends Error {
  constructor(reason, detail) {
    super(detail ?? `mcp_credential_unavailable: ${reason}`);
    this.name = "McpCredentialUnavailableError";
    this.code = "mcp_credential_unavailable";
    this.reason = reason;
  }
}

const present = (value) => (typeof value === "string" ? value.trim() : "");
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** Treat a token as unusable slightly before it really expires. */
const EXPIRY_SKEW_MS = 30_000;

/**
 * Validate the binding configuration.
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {{ fileExists?: (path: string) => boolean }} [options]
 */
export function loadGuanlanMcpConfig(env = process.env, { fileExists } = {}) {
  const rawUrl = present(env[GUANLAN_ENV.url]);
  if (!rawUrl) throw new GuanlanMcpConfigError([GUANLAN_ENV.url], `${GUANLAN_ENV.url} is required`);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GuanlanMcpConfigError([GUANLAN_ENV.url], `${GUANLAN_ENV.url} is not a valid URL`);
  }
  // A plaintext endpoint would put the bearer token on the wire in clear text.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new GuanlanMcpConfigError(
      [GUANLAN_ENV.url],
      `${GUANLAN_ENV.url} must be https (or http on loopback for a local fixture)`,
    );
  }

  const tokenFile = present(env[GUANLAN_ENV.tokenFile]);
  const inlineToken = present(env[GUANLAN_ENV.token]);
  if (!tokenFile && !inlineToken) {
    throw new GuanlanMcpConfigError(
      [GUANLAN_ENV.tokenFile, GUANLAN_ENV.token],
      `one of ${GUANLAN_ENV.tokenFile} or ${GUANLAN_ENV.token} is required`,
    );
  }
  if (tokenFile && inlineToken) {
    throw new GuanlanMcpConfigError(
      [GUANLAN_ENV.tokenFile, GUANLAN_ENV.token],
      `set only one of ${GUANLAN_ENV.tokenFile} or ${GUANLAN_ENV.token}`,
    );
  }
  if (tokenFile && fileExists && !fileExists(tokenFile)) {
    throw new GuanlanMcpConfigError([GUANLAN_ENV.tokenFile], `${GUANLAN_ENV.tokenFile} does not exist`);
  }

  const timeoutSec = Number.parseInt(present(env[GUANLAN_ENV.timeoutSec]) || "60", 10);
  if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
    throw new GuanlanMcpConfigError([GUANLAN_ENV.timeoutSec], `${GUANLAN_ENV.timeoutSec} must be a positive integer`);
  }

  const allowWrite = ["1", "true", "yes"].includes(present(env[GUANLAN_ENV.allowWrite]).toLowerCase());
  const tools = allowWrite ? [...READ_ONLY_TOOLS, GUANLAN_TOOL.NEWS_DECIDE] : [...READ_ONLY_TOOLS];
  const proxy = present(env[GUANLAN_ENV.proxy]) || null;
  if (proxy) {
    let parsedProxy;
    try {
      parsedProxy = new URL(proxy);
    } catch {
      throw new GuanlanMcpConfigError([GUANLAN_ENV.proxy], `${GUANLAN_ENV.proxy} is not a valid URL`);
    }
    if (!/^https?:$/.test(parsedProxy.protocol)) {
      throw new GuanlanMcpConfigError([GUANLAN_ENV.proxy], `${GUANLAN_ENV.proxy} must be an http(s) proxy`);
    }
  }

  const config = {
    serverName: GUANLAN_SERVER_NAME,
    url: url.toString(),
    tokenFile: tokenFile || null,
    audience: present(env[GUANLAN_ENV.audience]) || GUANLAN_AUDIENCE,
    timeoutSec,
    allowWrite,
    proxy,
    tools,
    /** Names as the runtime sees them (`mcp__<server>__<tool>`). */
    runtimeTools: tools.map((tool) => `mcp__${GUANLAN_SERVER_NAME}__${tool}`),
  };
  // An inline token is kept off the enumerable config so that stringifying or
  // logging the config can never include it.
  Object.defineProperty(config, "inlineToken", { value: inlineToken || null, enumerable: false });
  return config;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/** Session-independent facts about a token: never the token itself. */
export function describeCredential(token) {
  const [headerSegment, claimsSegment] = String(token).split(".");
  if (!headerSegment || !claimsSegment) throw new McpCredentialUnavailableError("malformed", "token is not a JWT");
  let header;
  let claims;
  try {
    header = decodeSegment(headerSegment);
    claims = decodeSegment(claimsSegment);
  } catch {
    throw new McpCredentialUnavailableError("malformed", "token could not be decoded");
  }
  const fingerprint = createHash("sha256").update(String(token)).digest("hex").slice(0, 12);
  const scope = Array.isArray(claims.scope)
    ? claims.scope
    : typeof claims.scope === "string"
      ? claims.scope.split(" ")
      : [];
  return {
    fingerprint,
    exp: typeof claims.exp === "number" ? claims.exp : null,
    iat: typeof claims.iat === "number" ? claims.iat : null,
    kid: typeof header.kid === "string" ? header.kid : null,
    aud: claims.aud ?? null,
    iss: typeof claims.iss === "string" ? claims.iss : null,
    scope,
  };
}

/**
 * Re-reads the credential on demand.
 *
 * A research run can outlive the token TTL, so nothing is cached beyond the
 * file's identity: when the mtime or size changes the file is re-read. When the
 * file is unchanged but the token is near expiry the provider fails instead of
 * handing out a credential the server will reject.
 *
 * @param {object} options
 * @param {string|null} options.tokenFile
 * @param {string|null} options.inlineToken
 * @param {string} [options.audience] expected `aud`
 * @param {string} [options.requiredScope] scope the binding needs
 * @param {() => number} [options.now]
 * @param {Function} [options.log]
 * @param {(path: string) => {mtimeMs:number,size:number}} [options.stat]
 * @param {(path: string) => string} [options.read]
 */
export function createGuanlanTokenProvider({
  tokenFile,
  inlineToken,
  audience = GUANLAN_AUDIENCE,
  requiredScope = GUANLAN_READ_SCOPE,
  now = Date.now,
  log = () => {},
  stat = (path) => statSync(path),
  read = (path) => readFileSync(path, "utf8"),
} = {}) {
  let cached = null;
  let lastLoggedFingerprint = null;

  /** A cached entry is only reused while it is still valid: expiry is re-checked. */
  function usable(entry) {
    if (!entry) return false;
    if (entry.exp !== null && entry.exp * 1000 - EXPIRY_SKEW_MS <= now()) {
      throw new McpCredentialUnavailableError("expired", "token is expired or about to expire; re-issue it and retry");
    }
    return true;
  }

  function load() {
    let text;
    let signature;
    if (tokenFile) {
      let info;
      try {
        info = stat(tokenFile);
      } catch {
        throw new McpCredentialUnavailableError("missing", `token file ${tokenFile} is not readable`);
      }
      signature = `${info.mtimeMs}:${info.size}`;
      if (cached && cached.signature === signature && usable(cached)) return cached;
      try {
        text = read(tokenFile).trim();
      } catch {
        throw new McpCredentialUnavailableError("unreadable", `token file ${tokenFile} could not be read`);
      }
    } else {
      text = String(inlineToken ?? "").trim();
      signature = `inline:${text.length}`;
      if (cached && cached.signature === signature && usable(cached)) return cached;
    }
    if (!text) throw new McpCredentialUnavailableError("empty", "credential is empty");

    const described = describeCredential(text);
    if (described.exp !== null && described.exp * 1000 - EXPIRY_SKEW_MS <= now()) {
      // Never retry with a token the server will reject; the caller must re-issue.
      throw new McpCredentialUnavailableError("expired", "token is expired or about to expire; re-issue it and retry");
    }
    const audienceList = Array.isArray(described.aud) ? described.aud : [described.aud];
    if (audience && !audienceList.includes(audience)) {
      throw new McpCredentialUnavailableError(
        "wrong_audience",
        `token audience ${JSON.stringify(described.aud)} is not ${audience}`,
      );
    }
    if (requiredScope && !described.scope.includes(requiredScope)) {
      throw new McpCredentialUnavailableError(
        "missing_scope",
        `token does not grant ${requiredScope} (has ${described.scope.join(" ") || "none"})`,
      );
    }

    cached = { signature, token: text, ...described };
    if (cached.fingerprint !== lastLoggedFingerprint) {
      lastLoggedFingerprint = cached.fingerprint;
      // Only the projection: fingerprint + exp + kid + scope. Never the token.
      log({
        level: "info",
        event: "guanlan_mcp_credential",
        tokenFingerprint: cached.fingerprint,
        exp: cached.exp,
        kid: cached.kid,
        scope: cached.scope.join(" "),
      });
    }
    return cached;
  }

  return {
    /** @returns {{token:string, fingerprint:string, exp:number|null, kid:string|null, scope:string[]}} */
    current() {
      return load();
    },
    /** Non-secret description for diagnostics. */
    describe() {
      const credential = load();
      return { tokenFingerprint: credential.fingerprint, exp: credential.exp, kid: credential.kid };
    },
    /** Drop the cache so the next request re-reads the file. */
    invalidate() {
      cached = null;
    },
  };
}

/**
 * Build the Pi extension factories that bind Guanlan.
 *
 * @param {object} options
 * @param {object} [options.env]
 * @param {object} [options.config] validated config (tests)
 * @param {object} [options.tokenProvider] injected provider (tests)
 * @param {Function} [options.log] JSON logger
 * @param {Function} [options.fetch] injected fetch (tests)
 * @param {string} [options.logPath] MCP server log path
 * @param {number} [options.startupWaitMs]
 */
export function createGuanlanMcpBinding({
  env = process.env,
  config,
  tokenProvider,
  log = () => {},
  fetch: fetchImpl = globalThis.fetch,
  logPath,
  startupWaitMs = 15_000,
} = {}) {
  const bindingConfig = config ?? loadGuanlanMcpConfig(env, { fileExists: (path) => statSync(path, { throwIfNoEntry: false }) !== undefined });
  const credentials =
    tokenProvider ??
    createGuanlanTokenProvider({
      tokenFile: bindingConfig.tokenFile,
      inlineToken: bindingConfig.inlineToken,
      audience: bindingConfig.audience,
      log,
    });

  /**
   * Per-request credential injection: the only place the token is used.
   *
   * When the deployment needs an outbound proxy, it is applied here rather than
   * through a process-wide `HTTPS_PROXY`: the run's network path is explicit.
   */
  let dispatcherPromise = null;
  const dispatcherFor = async () => {
    if (!bindingConfig.proxy) return null;
    if (!dispatcherPromise) {
      dispatcherPromise = import("undici").then(({ ProxyAgent }) => new ProxyAgent(bindingConfig.proxy));
    }
    return await dispatcherPromise;
  };

  /**
   * Last exchange with the server, for post-run health checks. A dead or
   * rejecting server otherwise looks exactly like "the model chose no tools".
   */
  let lastExchange = null;

  const authorizedFetch = async (input, init = {}) => {
    const credential = credentials.current();
    const headers = new Headers(init.headers ?? {});
    headers.set("authorization", `Bearer ${credential.token}`);
    headers.set("accept", "application/json, text/event-stream");
    const dispatcher = await dispatcherFor();
    try {
      const response = await fetchImpl(input, { ...init, headers, ...(dispatcher ? { dispatcher } : {}) });
      lastExchange = { status: response.status, ok: response.status < 400, at: Date.now() };
      return response;
    } catch (error) {
      lastExchange = {
        status: null,
        ok: false,
        at: Date.now(),
        errorCode: error?.cause?.code ?? error?.code ?? "fetch_failed",
      };
      throw error;
    }
  };

  // Only the configured tools are declared to the model; everything else the
  // server offers is hidden, so a new server tool cannot widen the agent's reach.
  const toolExposure = { "*": "hidden" };
  for (const tool of bindingConfig.tools) toolExposure[tool] = "direct";

  const entry = {
    name: bindingConfig.serverName,
    // No credential in the entry: the transport adds it per request.
    config: {
      type: "http",
      url: bindingConfig.url,
      exposure: "direct",
      toolExposure,
      timeout: bindingConfig.timeoutSec,
      description: "Guanlan news ledger (read tools by default; write only with an explicit opt-in)",
    },
    source: `env:${GUANLAN_ENV.url}`,
    scope: "extension",
  };

  // The server is registered from an extension, the way P0 proved out: the MCP
  // extension connects registered servers next to any `mcp.json` entries.
  const registrationExtension = (pi) => {
    pi.registerMcpServer(bindingConfig.serverName, entry.config);
  };

  const mcpExtension = createMcpExtension({
    // An ambient `mcp.json` must not add or replace a server for a run.
    loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
    createTransport: (serverEntry, cwd, authProvider) =>
      new StreamableHttpTransport({
        url: serverEntry.config.url,
        fetch: authorizedFetch,
        // No server-to-client GET stream: fewer long-lived requests carrying a
        // credential, and every tool call resolves a fresh one.
        openGetStream: false,
        authProvider,
      }),
    ...(logPath ? { logPath } : {}),
    startupWaitMs,
  });

  return {
    config: bindingConfig,
    credentials,
    /**
     * Fail before the model is called when the credential is unusable.
     *
     * The MCP connection itself is lazy, so without this check an expired token
     * would only surface as "no tools declared" and a run could still produce a
     * confident answer with zero real tool calls. Callers must treat a throw
     * here as a failed run, not as a degraded one.
     */
    assertReady() {
      const credential = credentials.current();
      return { tokenFingerprint: credential.fingerprint, exp: credential.exp, kid: credential.kid };
    },
    /** The entry registered with Pi's MCP extension: never carries a credential. */
    serverEntry: entry,
    /**
     * What the last request to the server did. Callers use it after a run to
     * distinguish "the model chose not to use the tools" from "the server never
     * answered": the second case must fail the run, not silently pass.
     */
    health() {
      if (!lastExchange) return { ok: false, reason: "no_request", at: null, status: null };
      if (lastExchange.ok) return { ok: true, reason: "ok", at: lastExchange.at, status: lastExchange.status };
      return {
        ok: false,
        reason: lastExchange.status === null ? "transport_error" : "http_error",
        at: lastExchange.at,
        status: lastExchange.status,
        errorCode: lastExchange.errorCode ?? null,
      };
    },
    /**
     * The only place a credential is attached to a request. Exposed for tests:
     * it must reject before any network I/O when the credential is unusable.
     */
    authorizedFetch,
    /** Pass to `createAgentRuntime({ extensionFactories })`. */
    extensionFactories: [registrationExtension, mcpExtension],
    /** Execution allowlist: the exact tools this binding declares. */
    allowedTools: bindingConfig.runtimeTools,
    /**
     * Model-visible allowlist. The MCP tools only register once the extension has
     * connected, so the session allowlist has to be a pattern; which tools can
     * appear is still decided by `toolExposure` above, not by the model.
     */
    exposedTools: [`mcp__${bindingConfig.serverName}__*`],
  };
}
