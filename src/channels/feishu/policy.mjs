/**
 * Feishu chat routing policy.
 *
 * Platform controls who can reach the bot. Every user may chat, and anyone
 * in a group may explicitly mention the bot, with no local group whitelist.
 * Group mention identity must still be verified before any model work.
 * This chat policy does not grant account or privileged MCP permissions.
 */

function hasBotMention(mentions, botOpenId) {
  if (!botOpenId || !Array.isArray(mentions)) return false;
  return mentions.some((mention) => mention?.openId === botOpenId);
}

/**
 * @param {{chatType?:string, chatId?:string, mentions?:Array<{openId?:string}>}} event
 * @param {{botOpenId?:string|undefined}} policy
 * @returns {{allowed:boolean, kind:"p2p"|"group"|"unsupported", reason:string}}
 */
export function decideFeishuRoute(event, policy = {}) {
  if (event?.chatType === "p2p") {
    return { allowed: true, kind: "p2p", reason: "private_chat" };
  }
  if (event?.chatType !== "group") {
    return { allowed: false, kind: "unsupported", reason: "unsupported_chat_type" };
  }
  if (!event.chatId) {
    return { allowed: false, kind: "group", reason: "missing_chat_id" };
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
