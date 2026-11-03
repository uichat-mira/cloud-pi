/**
 * AGT-038: the MCP binding against a real MCP server (local, in-process).
 *
 * This is the integration half of the card: a real streamable-HTTP MCP server,
 * Pi's own MCP extension, a real `tools/list`, a real tool call through Pi's
 * tool pipeline, and a server-side failure that must reach the transcript and
 * the run record verbatim. The server is local so the test needs no network;
 * the deployed endpoint is exercised by scripts/agt-038/live-mcp.mjs.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createGuanlanMcpBinding } from "../src/mcp/guanlan.mjs";

const TOOL_WHOAMI = "guanlan_whoami";
const TOOL_NEWS = "guanlan_news_recent";
const TOOL_SECRET = "guanlan_internal_debug"; // offered by the server, must stay hidden
const TOOL_DECIDE = "guanlan_news_decide"; // write scope, only exposed on opt-in

function jwt(expOffsetSec = 300) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "t9-test", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(
    JSON.stringify({ iss: "mira:cloud-auth", sub: "svc:t9", aud: "mira:cloud-guanlan", scope: ["guanlan.read"], iat: now, exp: now + expOffsetSec }),
  ).toString("base64url");
  return `${header}.${claims}.sig`;
}

/** A minimal streamable-HTTP MCP server: initialize, tools/list, tools/call. */
async function startMcpServer({ newsFails = true, cas = false } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = body ? JSON.parse(body) : {};
      requests.push({ authorization: request.headers.authorization ?? null, method: payload.method, id: payload.id });
      const send = (result) => {
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "t9-session" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
      };
      // Notifications carry no id and expect no JSON-RPC answer.
      if (payload.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      switch (payload.method) {
        case "initialize":
          send({
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "guanlan-test", version: "0.0.1" },
          });
          return;
        case "tools/list":
          send({
            tools: [
              { name: TOOL_WHOAMI, description: "service identity", inputSchema: { type: "object", properties: {} } },
              {
                name: TOOL_NEWS,
                description: "recent news",
                inputSchema: { type: "object", properties: { limit: { type: "number" } } },
              },
              { name: TOOL_SECRET, description: "debug", inputSchema: { type: "object", properties: {} } },
              ...(cas
                ? [
                    {
                      name: TOOL_DECIDE,
                      description: "decide a news item with compare-and-set",
                      inputSchema: { type: "object", properties: { id: { type: "string" } } },
                    },
                  ]
                : []),
            ],
          });
          return;
        case "tools/call": {
          const name = payload.params?.name;
          if (name === TOOL_WHOAMI) {
            send({ content: [{ type: "text", text: JSON.stringify({ sub: "svc:t9", scope: ["guanlan.read"] }) }] });
            return;
          }
          if (name === TOOL_DECIDE) {
            // Compare-and-set: a stale version is a normal, expected rejection.
            const expected = payload.params?.arguments?.expectedVersion;
            if (expected !== 3) {
              send({
                isError: true,
                content: [{ type: "text", text: `version_conflict: expected 3, got ${expected}` }],
              });
              return;
            }
            send({ content: [{ type: "text", text: JSON.stringify({ state: "adopted", stateVersion: 4 }) }] });
            return;
          }
          if (name === TOOL_NEWS && newsFails) {
            send({
              isError: true,
              content: [{ type: "text", text: "upstream_error: ledger_unavailable" }],
            });
            return;
          }
          send({ content: [{ type: "text", text: JSON.stringify({ items: [{ id: "n-1", title: "t" }] }) }] });
          return;
        }
        default:
          response.writeHead(400).end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: "unknown method" } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function openSession({ binding, tempDir }) {
  const faux = fauxProvider({ provider: "t9-faux", models: [{ id: "t9-scripted", name: "T9 scripted model" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(tempDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const resourceLoader = new DefaultResourceLoader({
    cwd: tempDir,
    agentDir: tempDir,
    extensionFactories: binding.extensionFactories,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: tempDir,
    agentDir: tempDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    settingsManager: SettingsManager.inMemory({}),
    sessionManager: SessionManager.inMemory(),
    tools: binding.exposedTools,
  });
  await session.bindExtensions({});
  return { session, faux };
}

async function waitForTools(session, count, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let tools = [];
  while (Date.now() - startedAt < timeoutMs) {
    tools = session.getActiveToolNames().filter((name) => name.startsWith("mcp__guanlan__"));
    if (tools.length >= count) return tools;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return tools;
}

test("real MCP tools/list declares the configured tools and hides the rest", async () => {
  const server = await startMcpServer();
  const tempDir = mkdtempSync(join(tmpdir(), "cloud-pi-t9-int-"));
  const binding = createGuanlanMcpBinding({
    env: {
      GUANLAN_MCP_URL: server.url,
      GUANLAN_MCP_TOKEN: jwt(),
    },
    log: () => {},
    fetch: globalThis.fetch,
  });
  try {
    const { session } = await openSession({ binding, tempDir });
    const tools = await waitForTools(session, 2);
    assert.deepEqual([...tools].sort(), [`mcp__guanlan__${TOOL_NEWS}`, `mcp__guanlan__${TOOL_WHOAMI}`].sort());
    assert.equal(tools.includes(`mcp__guanlan__${TOOL_SECRET}`), false, "tools beyond the allowlist stay hidden");
  } finally {
    await server.close();
  }
});

test("a tool error from the server reaches the transcript verbatim, not as a fake success", async () => {
  const server = await startMcpServer({ newsFails: true });
  const tempDir = mkdtempSync(join(tmpdir(), "cloud-pi-t9-int-"));
  const binding = createGuanlanMcpBinding({
    env: { GUANLAN_MCP_URL: server.url, GUANLAN_MCP_TOKEN: jwt() },
    log: () => {},
    fetch: globalThis.fetch,
  });
  try {
    const { session, faux } = await openSession({ binding, tempDir });
    await waitForTools(session, 2);

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(`mcp__guanlan__${TOOL_NEWS}`, { limit: 2 }, { id: "t9-news" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("reported the error"),
    ]);
    await session.prompt("call news_recent");

    const result = session.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === `mcp__guanlan__${TOOL_NEWS}`,
    );
    assert.ok(result, "the tool result must be in the transcript");
    assert.equal(result.isError, true);
    const text = (result.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.match(text, /upstream_error: ledger_unavailable/);
    // The credential went out on the wire exactly as a bearer token…
    assert.ok(server.requests.every((request) => request.authorization?.startsWith("Bearer ")));
  } finally {
    await server.close();
  }
});

test("compare-and-set: a stale version is rejected verbatim, a re-read version succeeds", async () => {
  const server = await startMcpServer({ newsFails: false, cas: true });
  const tempDir = mkdtempSync(join(tmpdir(), "cloud-pi-t9-int-"));
  const binding = createGuanlanMcpBinding({
    env: { GUANLAN_MCP_URL: server.url, GUANLAN_MCP_TOKEN: jwt(), GUANLAN_MCP_ALLOW_WRITE: "1" },
    log: () => {},
    fetch: globalThis.fetch,
  });
  try {
    const { session, faux } = await openSession({ binding, tempDir });
    const tools = await waitForTools(session, 3);
    assert.ok(tools.includes(`mcp__guanlan__${TOOL_DECIDE}`), "the write tool is exposed only with the explicit opt-in");

    const decideResult = () =>
      session.messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === `mcp__guanlan__${TOOL_DECIDE}`,
      );
    const textOf = (message) =>
      (message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

    // 1. Decide with the version the caller *thought* was current.
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall(`mcp__guanlan__${TOOL_DECIDE}`, { id: "n-1", decision: "adopted", expectedVersion: 1 }, { id: "t9-cas-1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("conflict, re-reading"),
    ]);
    await session.prompt("decide with a stale version");
    const stale = decideResult();
    assert.equal(stale.isError, true, "a stale version must not look like success");
    assert.match(textOf(stale), /version_conflict: expected 3, got 1/);

    // 2. Re-read to learn the current version, then decide again.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(`mcp__guanlan__${TOOL_NEWS}`, { limit: 2 }, { id: "t9-cas-reread" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        [fauxToolCall(`mcp__guanlan__${TOOL_DECIDE}`, { id: "n-1", decision: "adopted", expectedVersion: 3 }, { id: "t9-cas-2" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("adopted"),
    ]);
    await session.prompt("re-read then decide");
    const applied = decideResult();
    assert.notEqual(applied.isError, true);
    assert.match(textOf(applied), /"stateVersion":4/);
  } finally {
    await server.close();
  }
});

test("every request re-reads the credential, so a rotated token is used mid-run", async () => {
  const server = await startMcpServer({ newsFails: false });
  const tempDir = mkdtempSync(join(tmpdir(), "cloud-pi-t9-int-"));
  let current = jwt();
  let fingerprint = 0;
  const tokens = new Map();
  const binding = createGuanlanMcpBinding({
    env: { GUANLAN_MCP_URL: server.url, GUANLAN_MCP_TOKEN: current },
    log: () => {},
    fetch: globalThis.fetch,
    tokenProvider: {
      // A rotation between two tool calls must be visible on the wire.
      current: () => {
        if (fingerprint === 0) tokens.set("first", current);
        const token = current;
        fingerprint += 1;
        return { token, fingerprint: `fp-${fingerprint}`, exp: null, kid: null, scope: ["guanlan.read"] };
      },
      describe: () => ({ tokenFingerprint: "fp", exp: null, kid: null }),
      invalidate: () => {},
    },
  });
  try {
    const { session, faux } = await openSession({ binding, tempDir });
    await waitForTools(session, 2);

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(`mcp__guanlan__${TOOL_WHOAMI}`, {}, { id: "t9-a" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("first call");
    const firstToken = server.requests.at(-1).authorization;

    current = jwt(280);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(`mcp__guanlan__${TOOL_WHOAMI}`, {}, { id: "t9-b" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("second call");
    const secondToken = server.requests.at(-1).authorization;

    assert.ok(firstToken);
    assert.ok(secondToken);
    assert.notEqual(firstToken, secondToken, "a rotated token must be used without rebuilding the session");
  } finally {
    await server.close();
  }
});
