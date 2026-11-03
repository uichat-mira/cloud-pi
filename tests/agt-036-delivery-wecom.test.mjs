/**
 * AGT-036 delivery wiring: the coordinator's WeCom half.
 *
 * Only two boundaries are faked:
 *
 *  - the WeCom transport's `send()` (the network call);
 *  - the known-session registry, when a test needs to script "never messaged us".
 *
 * Everything else is the production module: the coordinator, the delivery store,
 * the message formatter, the real WeCom sender and the real composition root.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudAgentApp } from "../src/app.mjs";
import { createKnownSessionStore } from "../src/channels/wecom/sessions.mjs";
import { WecomTransportError } from "../src/channels/wecom/transport.mjs";
import { createDeliveryCoordinator } from "../src/delivery/index.mjs";
import { DELIVERY_ERROR, DELIVERY_RUN_STATUS, DELIVERY_STATUS } from "../src/delivery/contracts.mjs";
import { createWecomDeliverySender } from "../src/delivery/wecom-sender.mjs";
import { RUN_ID, fakeSendMessage, makeRun } from "./helpers/delivery-fixture.mjs";
import { fakeAppDeps } from "./helpers/app-fixture.mjs";

const CLOCK = () => new Date("2026-11-04T02:30:00.000Z");
const WECOM_USER_TARGET = Object.freeze([{ type: "wecom_user", id: "zhangsan", label: "单聊" }]);
const WECOM_CHAT_TARGET = Object.freeze([{ type: "wecom_chat", id: "wr_chat_0001", label: "群" }]);

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "cloud-pi-agt-036-delivery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A WeCom transport double. `failures` is consumed in order: an Error to throw,
 * or null to accept.
 */
function fakeWecomTransport({ failures = [] } = {}) {
  const calls = [];
  async function send(input) {
    calls.push({ ...input });
    const scripted = failures.length > 0 ? failures.shift() : null;
    if (scripted) throw scripted;
    return { delivered: true, errcode: 0 };
  }
  return { send, calls };
}

function knownSessions(entries) {
  const store = createKnownSessionStore({ now: Date.now });
  for (const entry of entries) store.record(entry);
  return store;
}

async function setup(t, { failures = [], sessions, targets = WECOM_USER_TARGET, limits = {}, feishu } = {}) {
  const root = await tempRoot(t);
  const transport = fakeWecomTransport({ failures });
  const sender = createWecomDeliverySender({
    send: transport.send,
    sessions: sessions === null ? undefined : (sessions ?? knownSessions([{ chatId: "zhangsan", chatType: "single" }])),
  });
  const feishuTransport = feishu ?? fakeSendMessage();
  const coordinator = createDeliveryCoordinator({
    stateDir: join(root, "delivery"),
    env: {},
    now: CLOCK,
    sendMessage: feishuTransport.sendMessage,
    senders: sender.senders,
    researchRunsDir: join(root, "runs"),
    readRun: async () => makeRun(),
    limits: { retryDelayMs: 0, ...limits },
  });
  const view = await coordinator.deliverRun({
    runId: RUN_ID,
    researchStatus: "completed",
    triggerStatus: "succeeded",
    schedule: { scheduleId: "wecom-daily", name: "企业微信日报", deliveryTargets: targets },
  });
  return { root, transport, feishuTransport, coordinator, view };
}

