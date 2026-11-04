import { test } from "node:test";
import assert from "node:assert/strict";
import { createOwnerGateway, loadOwnerGatewayConfig, verifyCloudOwner } from "../src/api/owner-gateway.mjs";
const bearer = "Bearer mcs_v1.abcdefgh12345678";
const config = loadOwnerGatewayConfig({ CLOUD_AGENT_OWNER_ACCOUNT_ID: "owner-account-1" });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

test("config refuses absent owner and non-loopback peers", () => {
  assert.throws(() => loadOwnerGatewayConfig({}), /OWNER_ACCOUNT_ID/);
  assert.throws(() => loadOwnerGatewayConfig({ CLOUD_AGENT_OWNER_ACCOUNT_ID: "owner", CLOUD_AGENT_API_ORIGIN: "http://example.com" }), /127.0.0.1/);
});
test("Cloud Session must be active and belong to exact owner", async () => {
  assert.equal(await verifyCloudOwner(bearer, config, async (url, init) => {
    assert.equal(url, "http://127.0.0.1:8788/v1/auth/session");
    assert.equal(init.headers.authorization, bearer);
    return response({ account: { id: "owner-account-1" } });
  }), 200);
  assert.equal(await verifyCloudOwner(bearer, config, async () => response({ account: { id: "someone-else" } })), 403);
  assert.equal(await verifyCloudOwner(bearer, config, async () => response({}, 401)), 401);
  assert.equal(await verifyCloudOwner(bearer, config, async () => { throw Error("offline"); }), 503);
});
test("real HTTP denies guest, enforces origin and never forwards bearer", async (t) => {
  const forwarded = [];
  const gw = createOwnerGateway({
    config, authorize: async () => 200,
    requestAgent: async ({path,method,body}) => {
      forwarded.push({ url: "http://127.0.0.1:8787" + path, method, auth: undefined });
      return { status: 200, data: Buffer.from(JSON.stringify({ ok: true, data: { state: "up" } })) };
    },
  });
  const base = await gw.start(0);
  t.after(() => gw.stop());
  assert.equal((await fetch(base + "/v1/status")).status, 401);
  assert.equal(forwarded.length, 0);
  assert.equal((await fetch(base + "/v1/status", { headers: { authorization: bearer } })).status, 200);
  assert.equal(forwarded[0].auth, undefined);
  assert.equal(forwarded[0].url, "http://127.0.0.1:8787/v1/status");
  assert.equal((await fetch(base + "/v1/schedules", {
    method: "POST", headers: { authorization: bearer, "content-type": "application/json" }, body: "{}",
  })).status, 403);
  assert.equal(forwarded.length, 1);
  assert.equal((await fetch(base + "/v1/schedules", {
    method: "POST", headers: { authorization: bearer, origin: config.portalOrigin, "content-type": "application/json" }, body: "{}",
  })).status, 200);
  assert.equal(forwarded.length, 2);
  assert.equal((await fetch(base + "/v1/schedules/%2e%2e", { headers: { authorization: bearer } })).status, 404);
  assert.equal(forwarded.length, 2);
});
test("non-owner cannot read private run history", async (t) => {
  let calls = 0;
  const gw = createOwnerGateway({ config, authorize: async () => 403, requestAgent: async () => { calls++; return { status: 200, data: Buffer.from("{}") }; } });
  const base = await gw.start(0);
  t.after(() => gw.stop());
  assert.equal((await fetch(base + "/v1/runs", { headers: { authorization: bearer } })).status, 403);
  assert.equal(calls, 0);
});
