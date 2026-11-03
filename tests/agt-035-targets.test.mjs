/**
 * AGT-035 — target resolution tests (offline, no network).
 *
 * Everything here is a pure function or a test double of the official SDK
 * client: no Feishu request, no message send, no research run.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  REJECT_REASON,
  TARGET_LIMITS,
  TARGET_TYPE,
  TargetResolutionError,
  UNAVAILABLE_REASON,
  createFeishuChatDirectory,
  listBotChats,
  maskTarget,
  resolveTargets,
  toDeliveryTargets,
} from "../src/delivery/targets.mjs";

const GROUP = { chatId: "oc_0931aaaabbbbcccc", name: "东热战神", chatMode: "group" };
const MAINTAINER = "ou_f7a1b2c3d4e5f6a7b8c9d0e1f2a381a5";

function pagingClient(pages) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async request({ method, url, params }) {
      calls.push({ method, url, params });
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return page;
    },
  };
}

test("group present in bot chats and in the controlled allowlist resolves to chat_id", () => {
  const result = resolveTargets({
    authorizedChatIds: [GROUP.chatId],
    botChats: [GROUP],
    wantedGroups: ["东热战神"],
  });
  assert.equal(result.counts.targets, 1);
  assert.equal(result.targets[0].type, TARGET_TYPE.CHAT_ID);
  assert.equal(result.targets[0].id, GROUP.chatId);
  assert.equal(result.targets[0].label, "东热战神");
  assert.equal(result.targets[0].provenance, "bot_chat+controlled_allowlist");
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.rejected, []);
});

test("a group the bot has not joined is unavailable with an invite action, never a guessed id", () => {
  const result = resolveTargets({
    authorizedChatIds: [GROUP.chatId],
    botChats: [{ chatId: "oc_othergroup", name: "别的群", chatMode: "group" }],
    wantedGroups: ["东热战神"],
  });
  assert.equal(result.counts.targets, 0);
  assert.equal(result.counts.unavailable, 1);
  assert.equal(result.unavailable[0].reason, UNAVAILABLE_REASON.BOT_NOT_IN_CHAT);
  assert.equal(result.unavailable[0].action, "invite_bot");
});

test("a joined group outside the allowlist is rejected, not silently targeted", () => {
  const result = resolveTargets({
    authorizedChatIds: ["oc_someother"],
    botChats: [GROUP],
    wantedGroups: ["东热战神"],
  });
  assert.equal(result.counts.targets, 0);
  assert.equal(result.rejected[0].reason, REJECT_REASON.CHAT_NOT_AUTHORIZED);
  assert.ok(!JSON.stringify(result.rejected).includes(GROUP.chatId), "rejection evidence must be masked");
});

test("two chats sharing the wanted name are ambiguous and produce no target", () => {
  const result = resolveTargets({
    authorizedChatIds: [GROUP.chatId, "oc_0931bbbbddddeeee"],
    botChats: [GROUP, { chatId: "oc_0931bbbbddddeeee", name: "东热战神", chatMode: "group" }],
    wantedGroups: ["东热战神"],
  });
  assert.equal(result.counts.targets, 0);
  assert.equal(result.unavailable[0].reason, UNAVAILABLE_REASON.CHAT_NAME_AMBIGUOUS);
  assert.equal(result.unavailable[0].candidates.length, 2);
  assert.ok(!JSON.stringify(result.unavailable).includes("oc_0931bbbbddddeeee"));
});

test("a chat id passed as a group name never becomes a recipient", () => {
  const result = resolveTargets({
    authorizedChatIds: [GROUP.chatId],
    botChats: [GROUP],
    wantedGroups: [GROUP.chatId],
  });
  assert.equal(result.counts.targets, 0);
  assert.equal(result.unavailable[0].reason, UNAVAILABLE_REASON.BOT_NOT_IN_CHAT);
});

test("a confirmed private sender that was actually observed resolves to open_id", () => {
  const result = resolveTargets({
    observedP2pSenderIds: [MAINTAINER],
    confirmedP2pOpenIds: [MAINTAINER],
  });
  assert.equal(result.counts.targets, 1);
  assert.equal(result.targets[0].type, TARGET_TYPE.OPEN_ID);
  assert.equal(result.targets[0].id, MAINTAINER);
  assert.equal(result.targets[0].provenance, "p2p_event+explicit_confirmation");
});

test("a confirmed person who never sent a real private message is unavailable, not fabricated", () => {
  const result = resolveTargets({
    observedP2pSenderIds: [],
    confirmedP2pOpenIds: [MAINTAINER],
  });
  assert.equal(result.counts.targets, 0);
  assert.equal(result.unavailable[0].reason, UNAVAILABLE_REASON.OPEN_ID_NOT_OBSERVED);
  assert.equal(result.unavailable[0].action, "send_first_dm");
});

test("an observed but unconfirmed private sender is rejected", () => {
  const result = resolveTargets({
    observedP2pSenderIds: [MAINTAINER],
    confirmedP2pOpenIds: [],
  });
  assert.equal(result.counts.targets, 0);
  assert.equal(result.rejected[0].reason, REJECT_REASON.OPEN_ID_NOT_CONFIRMED);
  assert.ok(!JSON.stringify(result.rejected).includes(MAINTAINER));
});

test("a confirmed value that is not an ou_ id is rejected", () => {
  const result = resolveTargets({
    observedP2pSenderIds: ["oc_notaperson"],
    confirmedP2pOpenIds: ["oc_notaperson"],
  });
  assert.equal(result.counts.targets, 0);
  assert.equal(result.rejected[0].reason, REJECT_REASON.INVALID_OPEN_ID);
});

test("asking for the same group twice yields one target and one duplicate rejection", () => {
  const result = resolveTargets({
    authorizedChatIds: [GROUP.chatId],
    botChats: [GROUP],
    wantedGroups: ["东热战神", "东热战神"],
  });
  assert.equal(result.counts.targets, 1);
  assert.equal(result.rejected[0].reason, REJECT_REASON.DUPLICATE_TARGET);
});

test("targets are capped at the AGT-033 contract limit", () => {
  const chats = Array.from({ length: 11 }, (_, i) => ({
    chatId: `oc_group${String(i).padStart(4, "0")}`,
    name: `群${i}`,
    chatMode: "group",
  }));
  const result = resolveTargets({
    authorizedChatIds: chats.map((chat) => chat.chatId),
    botChats: chats,
    wantedGroups: chats.map((chat) => chat.name),
  });
  assert.equal(result.counts.targets, TARGET_LIMITS.maxTargets);
  assert.ok(result.rejected.some((entry) => entry.reason === REJECT_REASON.TOO_MANY_TARGETS));
});

test("invalid chat entries are dropped instead of becoming recipients", () => {
  const result = resolveTargets({
    authorizedChatIds: ["not-a-chat"],
    botChats: [{ chatId: "not-a-chat", name: "假群" }],
    wantedGroups: ["假群"],
  });
  assert.equal(result.counts.targets, 0);
  assert.ok(result.rejected.some((entry) => entry.reason === REJECT_REASON.INVALID_CHAT_ENTRY));
});

test("listBotChats paginates, deduplicates by chat id and stops when has_more is false", async () => {
  const client = pagingClient([
    {
      code: 0,
      data: {
        has_more: true,
        page_token: "page-2",
        items: [
          { chat_id: "oc_page1aaa", name: "群A", chat_mode: "group" },
          { chat_id: "oc_page1bbb", name: "群B", chat_mode: "group" },
        ],
      },
    },
    {
      code: 0,
      data: {
        has_more: false,
        items: [
          { chat_id: "oc_page1aaa", name: "群A", chat_mode: "group" },
          { chat_id: "oc_page2ccc", name: "群C", chat_mode: "group" },
        ],
      },
    },
  ]);
  const result = await listBotChats({ client });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].params.page_token, "page-2");
  assert.equal(result.chats.length, 3);
  assert.equal(result.hasMore, false);
  assert.equal(result.pagesRead, 2);
  assert.equal(result.truncated, false);
});

test("listBotChats is bounded by maxPages", async () => {
  let counter = 0;
  const client = {
    async request() {
      counter += 1;
      return {
        code: 0,
        data: { has_more: true, page_token: `next-${counter}`, items: [] },
      };
    },
  };
  const result = await listBotChats({ client, maxPages: 2 });
  assert.equal(counter, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.hasMore, true);
});

test("listBotChats fails closed on a Feishu business error", async () => {
  const client = { async request() { return { code: 99991672, msg: "no permission" }; } };
  await assert.rejects(
    () => listBotChats({ client }),
    (error) => error instanceof TargetResolutionError && error.code === "chat_list_failed",
  );
});

test("listBotChats fails closed when the SDK throws a business rejection", async () => {
  const client = {
    async request() {
      const error = new Error("Request failed with status code 400");
      error.response = { data: { code: 230027, msg: "invalid param" } };
      throw error;
    },
  };
  await assert.rejects(
    () => listBotChats({ client }),
    (error) => error instanceof TargetResolutionError && error.code === "chat_list_failed",
  );
});

test("listBotChats skips malformed chat ids and rows without a name", async () => {
  const client = pagingClient([
    {
      code: 0,
      data: {
        has_more: false,
        items: [
          { chat_id: "oc_good0001", name: "好群" },
          { chat_id: "bad_id", name: "坏群" },
          { chat_id: "oc_noname01" },
        ],
      },
    },
  ]);
  const result = await listBotChats({ client });
  assert.equal(result.chats.length, 2);
  assert.equal(result.chats[0].chatId, "oc_good0001");
  assert.equal(result.chats[1].name, "");
});

test("createFeishuChatDirectory requires credentials unless a client is injected", () => {
  assert.throws(
    () => createFeishuChatDirectory({ config: {} }),
    (error) => error instanceof TargetResolutionError && error.code === "config_missing",
  );
  const directory = createFeishuChatDirectory({
    client: pagingClient([{ code: 0, data: { has_more: false, items: [GROUP] } }]),
  });
  assert.equal(typeof directory.listChats, "function");
});

test("toDeliveryTargets emits only the AGT-033 contract fields", () => {
  const resolution = resolveTargets({
    authorizedChatIds: [GROUP.chatId],
    botChats: [GROUP],
    wantedGroups: ["东热战神"],
    observedP2pSenderIds: [MAINTAINER],
    confirmedP2pOpenIds: [MAINTAINER],
  });
  const targets = toDeliveryTargets(resolution);
  assert.equal(targets.length, 2);
  for (const target of targets) {
    assert.deepEqual(Object.keys(target).sort(), ["id", "label", "type"]);
  }
  assert.deepEqual(
    targets.map((target) => target.type),
    [TARGET_TYPE.CHAT_ID, TARGET_TYPE.OPEN_ID],
  );
});

test("toDeliveryTargets bounds the label to 80 characters", () => {
  const longName = "长".repeat(120);
  const resolution = resolveTargets({
    authorizedChatIds: [GROUP.chatId],
    botChats: [{ chatId: GROUP.chatId, name: longName }],
    wantedGroups: [longName],
  });
  const targets = toDeliveryTargets(resolution);
  assert.equal(targets[0].label.length, 80);
});

test("maskTarget never returns the raw id", () => {
  const masked = maskTarget({ type: "chat_id", id: GROUP.chatId, label: "东热战神", provenance: "x" });
  assert.equal(masked.maskedId, "oc_093…cccc");
  assert.ok(!masked.maskedId.includes(GROUP.chatId));
});
