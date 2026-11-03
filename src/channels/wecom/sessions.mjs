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

/** Platform error semantics for a target the platform does not know. */
export const WECOM_SESSION_UNKNOWN_CODE = 93_006;

/**
 * Canonical conversation key.
 *
 * A WeCom userid and a group chatid live in different namespaces and could in
 * principle collide, so the key carries the namespace: `wecom:group:<chatid>` or
 * `wecom:user:<userid>`. Using one key shape everywhere (session registry,
 * delivery target precondition, logs) means "is this target known?" has a single
 * answer instead of two lookups that can disagree.
 *
 * @param {{chatId?: string, chatType?: "single"|"group"}} target
 * @returns {string|undefined}
 */
export function wecomSessionKey({ chatId, chatType } = {}) {
  if (typeof chatId !== "string" || chatId.length === 0) return undefined;
  if (chatType === "group") return `wecom:group:${chatId}`;
  if (chatType === "single") return `wecom:user:${chatId}`;
  return undefined;
}

/**
 * @param {{ttlMs?: number, maxEntries?: number, now?: () => number}} [options]
 */
export function createKnownSessionStore({
  ttlMs = DEFAULT_KNOWN_SESSION_TTL_MS,
  maxEntries = DEFAULT_KNOWN_SESSION_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  /** @type {Map<string, {key: string, chatId: string, chatType: "single"|"group", lastInboundAt: number}>} */
  const sessions = new Map();

  function ensureFresh(at) {
    for (const [key, session] of sessions) {
      if (at - session.lastInboundAt < ttlMs) continue;
      sessions.delete(key);
    }
  }

  return {
    /** Record an inbound message; the conversation becomes a legal push target. */
    record({ chatId, chatType }) {
      const key = wecomSessionKey({ chatId, chatType });
      if (!key) return undefined;
      const at = now();
      ensureFresh(at);
      const session = { key, chatId, chatType, lastInboundAt: at };
      // Re-insert so the map order stays "least recently seen first".
      sessions.delete(key);
      sessions.set(key, session);
      while (sessions.size > maxEntries) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
      }
      return session;
    },

    /**
     * Look up one conversation. `chatType` disambiguates the namespace; without
     * it only an unambiguous single hit is returned (a bare id is never guessed to
     * be a user or a group).
     *
     * @returns {undefined | {key: string, chatId: string, chatType: "single"|"group", lastInboundAt: number}}
     */
    get(chatId, chatType) {
      if (typeof chatId !== "string" || chatId.length === 0) return undefined;
      const keys = chatType
        ? [wecomSessionKey({ chatId, chatType })].filter(Boolean)
        : [`wecom:user:${chatId}`, `wecom:group:${chatId}`];
      const at = now();
      for (const key of keys) {
        const session = sessions.get(key);
        if (!session) continue;
        if (at - session.lastInboundAt >= ttlMs) {
          sessions.delete(key);
          continue;
        }
        return session;
      }
      return undefined;
    },

    /**
     * @returns {{deliverable: true, key: string}
     *   | {deliverable: false, reason: "no_prior_inbound"|"chat_type_mismatch"|"invalid_target", platformCode?: number}}
     */
    assertDeliverable({ chatId, chatType } = {}) {
      if (typeof chatId !== "string" || chatId.length === 0) {
        return { deliverable: false, reason: "invalid_target" };
      }
      if (!chatType) {
        // A bare id is only accepted when exactly one namespace knows it; the
        // caller passes `chatType` on every real path.
        const any = this.get(chatId);
        if (!any) {
          return { deliverable: false, reason: "no_prior_inbound", platformCode: WECOM_SESSION_UNKNOWN_CODE };
        }
        return { deliverable: true, key: any.key };
      }
      const session = this.get(chatId, chatType);
      if (!session) {
        // Distinguish "seen, but as the other conversation kind" from "never seen":
        // the first is a caller bug worth naming, the second is the platform's
        // own `93006` precondition.
        const other = chatType === "group" ? "single" : "group";
        if (this.get(chatId, other)) return { deliverable: false, reason: "chat_type_mismatch" };
        // The platform refuses a push into a conversation the bot never saw with
        // this exact semantics; reporting the code keeps the two aligned.
        return { deliverable: false, reason: "no_prior_inbound", platformCode: WECOM_SESSION_UNKNOWN_CODE };
      }
      if (chatType && session.chatType !== chatType) return { deliverable: false, reason: "chat_type_mismatch" };
      return { deliverable: true, key: session.key };
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
