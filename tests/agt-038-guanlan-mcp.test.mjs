/**
 * AGT-038: the Guanlan MCP binding.
 *
 * These tests cover the parts that must hold without any network: configuration
 * validation, credential resolution (including a run that outlives the token
 * TTL), fail-closed behaviour, and log redaction. The live check against the
 * deployed endpoint lives in scripts/agt-038/live-mcp.mjs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGuanlanMcpBinding,
  createGuanlanTokenProvider,
  describeCredential,
  GUANLAN_ENV,
  loadGuanlanMcpConfig,
  McpCredentialUnavailableError,
} from "../src/mcp/guanlan.mjs";

const URL_HTTPS = "https://guanlan.example.test/mcp";

function jwt({ exp, iat, aud = "mira:cloud-guanlan", scope = ["guanlan.read"], kid = "kid-1" } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid, typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(
    JSON.stringify({
      iss: "mira:cloud-auth",
      sub: "svc:test",
      aud,
      scope,
      iat: iat ?? now,
      exp: exp ?? now + 300,
    }),
  ).toString("base64url");
  return `${header}.${claims}.signature`;
}

const envBase = (overrides = {}) => ({
  [GUANLAN_ENV.url]: URL_HTTPS,
  [GUANLAN_ENV.token]: jwt(),
  ...overrides,
});

test("config: the endpoint and a credential source are required", () => {
  assert.throws(
    () => loadGuanlanMcpConfig({}),
    (error) => error.code === "guanlan_mcp_config_error" && error.fields.includes(GUANLAN_ENV.url),
  );
  assert.throws(
    () => loadGuanlanMcpConfig({ [GUANLAN_ENV.url]: URL_HTTPS }),
    (error) => error.fields.includes(GUANLAN_ENV.tokenFile) && error.fields.includes(GUANLAN_ENV.token),
  );
  assert.throws(
    () => loadGuanlanMcpConfig({ [GUANLAN_ENV.url]: URL_HTTPS, [GUANLAN_ENV.tokenFile]: "a", [GUANLAN_ENV.token]: "b" }),
    (error) => error.code === "guanlan_mcp_config_error",
  );
});

test("config: a plaintext endpoint is refused so the bearer token never travels in clear text", () => {
  assert.throws(
    () => loadGuanlanMcpConfig(envBase({ [GUANLAN_ENV.url]: "http://guanlan.example.test/mcp" })),
    (error) => error.code === "guanlan_mcp_config_error" && /https/.test(error.message),
  );
  // Loopback http stays allowed for a local fixture.
  const local = loadGuanlanMcpConfig(envBase({ [GUANLAN_ENV.url]: "http://127.0.0.1:9999/mcp" }));
  assert.equal(local.url, "http://127.0.0.1:9999/mcp");
});

test("config: write tools appear only with an explicit opt-in", () => {
  const readOnly = loadGuanlanMcpConfig(envBase());
  assert.deepEqual(readOnly.tools, ["guanlan_whoami", "guanlan_news_recent"]);
  assert.deepEqual(readOnly.runtimeTools, [
    "mcp__guanlan__guanlan_whoami",
    "mcp__guanlan__guanlan_news_recent",
  ]);
  const withWrite = loadGuanlanMcpConfig(envBase({ [GUANLAN_ENV.allowWrite]: "1" }));
  assert.deepEqual(withWrite.tools, ["guanlan_whoami", "guanlan_news_recent", "guanlan_news_decide"]);
});

test("credential: a missing file fails closed with a stable code", () => {
  const provider = createGuanlanTokenProvider({
    tokenFile: "C:/does/not/exist",
    stat: () => {
      throw new Error("ENOENT");
    },
  });
  assert.throws(
    () => provider.current(),
    (error) => error instanceof McpCredentialUnavailableError && error.code === "mcp_credential_unavailable" && error.reason === "missing",
  );
});

test("credential: an expired token is refused instead of being reused", () => {
  const provider = createGuanlanTokenProvider({
    inlineToken: jwt({ exp: Math.floor(Date.now() / 1000) - 5 }),
  });
  assert.throws(() => provider.current(), (error) => error.reason === "expired");
});

test("credential: audience and scope are enforced locally", () => {
  assert.throws(
    () => createGuanlanTokenProvider({ inlineToken: jwt({ aud: "mira:shiyan" }) }).current(),
    (error) => error.reason === "wrong_audience",
  );
  assert.throws(
    () => createGuanlanTokenProvider({ inlineToken: jwt({ scope: ["guanlan.write"] }) }).current(),
    (error) => error.reason === "missing_scope",
  );
  assert.throws(
    () => createGuanlanTokenProvider({ inlineToken: "not-a-jwt" }).current(),
    (error) => error.reason === "malformed",
  );
});

test("credential: a run that outlives the TTL picks up the re-issued token", () => {
  // `now` is injectable so a long run is simulated without waiting.
  let nowMs = Date.now();
  let fileText = jwt({ exp: Math.floor(nowMs / 1000) + 300 });
  let mtimeMs = 1_000;

  const provider = createGuanlanTokenProvider({
    tokenFile: "token.txt",
    now: () => nowMs,
    stat: () => ({ mtimeMs, size: fileText.length }),
    read: () => fileText,
  });

  const first = provider.current();
  assert.equal(first.token, fileText);

  // Same file, three minutes later: the token is still valid.
  nowMs += 180_000;
  assert.equal(provider.current().token, fileText);

  // The TTL is nearly over: the same file must not be handed out again.
  nowMs += 150_000;
  assert.throws(() => provider.current(), (error) => error.reason === "expired");

  // The launcher re-issues: a new file (new mtime) is re-read without a restart.
  fileText = jwt({ exp: Math.floor(nowMs / 1000) + 300, kid: "kid-2" });
  mtimeMs = 2_000;
  const rotated = provider.current();
  assert.equal(rotated.token, fileText);
  assert.equal(rotated.kid, "kid-2");
});

test("credential: an unchanged file is not re-read on every request", () => {
  let reads = 0;
  const text = jwt();
  const provider = createGuanlanTokenProvider({
    tokenFile: "token.txt",
    stat: () => ({ mtimeMs: 5, size: text.length }),
    read: () => {
      reads += 1;
      return text;
    },
  });
  provider.current();
  provider.current();
  provider.current();
  assert.equal(reads, 1);
});

test("logs carry only the fingerprint, exp and kid", () => {
  const token = jwt({ kid: "kid-log" });
  const lines = [];
  const provider = createGuanlanTokenProvider({ inlineToken: token, log: (line) => lines.push(line) });
  const credential = provider.current();

  assert.equal(lines.length, 1);
  const serialized = JSON.stringify(lines);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes("Bearer"), false);
  assert.equal(serialized.includes(token.split(".")[1]), false);
  assert.equal(lines[0].tokenFingerprint, credential.fingerprint);
  assert.match(lines[0].tokenFingerprint, /^[0-9a-f]{12}$/);
  assert.equal(lines[0].kid, "kid-log");
  assert.equal(lines[0].exp, credential.exp);
  // The summary a caller may print has no token either.
  assert.equal(JSON.stringify(provider.describe()).includes(token), false);
});

test("describeCredential exposes no token material", () => {
  const token = jwt();
  const described = describeCredential(token);
  assert.deepEqual(
    Object.keys(described).sort(),
    ["aud", "exp", "fingerprint", "iat", "iss", "kid", "scope"],
  );
  assert.equal(JSON.stringify(described).includes(token.split(".")[0]), false);
});

test("a request is never attempted with an unusable credential", async () => {
  let calls = 0;
  const binding = createGuanlanMcpBinding({
    env: envBase({ [GUANLAN_ENV.token]: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }) }),
    fetch: async () => {
      calls += 1;
      return new Response("{}");
    },
    log: () => {},
  });
  await assert.rejects(
    () => binding.authorizedFetch("https://guanlan.example.test/mcp", {}),
    (error) => error.code === "mcp_credential_unavailable" && error.reason === "expired",
  );
  assert.equal(calls, 0, "no network call may happen without a usable credential");
});

test("a valid request carries the token only in the Authorization header", async () => {
  const token = jwt();
  const seen = [];
  const binding = createGuanlanMcpBinding({
    env: envBase({ [GUANLAN_ENV.token]: token }),
    fetch: async (input, init) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("{}");
    },
    log: () => {},
  });

  await binding.authorizedFetch("https://guanlan.example.test/mcp", { method: "POST" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get("authorization"), `Bearer ${token}`);
  // Neither the registered server entry nor the serializable config carries the token.
  assert.equal(JSON.stringify(binding.serverEntry).includes(token), false);
  assert.equal(JSON.stringify(binding.serverEntry).includes("Bearer"), false);
  assert.equal(JSON.stringify(binding.config).includes(token), false);
});

test("preflight fails closed and health separates a dead server from an unused tool", async () => {
  // A stale credential must stop the run before the model is called.
  const expired = createGuanlanMcpBinding({
    env: envBase({ [GUANLAN_ENV.token]: jwt({ exp: Math.floor(Date.now() / 1000) - 10 }) }),
    log: () => {},
    fetch: async () => new Response("{}"),
  });
  assert.throws(() => expired.assertReady(), (error) => error.code === "mcp_credential_unavailable");

  // Without a request there is no evidence the server works…
  const binding = createGuanlanMcpBinding({
    env: envBase(),
    log: () => {},
    fetch: async () => new Response("{}", { status: 200 }),
  });
  assert.equal(binding.health().reason, "no_request");
  assert.deepEqual(binding.assertReady().tokenFingerprint.length, 12);

  // …a 401 is an HTTP failure…
  const rejecting = createGuanlanMcpBinding({
    env: envBase(),
    log: () => {},
    fetch: async () => new Response("{}", { status: 401 }),
  });
  await rejecting.authorizedFetch("https://guanlan.example.test/mcp", {});
  assert.equal(rejecting.health().ok, false);
  assert.equal(rejecting.health().status, 401);

  // …and a transport error is reported as such, not as a quiet success.
  const broken = createGuanlanMcpBinding({
    env: envBase(),
    log: () => {},
    fetch: async () => {
      throw Object.assign(new Error("connect"), { cause: { code: "ECONNREFUSED" } });
    },
  });
  await assert.rejects(() => broken.authorizedFetch("https://guanlan.example.test/mcp", {}));
  assert.equal(broken.health().reason, "transport_error");
  assert.equal(broken.health().errorCode, "ECONNREFUSED");

  await binding.authorizedFetch("https://guanlan.example.test/mcp", {});
  assert.equal(binding.health().ok, true);
});

test("an invalid proxy setting is a configuration error, not a silent direct connection", () => {
  assert.throws(
    () => loadGuanlanMcpConfig(envBase({ [GUANLAN_ENV.proxy]: "socks5: nope" })),
    (error) => error.code === "guanlan_mcp_config_error" && error.fields.includes(GUANLAN_ENV.proxy),
  );
  assert.equal(loadGuanlanMcpConfig(envBase()).proxy, null);
});

test("the binding declares exactly the configured tools and hides the rest", () => {
  const binding = createGuanlanMcpBinding({ env: envBase(), log: () => {}, fetch: async () => new Response("{}") });
  assert.deepEqual(binding.exposedTools, ["mcp__guanlan__*"]);
  assert.deepEqual(binding.allowedTools, [
    "mcp__guanlan__guanlan_whoami",
    "mcp__guanlan__guanlan_news_recent",
  ]);
  // Two factories: the registrar and Pi's own MCP extension.
  assert.equal(binding.extensionFactories.length, 2);
});
