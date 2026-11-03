/**
 * AGT-035 — trusted Feishu target resolution for collaboration delivery.
 *
 * The existing delivery layer (AGT-033) already knows how to deliver to
 * `deliveryTargets` and how to record one independent result per target. What it
 * deliberately does not do is *decide* who those targets are: targets are read
 * from a schedule's trusted configuration, never from a report, a message or a
 * model output.
 *
 * This module adds the missing step without touching that contract:
 *
 *   real Feishu events (who actually messaged the bot)
 *   bot's existing chats (`im/v1/chats`, read-only)
 *   controlled allowlist (`FEISHU_ALLOWED_CHAT_IDS`)
 *        → resolveTargets() → { type, id, label } entries
 *        → written into `schedule.deliveryTargets` before a schedule is created
 *        → existing AGT-033 coordinator performs and records the delivery
 *
 * Nothing here sends a message. A group is only ever resolved to a `chat_id`
 * pair that came back from the platform's own chat list, so an id typed into a
 * configuration name, an event body or a research report can never become a
 * recipient. An unavailable group is reported as `bot_not_in_chat` (action:
 * invite the bot) instead of inventing a chat identity.
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { maskId } from "../channels/feishu/config.mjs";

/** Bump when the resolution result shape changes incompatibly. */
export const TARGET_CONTRACT_VERSION = 1;

/** The only two destination kinds AGT-033 can send to. */
export const TARGET_TYPE = Object.freeze({
  OPEN_ID: "open_id",
  CHAT_ID: "chat_id",
});

/** A candidate that exists in the plan but cannot be delivered yet. */
export const UNAVAILABLE_REASON = Object.freeze({
  /** The bot is not a member of the wanted group: the human must invite it. */
  BOT_NOT_IN_CHAT: "bot_not_in_chat",
  /** Several chats share the wanted name; guessing one would be unsafe. */
  CHAT_NAME_AMBIGUOUS: "chat_name_ambiguous",
  /** A confirmed person exists, but no real private message was ever observed. */
  OPEN_ID_NOT_OBSERVED: "open_id_not_observed",
});

/** A candidate that must never become a recipient. */
export const REJECT_REASON = Object.freeze({
  CHAT_NOT_AUTHORIZED: "chat_not_authorized",
  OPEN_ID_NOT_CONFIRMED: "open_id_not_confirmed",
  DUPLICATE_TARGET: "duplicate_target",
  TOO_MANY_TARGETS: "too_many_targets",
  INVALID_CHAT_ENTRY: "invalid_chat_entry",
  INVALID_OPEN_ID: "invalid_open_id",
});

export const TARGET_LIMITS = Object.freeze({
  /** Mirrors the AGT-033 schedule contract: at most 10 destinations per run. */
  maxTargets: 10,
  chatPageSize: 50,
  /** Bounded read: never walk an unbounded chat list. */
  maxChatPages: 5,
});

const CHATS_PATH = "/open-apis/im/v1/chats";
const CHAT_ID_PATTERN = /^oc_[A-Za-z0-9_-]+$/;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/;

export class TargetResolutionError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "TargetResolutionError";
    this.code = code;
  }
}

function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeChatEntry(entry, index, rejected) {
  const chatId = typeof entry?.chatId === "string" ? entry.chatId.trim() : "";
  const name = typeof entry?.name === "string" ? entry.name.trim() : "";
  if (!CHAT_ID_PATTERN.test(chatId)) {
    rejected.push({ kind: "chat", maskedId: maskId(chatId || String(index)), reason: REJECT_REASON.INVALID_CHAT_ENTRY });
    return null;
  }
  return {
    chatId,
    name,
    chatMode: typeof entry?.chatMode === "string" ? entry.chatMode : null,
  };
}

/**
 * Read the chats the bot has already joined. Read-only, bounded, paginated.
 *
 * @param {object} options
 * @param {object} options.client an official SDK client (or a test double with `request`)
 * @param {number} [options.pageSize]
 * @param {number} [options.maxPages]
 * @returns {Promise<{chats:Array<{chatId:string,name:string,chatMode:string|null}>, hasMore:boolean, pagesRead:number, truncated:boolean}>}
 */
