/**
 * In-process dedupe for Feishu event redelivery.
 *
 * Feishu retries an event when the bot does not acknowledge it in time, so the
 * same `event_id` (or, for older payloads, the same `message_id`) can arrive
 * more than once. The key is reserved synchronously before any async Agent run
 * starts, which makes concurrent duplicates collapse to one run.
 *
 * This is intentionally process-local and bounded: the POC runs one channel
 * process. Multi-instance delivery needs a shared idempotency store and is
 * recorded as a gap, not faked here.
 */

export const DEFAULT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_DEDUPE_MAX_ENTRIES = 2_048;

export function createDedupeStore({
  ttlMs = DEFAULT_DEDUPE_TTL_MS,
  maxEntries = DEFAULT_DEDUPE_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  const entries = new Map();

  function prune(at) {
    for (const [key, expiresAt] of entries) {
      if (expiresAt > at) break;
      entries.delete(key);
    }
  }

  function evictOverflow() {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  }

  return {
    /**
     * Reserve a key. Returns true for the first caller and false for a
     * duplicate or an empty key.
     */
    reserve(key) {
      if (typeof key !== "string" || key.length === 0) return false;
      const at = now();
      prune(at);
      const expiresAt = entries.get(key);
      if (expiresAt !== undefined && expiresAt > at) return false;
      entries.delete(key);
      entries.set(key, at + ttlMs);
      evictOverflow();
      return true;
    },

    has(key) {
      if (typeof key !== "string" || key.length === 0) return false;
      const expiresAt = entries.get(key);
      if (expiresAt === undefined) return false;
      if (expiresAt <= now()) {
        entries.delete(key);
        return false;
      }
      return true;
    },

    get size() {
      prune(now());
      return entries.size;
    },
  };
}
