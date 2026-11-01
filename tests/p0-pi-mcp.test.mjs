/**
 * Cloud Pi P0 acceptance suite.
 *
 * Every test drives a real Pi SDK `AgentSession` whose model is a scripted
 * provider; the MCP client, transport, extension pipeline and Guanlan
 * workerd/D1 server are the real ones. See `poc/README.md` for the evidence
 * map and for what this P0 deliberately does not cover.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { startGuanlanFixture } from "../poc/guanlan-fixture.mjs";
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import {
  activeMcpTools,
  createPocSession,
  EXPECTED_TOOLS,
  lastToolResult,
  scriptedToolCall,
  textOf,
  TOOL_NEWS,
  TOOL_WHOAMI,
  waitFor,
  waitForMcpTools,
} from "../poc/pi-session.mjs";
import { FIXTURE, seedBrokenFixture, seedFixture } from "../poc/seed.mjs";

const PI_VERSION = "1.4.0";
const PI_NEGOTIATED_PROTOCOL = "2025-11-25";

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

/** The Guanlan page carried inside the Pi tool result. */
function pageOf(result) {
  return result?.structuredContent?.structuredContent;
}

function identityOf(result) {
  return pageOf(result);
}

function contentText(result) {
  return textOf(result?.content);
}

async function openSession(options = {}) {
  const p0 = await createPocSession({ bridgeUrl: fx.url, token: "fixture-consumer-1", ...options });
  await waitForMcpTools(p0.session);
  return p0;
}

async function callTool(p0, toolName, args = {}) {
  await scriptedToolCall(p0.session, p0.faux, toolName, args);
  const result = lastToolResult(p0.session, toolName);
  const event = latestEvent(p0, toolName);
  // The transcript deliberately drops `structuredContent`; the extension
  // `tool_result` event is the authoritative place it survives. Merge it back
  // for assertions without mutating the transcript.
  return result ? { ...result, structuredContent: event?.structuredContent } : result;
}

function latestEvent(p0, toolName) {
  return p0.capture.toolResults.findLast((event) => event.toolName === toolName);
}

let fx;