export async function listBotChats({ client, pageSize, maxPages } = {}) {
  if (!client || typeof client.request !== "function") {
    throw new TargetResolutionError("client_missing", "listBotChats requires a Feishu client");
  }
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 100
    ? pageSize
    : TARGET_LIMITS.chatPageSize;
  const pages = Number.isSafeInteger(maxPages) && maxPages > 0 ? maxPages : TARGET_LIMITS.maxChatPages;

  const chats = [];
  const seen = new Set();
  let pageToken;

  for (let page = 0; page < pages; page += 1) {
    const params = { page_size: size };
    if (pageToken) params.page_token = pageToken;
    let response;
    try {
      response = await client.request({ method: "GET", url: CHATS_PATH, params });
    } catch (error) {
      const data = error?.response?.data;
      throw new TargetResolutionError(
        "chat_list_failed",
        `Feishu chat list failed: code=${data?.code ?? error?.code ?? "unknown"}`,
        { cause: error },
      );
    }
    const code = response?.code;
    if (typeof code === "number" && code !== 0) {
      // Fail closed: an unreadable chat list must not become an empty target set
      // silently (that would look like "the bot is in no group").
      throw new TargetResolutionError(
        "chat_list_failed",
        `Feishu chat list failed: code=${code} msg=${response?.msg ?? "unknown"}`,
      );
    }
    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    for (const item of items) {
      const chatId = typeof item?.chat_id === "string" ? item.chat_id.trim() : "";
      if (!CHAT_ID_PATTERN.test(chatId) || seen.has(chatId)) continue;
      seen.add(chatId);
      chats.push({
        chatId,
        name: typeof item?.name === "string" ? item.name.trim() : "",
        chatMode: typeof item?.chat_mode === "string" ? item.chat_mode : null,
      });
    }
    const hasMore = response?.data?.has_more === true;
    pageToken = typeof response?.data?.page_token === "string" ? response.data.page_token : undefined;
    if (!hasMore || !pageToken) {
      return { chats, hasMore: false, pagesRead: page + 1, truncated: false };
    }
  }
  return { chats, hasMore: true, pagesRead: pages, truncated: true };
}

/**
 * Build a read-only directory bound to one app. Sends nothing.
 *
 * @param {{config:object, client?:object}} options
 */
export function createFeishuChatDirectory({ config, client: injectedClient } = {}) {
  if (!injectedClient && (!config?.appId || !config?.appSecret)) {
    throw new TargetResolutionError("config_missing", "Feishu app credentials are required for chat discovery");
  }
  const client = injectedClient ?? new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.error,
  });
  return {
    listChats: (options) => listBotChats({ ...options, client }),
  };
}

/**
 * Resolve the trusted target list from real platform facts.
 *
 * Rules (all fail closed):
 *  - a group target needs a platform-returned chat whose id is also in the
 *    controlled allowlist; a name is never an id;
 *  - an unjoined group is `bot_not_in_chat`, never a guessed recipient;
 *  - a private target needs both an observed p2p event and explicit
 *    confirmation; an observed-but-unconfirmed sender is rejected;
 *  - a confirmed-but-never-observed person is unavailable (not fabricated).
 *
 * @param {object} options
 * @param {Iterable<string>} [options.authorizedChatIds] controlled allowlist
 * @param {Array<object>} [options.botChats] result of `listBotChats().chats`
 * @param {Array<string|{name:string,label?:string}>} [options.wantedGroups]
 * @param {Iterable<string>} [options.observedP2pSenderIds] senders of real p2p events
 * @param {Iterable<string>} [options.confirmedP2pOpenIds] people the operator confirmed
 * @returns {{targets:Array<object>, unavailable:Array<object>, rejected:Array<object>, counts:object}}
 */
