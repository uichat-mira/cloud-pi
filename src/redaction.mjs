/**
 * Redaction for values that survive `redactSecrets()`.
 *
 * Two independent gaps motivated this module (AGT-038 review, t33):
 *
 *  1. **Encoded handles.** `guanlan_news_recent` returns `Next cursor:
 *     base64url({"v":1,"a":"<account-uuid>","c":"<consumer-uuid>"})`. Masking
 *     plaintext UUIDs does nothing to a base64url string that decodes straight back
 *     to them, so the cursor was persisted into run records and evidence in a
 *     *reversible* form. The fix is structural, not cosmetic: decode the token,
 *     prove it is a JSON handle carrying an identifier, and then persist only its
 *     length and a one-way digest — never the payload.
 *  2. **Pseudo tool syntax.** A model that could not call a tool occasionally
 *     emits the invocation syntax as prose (`<||DSML|| invoke ...>`). That must
 *     never reach a user verbatim: it is not an answer and it invites copy/paste
 *     of instructions the runtime did not execute.
 *
 * Everything here is pure and synchronous; callers keep their existing text.
 */
import { createHash } from "node:crypto";

/** Canonical UUID text (case-insensitive). */
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** base64url-ish run of characters long enough to carry an opaque handle. */
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}/g;

/** Minimum decoded payload size worth inspecting; shorter tokens are words. */
const MIN_HANDLE_BYTES = 16;

export function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

/**
 * Replace an opaque token when (and only when) it decodes to a JSON structure
 * carrying a UUID. Returns `null` for anything else, so ordinary text, ids and
 * base64 blobs of images or JWTs are left alone.
 */
function encodedHandleReplacement(token) {
  if (token.length % 4 === 1) return null; // impossible base64url length
  let decoded;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (decoded.length < MIN_HANDLE_BYTES || decoded.includes("\uFFFD")) return null;
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!UUID_PATTERN.test(JSON.stringify(parsed))) {
    UUID_PATTERN.lastIndex = 0;
    return null;
  }
  UUID_PATTERN.lastIndex = 0;
  // Payload dropped entirely: length keeps "was there a cursor?" answerable, the
  // digest keeps two sightings correlatable, and neither is reversible.
  return `<handle len=${token.length} sha=${shortHash(token)}>`;
}

/**
 * Remove reversible handles and plaintext identifiers from arbitrary text.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactOpaqueHandles(text) {
  if (typeof text !== "string" || text.length === 0) return typeof text === "string" ? text : "";
  const withoutHandles = text.replace(OPAQUE_TOKEN_PATTERN, (token) => encodedHandleReplacement(token) ?? token);
  return withoutHandles.replace(UUID_PATTERN, (value) => `id:${shortHash(value)}`);
}

/** Marker used by models that emit an unavailable tool call as prose. */
export const PSEUDO_TOOL_PATTERN = /<\|+DSML\|+|\|\|DSML\|\|/i;

/** What the user sees instead of the pseudo syntax. */
export const PSEUDO_TOOL_REPLY =
  "这一轮我没能拿到可用的工具结果，所以先不给结论。可以稍后再试，或者把要查的目标说得更具体一点。";

export function containsPseudoToolText(text) {
  return typeof text === "string" && PSEUDO_TOOL_PATTERN.test(text);
}

/**
 * Replace a reply that leaked pseudo tool syntax with a human sentence.
 *
 * @returns {{text: string, leaked: boolean}}
 */
export function sanitizeModelReply(text) {
  const value = typeof text === "string" ? text : "";
  if (!containsPseudoToolText(value)) return { text: value, leaked: false };
  return { text: PSEUDO_TOOL_REPLY, leaked: true };
}