describe("P0: real Pi SDK session -> native MCP extension -> isolated Guanlan", () => {
  before(async () => {
    fx = await startGuanlanFixture();
    await seedFixture(fx.db);
  });

  after(async () => {
    await fx.dispose();
  });

  test("the installed Pi SDK is pinned and exposes the two Guanlan read tools over the real MCP transport", async () => {
    assert.equal(readJson("../node_modules/@earendil-works/pi-coding-agent/package.json").version, PI_VERSION);
    assert.equal(readJson("../node_modules/@earendil-works/pi-ai/package.json").version, PI_VERSION);
    assert.equal(typeof createMcpExtension, "function");

    const p0 = await openSession();
    try {
      assert.deepEqual(activeMcpTools(p0.session), EXPECTED_TOOLS);
      const declared = p0.session.getAllTools().map((tool) => tool.name).sort();
      assert.deepEqual(declared, EXPECTED_TOOLS);

      // The negotiation really happened on the wire, not only in Pi's registry.
      const initialize = fx.bridge.rpcCalls("initialize").at(-1);
      assert.equal(initialize.json.params.protocolVersion, PI_NEGOTIATED_PROTOCOL);
      assert.match(initialize.responseText, new RegExp(`"protocolVersion":"${PI_NEGOTIATED_PROTOCOL}"`));
      assert.match(initialize.responseText, /"name":"cloud-guanlan"/);

      const toolsList = fx.bridge.rpcCalls("tools/list").at(-1);
      assert.match(toolsList.responseText, /guanlan_whoami/);
      assert.match(toolsList.responseText, /guanlan_news_recent/);
      assert.match(toolsList.responseText, /"inputSchema"/);
    } finally {
      p0.dispose();
    }
  });

  test("whoami and news execute through Pi's tool pipeline, keep their structured output and ignore spoofed identity arguments", async () => {
    const p0 = await openSession();
    try {
      const spoofed = { accountId: FIXTURE.accounts.b, consumerId: FIXTURE.consumers.b, scopes: ["guanlan.read", "admin"] };
      const whoami = await callTool(p0, TOOL_WHOAMI, spoofed);

      assert.equal(whoami.isError, false);
      assert.deepEqual(identityOf(whoami), {
        accountId: FIXTURE.accounts.a,
        consumerId: FIXTURE.consumers.one,
        scopes: ["guanlan.read"],
      });
      assert.equal(contentText(whoami), JSON.stringify(identityOf(whoami)));
      assert.deepEqual(whoami.details, { server: "guanlan", tool: "guanlan_whoami" });

      // The extension event keeps the CallToolResult (content + structuredContent),
      // and the same call is visible on the wire with the model's arguments.
      const whoamiEvent = latestEvent(p0, TOOL_WHOAMI);
      assert.equal(whoamiEvent.isError, false);
      assert.deepEqual(whoamiEvent.structuredContent.structuredContent, identityOf(whoami));
      const whoamiCall = fx.bridge.toolCalls("guanlan_whoami").at(-1);
      assert.deepEqual(whoamiCall.json.params.arguments, spoofed);
      const whoamiToolCall = p0.capture.toolCalls.findLast((call) => call.toolName === TOOL_WHOAMI);
      assert.deepEqual(whoamiToolCall.input, spoofed);

      const news = await callTool(p0, TOOL_NEWS, { sourceId: FIXTURE.sources.main, limit: 5 });
      const page = pageOf(news);
      assert.equal(news.isError, false);
      assert.equal(page.limit, 5);
      assert.equal(page.count, 2);
      assert.equal(page.nextCursor, null);
      // ingested_at DESC: the long unread link, then the pending one; the
      // consumer-adopted row is history and must not appear by default.
      assert.deepEqual(page.items.map((item) => item.id), [FIXTURE.urls.long, FIXTURE.urls.one]);
      assert.deepEqual(
        page.items.map((item) => item.status),
        ["unread", "pending"],
      );
      const longItem = page.items.find((item) => item.id === FIXTURE.urls.long);
      assert.equal(longItem.url, FIXTURE.urls.long);
      assert.equal(longItem.url.length, FIXTURE.urls.long.length);
      assert.equal(longItem.sourceId, FIXTURE.sources.main);
      assert.equal(longItem.title, "Long link");
      assert.match(contentText(news), /# Cloud Guanlan news/);
      assert.ok(contentText(news).includes(FIXTURE.urls.long));

      const newsEvent = latestEvent(p0, TOOL_NEWS);
      assert.deepEqual(newsEvent.structuredContent.structuredContent, page);
      const newsCall = fx.bridge.toolCalls("guanlan_news_recent").at(-1);
      assert.deepEqual(newsCall.json.params.arguments, { sourceId: FIXTURE.sources.main, limit: 5 });
    } finally {
      p0.dispose();
    }
  });

  test("accounts and stable consumers are isolated from each other", async () => {
    const accountB = await createPocSession({ bridgeUrl: fx.url, token: "fixture-account-b" });
    await waitForMcpTools(accountB.session);
    try {
      const whoami = await callTool(accountB, TOOL_WHOAMI, {});
      assert.deepEqual(identityOf(whoami), {
        accountId: FIXTURE.accounts.b,
        consumerId: FIXTURE.consumers.b,
        scopes: ["guanlan.read"],
      });
      const news = await callTool(accountB, TOOL_NEWS, {});
      // No subscription is a positive empty answer, never "all sources".
      assert.equal(news.isError, false);
      assert.deepEqual(pageOf(news), { items: [], count: 0, limit: 20, nextCursor: null });
    } finally {
      accountB.dispose();
    }

    const consumerTwo = await createPocSession({ bridgeUrl: fx.url, token: "fixture-consumer-2" });
    await waitForMcpTools(consumerTwo.session);
    try {
      const defaultNews = await callTool(consumerTwo, TOOL_NEWS, { sourceId: FIXTURE.sources.main });
      // consumer-1's decisions do not leak into consumer-2's view.
      assert.deepEqual(
        pageOf(defaultNews).items.map((item) => item.id).sort(),
        [FIXTURE.urls.long, FIXTURE.urls.one, FIXTURE.urls.two].sort(),
      );
      assert.ok(pageOf(defaultNews).items.every((item) => item.status === "unread"));

      const adopted = await callTool(consumerTwo, TOOL_NEWS, {
        sourceId: FIXTURE.sources.main,
        status: ["adopted"],
      });
      assert.deepEqual(pageOf(adopted), { items: [], count: 0, limit: 20, nextCursor: null });
    } finally {
      consumerTwo.dispose();
    }

    const consumerOne = await openSession();
    try {
      const adopted = await callTool(consumerOne, TOOL_NEWS, {
        sourceId: FIXTURE.sources.main,
        status: ["adopted"],
      });
      assert.deepEqual(
        pageOf(adopted).items.map((item) => [item.id, item.status]),
        [[FIXTURE.urls.two, "adopted"]],
      );
    } finally {
      consumerOne.dispose();
    }
  });

  test("a cursor is bound to the verified identity and filter set", async () => {
    const consumerOne = await openSession();
    let cursor;
    try {
      const first = await callTool(consumerOne, TOOL_NEWS, { sourceId: FIXTURE.sources.page, limit: 2 });
      cursor = pageOf(first).nextCursor;
      assert.ok(cursor, "expected a continuation cursor");
    } finally {
      consumerOne.dispose();
    }

    const consumerTwo = await createPocSession({ bridgeUrl: fx.url, token: "fixture-consumer-2" });
    await waitForMcpTools(consumerTwo.session);
    try {
      const foreign = await callTool(consumerTwo, TOOL_NEWS, {
        sourceId: FIXTURE.sources.page,
        limit: 2,
        cursor,
      });
      assert.equal(foreign.isError, true);
      assert.match(contentText(foreign), /^guanlan_news_cursor_invalid:/);
    } finally {
      consumerTwo.dispose();
    }

    const again = await openSession();
    try {
      const changedFilter = await callTool(again, TOOL_NEWS, {
        sourceId: FIXTURE.sources.page,
        limit: 2,
        status: ["unread"],
        cursor,
      });
      assert.equal(changedFilter.isError, true);
      assert.match(contentText(changedFilter), /^guanlan_news_cursor_invalid:/);

      const tampered = await callTool(again, TOOL_NEWS, {
        sourceId: FIXTURE.sources.page,
        limit: 2,
        cursor: `${cursor}x`,
      });
      assert.equal(tampered.isError, true);
      assert.match(contentText(tampered), /^guanlan_news_cursor_invalid:/);
    } finally {
      again.dispose();
    }
  });

  test("pagination is exact and a scan-budget-limited page keeps a continuation cursor", async () => {
    const p0 = await openSession();
    try {
      const seen = [];
      let cursor;
      for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
        const page = pageOf(
          await callTool(p0, TOOL_NEWS, {
            sourceId: FIXTURE.sources.page,
            limit: 2,
            ...(cursor ? { cursor } : {}),
          }),
        );
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      const expected = Array.from({ length: 12 }, (_, index) => FIXTURE.urls.page(index + 1));
      assert.deepEqual(seen, expected, "no duplicate, no omission, stable ingested_at DESC order");
      assert.equal(cursor, null);

      const budgeted = pageOf(
        await callTool(p0, TOOL_NEWS, {
          sourceId: FIXTURE.sources.adopted,
          status: ["unread"],
          limit: 10,
        }),
      );
      assert.deepEqual(budgeted.items, []);
      assert.equal(budgeted.count, 0);
      assert.ok(budgeted.nextCursor, "budget exhaustion must not look like the end of the stream");

      const next = pageOf(
        await callTool(p0, TOOL_NEWS, {
          sourceId: FIXTURE.sources.adopted,
          status: ["unread"],
          limit: 10,
          cursor: budgeted.nextCursor,
        }),
      );
      assert.deepEqual(next.items, []);
      assert.equal(next.nextCursor, null);

      const unauthorizedSource = await callTool(p0, TOOL_NEWS, {
        sourceId: FIXTURE.sources.unsubscribed,
      });
      assert.equal(unauthorizedSource.isError, false);
      assert.deepEqual(pageOf(unauthorizedSource), { items: [], count: 0, limit: 20, nextCursor: null });
    } finally {
      p0.dispose();
    }
  });

  test("a permission extension blocks execution without touching the server", async () => {
    const p0 = await createPocSession({
      bridgeUrl: fx.url,
      token: "fixture-consumer-1",
      deniedTools: ["guanlan_news_recent"],
    });
    await waitForMcpTools(p0.session);
    try {
      assert.ok(activeMcpTools(p0.session).includes(TOOL_NEWS), "the tool stays declared to the model");
      const callsBefore = fx.bridge.toolCalls("guanlan_news_recent").length;

      const blocked = await callTool(p0, TOOL_NEWS, { limit: 1 });
      assert.equal(blocked.isError, true);
      assert.match(contentText(blocked), /P0 permission gate: guanlan_news_recent is not granted/);
      assert.deepEqual(p0.gate.blocked, ["guanlan_news_recent"]);
      assert.equal(fx.bridge.toolCalls("guanlan_news_recent").length, callsBefore);
      assert.equal(latestEvent(p0, TOOL_NEWS), undefined, "blocked calls never reach the MCP result path");

      const allowed = await callTool(p0, TOOL_WHOAMI, {});
      assert.equal(allowed.isError, false);

      const unknown = await callTool(p0, "mcp__guanlan__guanlan_delete", { id: "x" });
      assert.equal(unknown.isError, true);
      assert.match(contentText(unknown), /not found|unknown|available/i);
      assert.equal(fx.bridge.toolCalls("guanlan_delete").length, 0);
    } finally {
      p0.dispose();
    }
  });

  test("a timed-out MCP call is an explicit tool error and is cancelled on the wire", async () => {
    const p0 = await createPocSession({ bridgeUrl: fx.url, token: "fixture-consumer-1", timeoutSeconds: 1 });
    await waitForMcpTools(p0.session);
    try {
      fx.bridge.responseDelayMs = (record) =>
        record.json?.method === "tools/call" && record.json?.params?.name === "guanlan_whoami" ? 2500 : 0;
      const started = Date.now();
      const cancelMark = fx.bridge.rpcCalls("notifications/cancelled").length;
      const result = await callTool(p0, TOOL_WHOAMI, {});
      const elapsed = Date.now() - started;
      fx.bridge.responseDelayMs = () => 0;

      assert.ok(elapsed < 2500, `timed out before the delayed response (${elapsed}ms)`);
      assert.equal(result.isError, true);
      assert.match(contentText(result), /MCP request timed out after 1000ms/);

      const call = fx.bridge.toolCalls("guanlan_whoami").at(-1);
      await waitFor(
        () =>
          fx.bridge
            .rpcCalls("notifications/cancelled")
            .slice(cancelMark)
            .some((record) => record.json?.params?.requestId === call.json.id),
        { timeoutMs: 8000, label: "cancellation notification" },
      );
      const cancelled = fx.bridge
        .rpcCalls("notifications/cancelled")
        .slice(cancelMark)
        .find((record) => record.json?.params?.requestId === call.json.id);
      assert.equal(cancelled.json.params.reason, "Request timed out");
    } finally {
      fx.bridge.responseDelayMs = () => 0;
      p0.dispose();
    }
  });

  test("aborting the agent cancels an in-flight MCP call", async () => {
    const p0 = await createPocSession({ bridgeUrl: fx.url, token: "fixture-consumer-1", timeoutSeconds: 30 });
    await waitForMcpTools(p0.session);
    try {
      fx.bridge.responseDelayMs = (record) =>
        record.json?.method === "tools/call" && record.json?.params?.name === "guanlan_whoami" ? 3000 : 0;
      const prompt = scriptedToolCall(p0.session, p0.faux, TOOL_WHOAMI, {});
      await sleep(400);
      const cancelMark = fx.bridge.rpcCalls("notifications/cancelled").length;
      await p0.session.abort();
      await prompt.catch(() => {});

      const result = lastToolResult(p0.session, TOOL_WHOAMI);
      assert.equal(result.isError, true);
      assert.match(contentText(result), /MCP request aborted/);

      const call = fx.bridge.toolCalls("guanlan_whoami").at(-1);
      await waitFor(
        () =>
          fx.bridge
            .rpcCalls("notifications/cancelled")
            .slice(cancelMark)
            .some((record) => record.json?.params?.requestId === call.json.id),
        { timeoutMs: 5000, label: "abort cancellation notification" },
      );
      const cancelled = fx.bridge
        .rpcCalls("notifications/cancelled")
        .slice(cancelMark)
        .find((record) => record.json?.params?.requestId === call.json.id);
      assert.match(cancelled.json.params.reason, /Abort/i);
    } finally {
      fx.bridge.responseDelayMs = () => 0;
      p0.dispose();
    }
  });

  test("an interrupted transport reconnects on the next call", async () => {
    const p0 = await openSession();
    try {
      assert.equal((await callTool(p0, TOOL_WHOAMI, {})).isError, false);

      fx.bridge.dropConnections();
      const dropped = await callTool(p0, TOOL_WHOAMI, {});
      assert.equal(dropped.isError, true);
      assert.match(contentText(dropped), /fetch failed|ECONN|socket|network/i);
      const reconnected = await callTool(p0, TOOL_WHOAMI, {});
      assert.equal(reconnected.isError, false);

      await fx.bridge.stop();
      const offline = await callTool(p0, TOOL_WHOAMI, {});
      assert.equal(offline.isError, true);
      await fx.bridge.start();
      const online = await callTool(p0, TOOL_WHOAMI, {});
      assert.equal(online.isError, false);
    } finally {
      if (fx.bridge.port) {
        try {
          await fx.bridge.start();
        } catch {
          // already listening
        }
      }
      p0.dispose();
    }
  });

  test("rotating the test credential changes the verified identity in place", async () => {
    // Wiring proof only: the registration can be replaced and reconnected.
    // Production must NOT reuse a live session across consumers; a session is
    // single-identity even though the transport can be re-pointed.
    const p0 = await openSession();
    try {
      assert.deepEqual(identityOf(await callTool(p0, TOOL_WHOAMI, {})), {
        accountId: FIXTURE.accounts.a,
        consumerId: FIXTURE.consumers.one,
        scopes: ["guanlan.read"],
      });

      p0.rotateToken("fixture-consumer-2");
      let rotated;
      await waitFor(
        async () => {
          rotated = await callTool(p0, TOOL_WHOAMI, {});
          return identityOf(rotated)?.consumerId === FIXTURE.consumers.two;
        },
        { timeoutMs: 5000, intervalMs: 200, label: "rotated identity" },
      );
      assert.equal(identityOf(rotated).consumerId, FIXTURE.consumers.two);
      assert.deepEqual(activeMcpTools(p0.session), EXPECTED_TOOLS);
    } finally {
      p0.dispose();
    }
  });

  test("invalid credentials never expose tools or reach a tools/call", async () => {
    for (const token of ["fixture-wrong-scope", "fixture-expired", "fixture-missing-consumer"]) {
      const before = fx.bridge.requests.length;
      const p0 = await createPocSession({ bridgeUrl: fx.url, token });
      try {
        await sleep(1500);
        assert.deepEqual(activeMcpTools(p0.session), [], `${token} must not expose tools`);
        const attempts = fx.bridge.requests.slice(before);
        const initialize = attempts.filter((record) => record.json?.method === "initialize");
        assert.ok(initialize.length >= 1, `${token} must have attempted an MCP initialize`);
        assert.ok(
          initialize.some((record) => record.status >= 400),
          `${token} must be rejected by the server, saw ${initialize.map((record) => record.status).join(",")}`,
        );
        assert.equal(
          attempts.filter((record) => record.json?.method === "tools/call").length,
          0,
          `${token} must never reach a tool call`,
        );
      } finally {
        p0.dispose();
      }
    }
  });
});

describe("P0: storage failure is an explicit MCP tool error", () => {
  let broken;
  before(async () => {
    broken = await startGuanlanFixture();
    await seedBrokenFixture(broken.db);
  });
  after(async () => {
    await broken.dispose();
  });

  test("a failed news read is never downgraded to an empty page", async () => {
    const p0 = await createPocSession({ bridgeUrl: broken.url, token: "fixture-consumer-1" });
    await waitForMcpTools(p0.session);
    try {
      const whoami = await callTool(p0, TOOL_WHOAMI, {});
      assert.equal(whoami.isError, false);

      const news = await callTool(p0, TOOL_NEWS, {});
      assert.equal(news.isError, true);
      assert.match(contentText(news), /^guanlan_news_unavailable:/);
      assert.match(contentText(news), /could not be read/);
      const event = latestEvent(p0, TOOL_NEWS);
      assert.equal(event.isError, true);
      assert.equal(event.structuredContent.isError, true);
      assert.equal(event.structuredContent.structuredContent, undefined);
    } finally {
      p0.dispose();
    }
  });
});
