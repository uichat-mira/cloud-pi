/**
 * Byte-budgeted text segmentation for WeCom replies.
 *
 * The platform limit is **UTF-8 bytes** (`markdown.content` / `stream.content`
 * ≤ 20480 bytes), not characters: one CJK codepoint is three bytes. The
 * delivery formatter in `src/delivery/format.mjs` counts codepoints and is
 * shared with the Feishu channel, so this module does not touch it; the channel
 * segments its own replies and leaves the delivery contract unchanged.
 *
 * A segment never splits a UTF-8 sequence: the cutter walks codepoints and stops
 * before it would exceed the byte budget, preferring the last paragraph or line
 * break in the second half of the window.
 */

/** Room for `\n\n（续 NNN/NNN）` plus any future suffix widening. */
const CONTINUATION_RESERVE_BYTES = 64;

export const WECOM_SEGMENT_DEFAULTS = Object.freeze({
  /** Headroom under the 20480-byte platform limit. */
  maxBytes: 20_000,
  maxSegments: 8,
});

/**
 * Chat replies are capped well below the platform limit (rubric §2 L2/L4/L5):
 * a direct chat may continue across at most 3 messages, a group must stay one
 * message ("群聊不写小作文"). Research reports are not chat replies and keep the
 * wider default.
 */
export const WECOM_CHAT_SEGMENT_LIMITS = Object.freeze({
  single: 3,
  group: 1,
});

export function byteLength(text) {
  return typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
}

function continuationSuffix(index, total) {
  return `\n\n（续 ${index}/${total}）`;
}

/**
 * The truncation notice must give a next step, not a dead end (rubric L6/E3):
 * the old "已省略" sentence stated the loss and stopped there.
 */
export function truncationNotice(omittedSegments) {
  return `\n\n内容太长，后面还有约 ${omittedSegments} 段没发。要我拆成几条继续发吗？`;
}

/**
 * Split one codepoint-safe slice whose byte length is at most `budget`.
 * Returns the consumed codepoint count.
 */
function takeSlice(chars, start, budget) {
  let bytes = 0;
  let index = start;
  while (index < chars.length) {
    const size = Buffer.byteLength(chars[index], "utf8");
    if (bytes + size > budget) break;
    bytes += size;
    index += 1;
  }
  if (index === start) {
    // A single codepoint larger than the budget can only be one emoji; take it
    // rather than loop forever, and let the caller surface the overshoot.
    return start + 1;
  }
  return index;
}

function preferBreak(chars, start, end) {
  if (end >= chars.length) return end;
  const windowLength = end - start;
  const floor = start + Math.floor(windowLength / 2);
  for (let index = end; index > floor; index -= 1) {
    const char = chars[index - 1];
    if (char === "\n" || char === "\r") return index;
  }
  return end;
}

/**
 * @param {string} text
 * @param {{maxBytes?: number, maxSegments?: number}} [options]
 * @returns {{segments: string[], truncated: boolean, omittedBytes: number}}
 */
export function splitForSend(text, options = {}) {
  const maxBytes = options.maxBytes ?? WECOM_SEGMENT_DEFAULTS.maxBytes;
  const maxSegments = options.maxSegments ?? WECOM_SEGMENT_DEFAULTS.maxSegments;
  const value = typeof text === "string" ? text : "";
  if (value.length === 0) return { segments: [], truncated: false, omittedBytes: 0 };
  if (byteLength(value) <= maxBytes) return { segments: [value], truncated: false, omittedBytes: 0 };

  const chars = Array.from(value);
  const budget = Math.max(256, maxBytes - CONTINUATION_RESERVE_BYTES);
  /** @type {string[]} */
  const raw = [];
  let cursor = 0;
  while (cursor < chars.length) {
    const end = takeSlice(chars, cursor, budget);
    const sliceEnd = preferBreak(chars, cursor, end);
    raw.push(chars.slice(cursor, sliceEnd).join(""));
    cursor = sliceEnd;
  }

  const keptCount = Math.min(raw.length, maxSegments);
  const kept = raw.slice(0, keptCount);
  const omitted = raw.slice(keptCount);
  const total = kept.length;
  const segments = kept.map((segment, index) =>
    index === total - 1 ? segment : `${segment}${continuationSuffix(index + 1, total)}`,
  );

  if (omitted.length > 0) {
    const omittedBytes = omitted.reduce((sum, segment) => sum + byteLength(segment), 0);
    const lastIndex = segments.length - 1;
    // Trim the final kept segment so the notice still fits the platform limit.
    const notice = truncationNotice(omitted.length);
    let last = segments[lastIndex];
    const room = maxBytes - byteLength(notice);
    while (byteLength(last) > room) {
      const charsOfLast = Array.from(last);
      last = charsOfLast.slice(0, Math.max(0, charsOfLast.length - 1)).join("");
    }
    segments[lastIndex] = `${last}${notice}`;
    return { segments, truncated: true, omittedBytes };
  }

  return { segments, truncated: false, omittedBytes: 0 };
}
