/**
 * Bounded, process-local dedupe store for WeCom callbacks.
 *
 * WeCom may re-deliver the same `msgid` (the platform documents `msgid` as the
 * per-callback uniqueness handle). The channel reserves the key synchronously
 * before any async work, so a duplicate callback cannot start a second run.
 *
 * This store is intentionally process-local and bounded, exactly like the
 * Feishu channel's store: multi-instance or restart-spanning dedupe would need a
 * shared store and is recorded as a limitation, not faked here.
 */

export const DEFAULT_WECOM_DEDUPE_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_WECOM_DEDUPE_MAX_ENTRIES = 2_048;

export function createWecomDedupeStore({
  ttlMs = DEFAULT_WECOM_DEDUPE_TTL_MS,
  maxEntries = DEFAULT_WECOM_DEDUPE_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  /** @type {Map<string, number>} insertion order doubles as age order */
  const seen = new Map();

  function purge(at) {
    for (const [key, reservedAt] of seen) {
      if (at - reservedAt < ttlMs) break;
      seen.delete(key);
    }
  }

  return {
    /**
     * Reserve a key. Returns the reserved key when it is new, `null` when it is
     * already present (duplicate) or empty (no usable key).
     */
    reserve(key) {
      if (typeof key !== "string" || key.length === 0) return null;
      const at = now();
      purge(at);
      if (seen.has(key)) return null;
      seen.set(key, at);
      while (seen.size > maxEntries) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
      return key;
    },

    has(key) {
      if (typeof key !== "string" || key.length === 0) return false;
      const reservedAt = seen.get(key);
      if (reservedAt === undefined) return false;
      if (now() - reservedAt >= ttlMs) {
        seen.delete(key);
        return false;
      }
      return true;
    },

    get size() {
      return seen.size;
    },
  };
}