describe("AGT-036 delivery: WeCom targets reach the channel transport", () => {
  test("a wecom_user target is pushed through the channel and recorded as sent", async (t) => {
    const { transport, view, coordinator } = await setup(t);

    assert.equal(view.deliveryStatus, DELIVERY_RUN_STATUS.SENT);
    assert.deepEqual(view.counts, { total: 1, sent: 1, failed: 0, pending: 0 });
    assert.equal(view.targets[0].destination.type, "wecom_user");
    // A short userid would come back unchanged from `maskId`, which would publish
    // a raw recipient; the operator view must fall back to a hash instead.
    assert.notEqual(view.targets[0].destination.maskedId, "zhangsan");
    assert.match(view.targets[0].destination.maskedId, /^id:[0-9a-f]+$/);

    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].chatId, "zhangsan");
    assert.equal(transport.calls[0].chatType, "single");
    assert.match(transport.calls[0].text, /fixture 报告正文/);

    // The platform returns no message id for a push, so the stable segment uuid
    // is the local handle and the platform ack is stored next to it.
    const [record] = await coordinator.listRecords(RUN_ID);
    assert.equal(record.status, DELIVERY_STATUS.SENT);
    assert.equal(record.segmentsSent.length, 1);
    assert.match(record.segmentsSent[0].messageId, /^[0-9a-f]{32}$|^.+$/);
    assert.deepEqual(record.segmentsSent[0].ack, { errcode: 0 });
    assert.equal(record.scheduleId, "wecom-daily");
    assert.equal(record.runId, RUN_ID);
  });

  test("a wecom_chat target is pushed as a group message", async (t) => {
    const { transport, view } = await setup(t, {
      targets: WECOM_CHAT_TARGET,
      sessions: knownSessions([{ chatId: "wr_chat_0001", chatType: "group" }]),
    });
    assert.equal(view.deliveryStatus, DELIVERY_RUN_STATUS.SENT);
    assert.equal(transport.calls[0].chatType, "group");
    assert.equal(transport.calls[0].chatId, "wr_chat_0001");
  });

  test("a conversation the bot has never seen fails with session_unknown and sends nothing", async (t) => {
    const { transport, view, coordinator } = await setup(t, {
      sessions: knownSessions([{ chatId: "someone-else", chatType: "single" }]),
    });

    assert.equal(view.deliveryStatus, DELIVERY_RUN_STATUS.FAILED);
    assert.equal(transport.calls.length, 0, "an impossible push must not touch the wire");
    const [record] = await coordinator.listRecords(RUN_ID);
    assert.equal(record.lastError.code, DELIVERY_ERROR.SESSION_UNKNOWN);
    assert.equal(record.lastError.retryable, false);
    // Terminal by design: retrying cannot make the platform accept it, so the
    // attempt budget is not burned.
    assert.equal(record.attempts, 1);
    assert.match(record.lastError.message, /no_prior_inbound/);
  });

  test("a channel-type mismatch is reported, not guessed", async (t) => {
    const { transport, view } = await setup(t, {
      targets: WECOM_USER_TARGET,
      sessions: knownSessions([{ chatId: "zhangsan", chatType: "group" }]),
    });
    assert.equal(view.deliveryStatus, DELIVERY_RUN_STATUS.FAILED);
    assert.equal(transport.calls.length, 0);
  });

  test("without a known-session store the sender refuses to push blindly", async (t) => {
    const { transport, view } = await setup(t, { sessions: null });
    assert.equal(view.deliveryStatus, DELIVERY_RUN_STATUS.FAILED);
    assert.equal(transport.calls.length, 0);
    assert.equal(view.targets[0].lastError.code, DELIVERY_ERROR.CHANNEL_UNAVAILABLE);
  });

  test("a rate-limited push is retried within the bounded budget and finally fails by code", async (t) => {
    const limited = () => new WecomTransportError("rate_limited", "retry after ~30s", { retryable: true });
    const { transport, view, coordinator } = await setup(t, {
      failures: [limited(), limited(), limited(), limited()],
    });

    assert.equal(transport.calls.length, 3, "maxAttempts bounds the retries");
    assert.equal(view.deliveryStatus, DELIVERY_RUN_STATUS.FAILED);
    const [record] = await coordinator.listRecords(RUN_ID);
    assert.equal(record.lastError.code, DELIVERY_ERROR.RATE_LIMITED);
    assert.equal(record.attempts, 3);
  });

  test("a transient transport failure is retried, and a later attempt is recorded as sent", async (t) => {
    const { transport, view } = await setup(t, {
      failures: [new WecomTransportError("send_failed", "socket closed", { retryable: true })],
    });
    assert.equal(transport.calls.length, 2);
    assert.equal(view.deliveryStatus, DELIVERY_RUN_STATUS.SENT);
  });

  test("the 20480-byte limit is enforced before the wire, and the boundary still sends", async () => {
    const sent = [];
    const sender = createWecomDeliverySender({
      send: async (input) => {
        sent.push(input.text);
        return { delivered: true, errcode: 0 };
      },
      sessions: knownSessions([{ chatId: "zhangsan", chatType: "single" }]),
    });

    // 20480 bytes of ASCII is allowed…
    await sender.deliver({ receiveIdType: "wecom_user", receiveId: "zhangsan", text: "a".repeat(20_480), uuid: "u1" });
    assert.equal(sent.length, 1);

    // …one byte more is refused with a code, never truncated.
    await assert.rejects(
      () => sender.deliver({ receiveIdType: "wecom_user", receiveId: "zhangsan", text: "b".repeat(20_481), uuid: "u2" }),
      (error) => {
        assert.equal(error.code, DELIVERY_ERROR.SEGMENT_TOO_LARGE);
        return true;
      },
    );
    assert.equal(sent.length, 1);
  });

  test("CJK content is measured in bytes, not codepoints", async () => {
    const sender = createWecomDeliverySender({
      send: async () => ({ delivered: true, errcode: 0 }),
      sessions: knownSessions([{ chatId: "zhangsan", chatType: "single" }]),
    });
    // 7000 CJK characters = 21000 bytes > 20480, even though 7000 chars < 20480.
    await assert.rejects(
      () => sender.deliver({ receiveIdType: "wecom_user", receiveId: "zhangsan", text: "报".repeat(7_000), uuid: "u1" }),
      (error) => {
        assert.equal(error.code, DELIVERY_ERROR.SEGMENT_TOO_LARGE);
        return true;
      },
    );
  });
});

