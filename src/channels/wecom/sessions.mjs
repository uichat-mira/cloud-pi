/**
 * Known-conversation registry.
 *
 * The platform only allows a proactive push into a conversation that already
 * exists: a user must have messaged the bot first (single chat) and, for a
 * group, someone must have @-mentioned it. This store records the conversations
 * the bot has actually seen, so a push to an unknown target is refused with a
 * terminal reason instead of being attempted blindly.
 *
 * It is process-local and bounded on purpose. Persisting it belongs to the
 * delivery work item (AGT-036 follow-up / W1), which owns the durable target
 * store; inventing a second durable store here would create a second source of
 * truth for "is this target deliverable".
 */

export const DEFAULT_KNOWN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_KNOWN_SESSION_MAX_ENTRIES = 2_048;

/**
 * @param {{ttlMs?: number, maxEntries?: number, now?: () => number}} [options]
 */
export function createKnownSessionStore({
  ttlMs = DEFAULT_KNOWN_SESSION_TTL_MS,
  maxEntries = DEFAULT_KNOWN_SESSION_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  /** @type {Map<string, {chatId: string, chatType: "single"|"group", lastInboundAt: number}>} */
  const sessions = new Map();

  function ensureFresh(at) {
    for (const [chatId, session] of sessions) {
      if (at - session.lastInboundAt < ttlMs) continue;
      sessions.delete(chatId);
    }
  }

  return {
    /** Record an inbound message; the conversation becomes a legal push target. */
    record({ chatId, chatType }) {
      if (typeof chatId !== "string" || chatId.length === 0) return undefined;
      if (chatType !== "single" && chatType !== "group") return undefined;
      const at = now();
      ensureFresh(at);
      const session = { chatId, chatType, lastInboundAt: at };
      // Re-insert so the map order stays "least recently seen first".
      sessions.delete(chatId);
      sessions.set(chatId, session);
      while (sessions.size > maxEntries) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
      }
      return session;
    },

    /** @returns {undefined | {chatId: string, chatType: "single"|"group", lastInboundAt: number}} */
    get(chatId) {
      if (typeof chatId !== "string" || chatId.length === 0) return undefined;
      const session = sessions.get(chatId);
      if (!session) return undefined;
      if (now() - session.lastInboundAt >= ttlMs) {
        sessions.delete(chatId);
        return undefined;
      }
      return session;
    },

    /**
     * @returns {{deliverable: true} | {deliverable: false, reason: "no_prior_inbound"|"chat_type_mismatch"}}
     */
    assertDeliverable({ chatId, chatType } = {}) {
      const session = this.get(chatId);
      if (!session) return { deliverable: false, reason: "no_prior_inbound" };
      if (chatType && session.chatType !== chatType) return { deliverable: false, reason: "chat_type_mismatch" };
      return { deliverable: true };
    },

    get size() {
      return sessions.size;
    },

    /**
     * Fresh conversations, least-recently-seen first.
     *
     * Diagnostics and composition only (for example turning "the conversation
     * that just messaged us" into a schedule target). Not part of the delivery
     * decision path: a caller must still go through `assertDeliverable`.
     */
    entries() {
      ensureFresh(now());
      return [...sessions.values()].map((session) => ({ ...session }));
    },
  };
}
