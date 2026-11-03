/**
 * Feishu chat routing policy.
 *
 * POC rules (product-design §3.2), enforced outside the model:
 *
 *   private chat                      → allowed
 *   authorized group + explicit @bot  → allowed
 *   authorized group without @bot     → ignored
 *   unauthorized group                → ignored
 *   unknown chat type / unknown bot   → ignored (fail closed)
 *
 * Group authorization here is a local trusted allowlist for the POC. It is not
 * Cloud Auth authorization and grants no member account or tool privilege.
 */

function hasBotMention(mentions, botOpenId) {
  if (!botOpenId || !Array.isArray(mentions)) return false;
  return mentions.some((mention) => mention?.openId === botOpenId);
}

/**
 * @param {{chatType?:string, chatId?:string, mentions?:Array<{openId?:string}>}} event
 * @param {{allowedChatIds?:Iterable<string>|Set<string>, botOpenId?:string|undefined}} policy
 * @returns {{allowed:boolean, kind:"p2p"|"group"|"unsupported", reason:string}}
 */
export function decideFeishuRoute(event, policy = {}) {
  const allowedChatIds = policy.allowedChatIds instanceof Set
    ? policy.allowedChatIds
    : new Set(policy.allowedChatIds ?? []);

  if (event?.chatType === "p2p") {
    return { allowed: true, kind: "p2p", reason: "private_chat" };
  }
  if (event?.chatType !== "group") {
    return { allowed: false, kind: "unsupported", reason: "unsupported_chat_type" };
  }
  if (!event.chatId || !allowedChatIds.has(event.chatId)) {
    return { allowed: false, kind: "group", reason: "unauthorized_group" };
  }
  // Without a verified bot open id we cannot prove an explicit mention, so a
  // group message must not reach the Agent.
  if (!policy.botOpenId) {
    return { allowed: false, kind: "group", reason: "bot_identity_unknown" };
  }
  if (!hasBotMention(event.mentions, policy.botOpenId)) {
    return { allowed: false, kind: "group", reason: "group_without_mention" };
  }
  return { allowed: true, kind: "group", reason: "group_mention" };
}