describe("AGT-036 delivery: namespaces stay separate", () => {
  test("a WeCom target is never handed to the Feishu transport when no WeCom sender exists", async (t) => {
    const root = await tempRoot(t);
    const feishu = fakeSendMessage();
    const coordinator = createDeliveryCoordinator({
      stateDir: join(root, "delivery"),
      env: {},
      now: CLOCK,
      sendMessage: feishu.sendMessage,
      researchRunsDir: join(root, "runs"),
      readRun: async () => makeRun(),
      limits: { retryDelayMs: 0 },
    });
    const view = await coordinator.deliverRun({
      runId: RUN_ID,
      researchStatus: "completed",
      triggerStatus: "succeeded",
      schedule: { scheduleId: "s", name: "s", deliveryTargets: WECOM_USER_TARGET },
    });
    // The W1 refusal semantics survive: nothing is sent, and the reason is explicit.
    assert.equal(view.reason, "unsupported_target_type");
    assert.equal(feishu.calls.length, 0);
  });

  test("one run can address a Feishu and a WeCom destination at once, each through its own sender", async (t) => {
    const { transport, feishuTransport, view } = await setup(t, {
      targets: [
        { type: "wecom_user", id: "zhangsan", label: "单聊" },
        { type: "open_id", id: "ou_testperson0001", label: "飞书" },
      ],
    });

    assert.equal(view.deliveryStatus, DELIVERY_RUN_STATUS.SENT);
    assert.deepEqual(view.counts, { total: 2, sent: 2, failed: 0, pending: 0 });
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].chatId, "zhangsan");
    assert.equal(feishuTransport.calls.length, 1);
    assert.equal(feishuTransport.calls[0].receiveIdType, "open_id");
    assert.equal(feishuTransport.calls[0].receiveId, "ou_testperson0001");
  });
});