export function resolveTargets({
  authorizedChatIds = [],
  botChats = [],
  wantedGroups = [],
  observedP2pSenderIds = [],
  confirmedP2pOpenIds = [],
} = {}) {
  const authorized = new Set(
    [...authorizedChatIds].map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean),
  );
  const observed = new Set(
    [...observedP2pSenderIds].map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean),
  );
  const confirmed = new Set(
    [...confirmedP2pOpenIds].map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean),
  );

  const rejected = [];
  const chats = [];
  if (Array.isArray(botChats)) {
    botChats.forEach((entry, index) => {
      const chat = normalizeChatEntry(entry, index, rejected);
      if (chat) chats.push(chat);
    });
  }

  const targets = [];
  const unavailable = [];
  const keys = new Set();

  const pushTarget = (target) => {
    const key = `${target.type}:${target.id}`;
    if (keys.has(key)) {
      rejected.push({ kind: target.type, maskedId: maskId(target.id), reason: REJECT_REASON.DUPLICATE_TARGET });
      return;
    }
    if (targets.length >= TARGET_LIMITS.maxTargets) {
      rejected.push({ kind: target.type, maskedId: maskId(target.id), reason: REJECT_REASON.TOO_MANY_TARGETS });
      return;
    }
    keys.add(key);
    targets.push(target);
  };

  const groups = [];
  if (Array.isArray(wantedGroups)) {
    for (const wanted of wantedGroups) {
      if (typeof wanted === "string") groups.push({ name: wanted });
      else if (wanted && typeof wanted.name === "string") groups.push({ name: wanted.name, label: wanted.label });
    }
  }

  for (const wanted of groups) {
    const wantedName = normalizeName(wanted.name);
    if (!wantedName) {
      unavailable.push({
        kind: "group",
        name: wanted.name ?? "",
        reason: UNAVAILABLE_REASON.CHAT_NAME_AMBIGUOUS,
        action: "provide_group_name",
      });
      continue;
    }
    const matches = chats.filter((chat) => normalizeName(chat.name) === wantedName);
    if (matches.length === 0) {
      // Either the bot was never invited, or the name is wrong. Do not guess an
      // id: report the actionable fact and stop.
      unavailable.push({
        kind: "group",
        name: wanted.name,
        reason: UNAVAILABLE_REASON.BOT_NOT_IN_CHAT,
        action: "invite_bot",
      });
      continue;
    }
    if (matches.length > 1) {
      unavailable.push({
        kind: "group",
        name: wanted.name,
        reason: UNAVAILABLE_REASON.CHAT_NAME_AMBIGUOUS,
        action: "disambiguate",
        candidates: matches.map((chat) => ({ name: chat.name, maskedId: maskId(chat.chatId) })),
      });
      continue;
    }
    const chat = matches[0];
    if (!authorized.has(chat.chatId)) {
      rejected.push({
        kind: "group",
        name: wanted.name,
        maskedId: maskId(chat.chatId),
        reason: REJECT_REASON.CHAT_NOT_AUTHORIZED,
      });
      continue;
    }
    pushTarget({
      type: TARGET_TYPE.CHAT_ID,
      id: chat.chatId,
      label: typeof wanted.label === "string" && wanted.label.trim() ? wanted.label.trim() : chat.name,
      provenance: "bot_chat+controlled_allowlist",
    });
  }

  for (const openId of confirmed) {
    if (!OPEN_ID_PATTERN.test(openId)) {
      rejected.push({ kind: "p2p", maskedId: maskId(openId), reason: REJECT_REASON.INVALID_OPEN_ID });
      continue;
    }
    if (!observed.has(openId)) {
      unavailable.push({
        kind: "p2p",
        maskedId: maskId(openId),
        reason: UNAVAILABLE_REASON.OPEN_ID_NOT_OBSERVED,
        action: "send_first_dm",
      });
      continue;
    }
    pushTarget({
      type: TARGET_TYPE.OPEN_ID,
      id: openId,
      label: "maintainer_dm",
      provenance: "p2p_event+explicit_confirmation",
    });
  }

  for (const openId of observed) {
    if (confirmed.has(openId)) continue;
    if (!OPEN_ID_PATTERN.test(openId)) {
      rejected.push({ kind: "p2p", maskedId: maskId(openId), reason: REJECT_REASON.INVALID_OPEN_ID });
      continue;
    }
    rejected.push({
      kind: "p2p",
      maskedId: maskId(openId),
      reason: REJECT_REASON.OPEN_ID_NOT_CONFIRMED,
    });
  }

  return {
    contractVersion: TARGET_CONTRACT_VERSION,
    targets,
    unavailable,
    rejected,
    counts: {
      targets: targets.length,
      unavailable: unavailable.length,
      rejected: rejected.length,
    },
  };
}

/**
 * Project a resolution into the exact `deliveryTargets` shape AGT-033 accepts.
 * Provenance and evidence-only fields never reach the schedule contract.
 */
export function toDeliveryTargets(resolution) {
  const targets = Array.isArray(resolution?.targets) ? resolution.targets : [];
  return targets.map((target) => ({
    type: target.type,
    id: target.id,
    label: typeof target.label === "string" ? target.label.slice(0, 80) : undefined,
  })).map((target) => (target.label === undefined ? { type: target.type, id: target.id } : target));
}

/** Evidence-safe projection: masked ids, no message text or provenance secrets. */
export function maskTarget(target) {
  return {
    type: target?.type ?? "unknown",
    maskedId: maskId(typeof target?.id === "string" ? target.id : ""),
    label: typeof target?.label === "string" ? target.label : null,
    provenance: typeof target?.provenance === "string" ? target.provenance : null,
  };
}
