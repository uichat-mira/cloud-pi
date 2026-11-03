/**
 * AGT-033 T2: official Feishu send call shape and error mapping.
 *
 * The official SDK client is injected so the test observes exactly the payload
 * the locked `@larksuiteoapi/node-sdk@1.76.0` would receive:
 * `client.im.message.create({ params: { receive_id_type }, data: {...} })`.
 * No network call is made and no real credential is used.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FeishuSendError,
  createFeishuTransport,
} from "../src/channels/feishu/transport.mjs";

const CONFIG = Object.freeze({
  appId: "cli_test_0001",
  appSecret: "not-a-real-secret",
  domain: "feishu",
  allowedChatIds: ["oc_test_group_0001"],
  botOpenId: undefined,
});

function transportWith(fake) {
  return createFeishuTransport({
    config: CONFIG,
    onEvent: async () => {},
    client: fake.client,
    log: fake.log,
  });
}

describe("AGT-033 T2: Feishu proactive send", () => {
  test("sends to a personal open_id through im.message.create", async () => {
    const calls = [];
    const transport = transportWith({
      client: {
        im: {
          message: {
            async create(payload) {
              calls.push(payload);
              return { code: 0, msg: "ok", data: { message_id: "om_person_1" } };
            },
          },
        },
      },
    });
    const result = await transport.send({
      receiveIdType: "open_id",
      receiveId: "ou_person1",
      text: "hello person",
      uuid: "uuid-person",
    });
    assert.deepEqual(result, { messageId: "om_person_1" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, { receive_id_type: "open_id" });
    assert.equal(calls[0].data.receive_id, "ou_person1");
    assert.equal(calls[0].data.msg_type, "text");
    assert.deepEqual(JSON.parse(calls[0].data.content), { text: "hello person" });
    assert.equal(calls[0].data.uuid, "uuid-person");
  });

  test("sends to a group chat_id through the same call", async () => {
    const calls = [];
    const transport = transportWith({
      client: {
        im: {
          message: {
            async create(payload) {
              calls.push(payload);
              return { code: 0, data: { message_id: "om_group_1" } };
            },
          },
        },
      },
    });
    const result = await transport.send({
      receiveIdType: "chat_id",
      receiveId: "oc_test_group_0001",
      text: "hello group",
    });
    assert.deepEqual(result, { messageId: "om_group_1" });
    assert.deepEqual(calls[0].params, { receive_id_type: "chat_id" });
    assert.equal(calls[0].data.receive_id, "oc_test_group_0001");
    assert.equal(Object.hasOwn(calls[0].data, "uuid"), false);
  });

  test("a rate-limit business code is retryable; an invalid-receive code is not", async () => {
    let response = { code: 99991400, msg: "frequency limit" };
    const transport = transportWith({
      client: {
        im: {
          message: {
            async create() {
              return response;
            },
          },
        },
      },
    });
    await assert.rejects(
      transport.send({ receiveIdType: "open_id", receiveId: "ou_person1", text: "x" }),
      (error) =>
        error instanceof FeishuSendError &&
        error.code === "feishu_api_error" &&
        error.feishuCode === 99991400 &&
        error.retryable === true,
    );
    response = { code: 230001, msg: "invalid receive_id" };
    await assert.rejects(
      transport.send({ receiveIdType: "open_id", receiveId: "ou_missing", text: "x" }),
      (error) => error instanceof FeishuSendError && error.retryable === false && error.feishuCode === 230001,
    );
  });

  test("an SDK-thrown HTTP business rejection is classified, not treated as a network error", async () => {
    const thrown = (code) => {
      const error = new Error("Request failed with status code 400");
      error.code = "ERR_BAD_REQUEST";
      error.response = { status: 400, data: { code, msg: "invalid open_id" } };
      return error;
    };
    const transport = transportWith({
      client: {
        im: {
          message: {
            async create() {
              throw thrown(99992351);
            },
          },
        },
      },
    });
    await assert.rejects(
      transport.send({ receiveIdType: "open_id", receiveId: "ou_missing", text: "x" }),
      (error) =>
        error instanceof FeishuSendError &&
        error.code === "feishu_api_error" &&
        error.feishuCode === 99992351 &&
        error.retryable === false,
    );
    const limited = transportWith({
      client: {
        im: {
          message: {
            async create() {
              throw thrown(99991400);
            },
          },
        },
      },
    });
    await assert.rejects(
      limited.send({ receiveIdType: "open_id", receiveId: "ou_person1", text: "x" }),
      (error) => error instanceof FeishuSendError && error.feishuCode === 99991400 && error.retryable === true,
    );
  });

  test("a network failure is retryable", async () => {
    const transport = transportWith({
      client: {
        im: {
          message: {
            async create() {
              throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
            },
          },
        },
      },
    });
    await assert.rejects(
      transport.send({ receiveIdType: "chat_id", receiveId: "oc_test_group_0001", text: "x" }),
      (error) => error instanceof FeishuSendError && error.code === "feishu_network_error" && error.retryable,
    );
  });

  test("a response without message_id is a terminal failure, not a silent success", async () => {
    const transport = transportWith({
      client: {
        im: {
          message: {
            async create() {
              return { code: 0, data: {} };
            },
          },
        },
      },
    });
    await assert.rejects(
      transport.send({ receiveIdType: "open_id", receiveId: "ou_person1", text: "x" }),
      (error) => error instanceof FeishuSendError && error.code === "missing_message_id" && !error.retryable,
    );
  });

  test("invalid destinations fail before any SDK call", async () => {
    let called = false;
    const transport = transportWith({
      client: {
        im: {
          message: {
            async create() {
              called = true;
              return { code: 0, data: { message_id: "om" } };
            },
          },
        },
      },
    });
    for (const request of [
      { receiveIdType: "chat_id", receiveId: "ou_wrong", text: "x" },
      { receiveIdType: "email", receiveId: "a@b.c", text: "x" },
      { receiveIdType: "open_id", receiveId: "oc_wrong", text: "x" },
      { receiveIdType: "open_id", receiveId: "ou_person1", text: "" },
      { receiveIdType: "open_id", receiveId: "ou_person1", text: "x", uuid: "u".repeat(65) },
    ]) {
      await assert.rejects(transport.send(request), FeishuSendError);
    }
    assert.equal(called, false);
  });

  test("the existing reply path still uses im.message.reply", async () => {
    const calls = [];
    const transport = transportWith({
      client: {
        im: {
          message: {
            async reply(payload) {
              calls.push(payload);
              return { code: 0, data: { message_id: "om_reply" } };
            },
          },
        },
      },
    });
    const result = await transport.reply("om_inbound", "answer");
    assert.deepEqual(result, { messageId: "om_reply" });
    assert.deepEqual(calls[0].path, { message_id: "om_inbound" });
    assert.deepEqual(JSON.parse(calls[0].data.content), { text: "answer" });
  });
});