describe("AGT-036 delivery: composition root wiring", () => {
  function appWith(overrides = {}) {
    const deps = fakeAppDeps();
    const captured = {};
    const wecomTransport = fakeWecomTransport();
    const app = createCloudAgentApp({
      env: { CLOUD_AGENT_CHANNELS: "wecom", WECOM_BOT_ID: "id", WECOM_BOT_SECRET: "secret" },
      config: {
        channels: { mode: "wecom", enabled: ["wecom"], skipped: [] },
        stateDir: overrides.stateDir,
        runsDir: overrides.stateDir,
        api: { host: "127.0.0.1", port: 0 },
        tickIntervalMs: 1_000,
        shutdownTimeoutMs: 1_000,
        wecomSecretsPath: null,
        pid: 1,
      },
      deps: {
        ...deps,
        createDeliveringScheduler: async (options) => {
          captured.delivery = options.delivery;
          return deps.delivering;
        },
        startWecom: async () => {
          const sessions = knownSessions([{ chatId: "zhangsan", chatType: "single" }]);
          return {
            sessions,
            transport: wecomTransport,
            describe: () => ({ config: {} }),
            async stop() {
              return { drained: true };
            },
          };
        },
        ...overrides.deps,
      },
    });
    return { app, captured, wecomTransport, deps };
  }

  test("the coordinator receives WeCom senders that use the channel's own transport", async (t) => {
    const stateDir = await tempRoot(t);
    const { app, captured, wecomTransport } = appWith({ stateDir });
    t.after(() => app.stop().catch(() => {}));
    await app.start();

    assert.ok(captured.delivery.senders?.wecom_user, "the composition root wires wecom_user");
    assert.ok(captured.delivery.senders?.wecom_chat, "the composition root wires wecom_chat");

    const acked = await captured.delivery.senders.wecom_user({
      receiveIdType: "wecom_user",
      receiveId: "zhangsan",
      text: "一条推送",
      uuid: "seg-1",
    });
    assert.equal(wecomTransport.calls.length, 1);
    assert.equal(wecomTransport.calls[0].chatType, "single");
    assert.equal(typeof acked.messageId, "string");
    assert.deepEqual(acked.ack, { errcode: 0 });

    assert.equal(app.describe().delivery.wecomSender, true);
  });

  test("with no WeCom channel running, the sender fails with channel_unavailable instead of crashing", async (t) => {
    const stateDir = await tempRoot(t);
    const { app, captured } = appWith({
      stateDir,
      deps: {
        startWecom: async () => {
          throw new Error("should not start");
        },
      },
    });
    const offline = createCloudAgentApp({
      env: { CLOUD_AGENT_CHANNELS: "none" },
      config: {
        channels: { mode: "none", enabled: [], skipped: [] },
        stateDir,
        runsDir: stateDir,
        api: { host: "127.0.0.1", port: 0 },
        tickIntervalMs: 1_000,
        shutdownTimeoutMs: 1_000,
        wecomSecretsPath: null,
        pid: 1,
      },
      deps: {
        ...fakeAppDeps(),
        createDeliveringScheduler: async (options) => {
          captured.delivery = options.delivery;
          return fakeAppDeps().delivering;
        },
      },
    });
    t.after(() => offline.stop().catch(() => {}));
    await offline.start();
    assert.equal(offline.describe().delivery.wecomSender, false);

    await assert.rejects(
      () =>
        captured.delivery.senders.wecom_user({
          receiveIdType: "wecom_user",
          receiveId: "zhangsan",
          text: "一条推送",
          uuid: "seg-1",
        }),
      (error) => {
        assert.equal(error.code, DELIVERY_ERROR.CHANNEL_UNAVAILABLE);
        return true;
      },
    );
  });

  test("the unknown-session pre-check can be disabled explicitly for a fresh process", async (t) => {
    const stateDir = await tempRoot(t);
    const deps = fakeAppDeps();
    const captured = {};
    const transport = fakeWecomTransport();
    const app = createCloudAgentApp({
      // A restarted process has an empty registry but the platform may still know
      // the conversation; the operator opts out of the local pre-check.
      env: {
        CLOUD_AGENT_CHANNELS: "wecom",
        WECOM_BOT_ID: "id",
        WECOM_BOT_SECRET: "secret",
        WECOM_DELIVERY_ALLOW_UNKNOWN_SESSION: "1",
      },
      config: {
        channels: { mode: "wecom", enabled: ["wecom"], skipped: [] },
        stateDir,
        runsDir: stateDir,
        api: { host: "127.0.0.1", port: 0 },
        tickIntervalMs: 1_000,
        shutdownTimeoutMs: 1_000,
        wecomSecretsPath: null,
        pid: 1,
      },
      deps: {
        ...deps,
        createDeliveringScheduler: async (options) => {
          captured.delivery = options.delivery;
          return deps.delivering;
        },
        startWecom: async () => ({
          sessions: createKnownSessionStore({}),
          transport,
          describe: () => ({ config: {} }),
          async stop() {
            return { drained: true };
          },
        }),
      },
    });
    t.after(() => app.stop().catch(() => {}));
    await app.start();

    const acked = await captured.delivery.senders.wecom_user({
      receiveIdType: "wecom_user",
      receiveId: "someone-new",
      text: "推送",
      uuid: "seg-1",
    });
    assert.equal(transport.calls.length, 1);
    assert.equal(acked.ack.errcode, 0);
  });
});

describe("AGT-036 delivery: persisted evidence", () => {
  test("the record on disk carries the ack but the file name stays a hash", async (t) => {
    const { root } = await setup(t);
    const dir = join(root, "delivery", "runs", RUN_ID);
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{32}\.json$/);
    const record = JSON.parse(await readFile(join(dir, files[0]), "utf8"));
    assert.equal(record.destination.type, "wecom_user");
    assert.equal(record.destination.id, "zhangsan");
    assert.equal(record.segmentsSent[0].ack.errcode, 0);
    assert.equal(record.contractVersion, 1, "DELIVERY_CONTRACT_VERSION is unchanged");
  });
});
