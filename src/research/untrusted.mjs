/**
 * Untrusted web content handling.
 *
 * Search snippets and page bodies are *data*. The tools fence everything they
 * return from the network inside `<untrusted_web_content source="…">` so the
 * model can never mistake page text for a system or developer message; fence
 * sequences inside the payload are escaped so a page cannot close the fence and
 * smuggle instructions outside it. Control, zero-width and bidi-override
 * characters are stripped, and length is capped.
 *
 * Injection-looking patterns are *recorded* (`details.injectionSignals`) for the
 * audit ledger but the content is still passed through: a research agent must
 * be able to read a hostile page to report on it, it just must never obey it.
 *
 * This module is pure; it performs no I/O.
 */
import { UNTRUSTED } from "./contracts.mjs";

export const UNTRUSTED_POLICY = UNTRUSTED.POLICY;
export const UNTRUSTED_OPEN = UNTRUSTED.OPEN;
export const UNTRUSTED_CLOSE = UNTRUSTED.CLOSE;
export const MAX_SOURCE_LENGTH = 200;
export const MAX_SIGNAL_EXCERPT = 160;
export const MAX_SIGNALS = 10;

/** Zero-width, joiner, BOM and bidi-override code points. */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u180e]/g;
/** C0/C1 controls except newline and tab. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const FENCE_RE = /<(\/?)\s*(untrusted_[a-z_]+|system|assistant|user|developer|tool)\b/gi;

/**
 * Make a value safe for a fence `source="…"` attribute.
 */
export function sanitizeSource(source) {
  return String(source ?? "")
    .replace(INVISIBLE_RE, "")
    .replace(CONTROL_RE, "")
    .replace(/[<>"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SOURCE_LENGTH);
}

/**
 * Neutralize fence sequences inside a payload: a page must not be able to emit
 * `<untrusted_web_content>` or `</untrusted_web_content>` literally.
 */
export function escapeFence(text) {
  return String(text ?? "").replace(FENCE_RE, (match, slash, name) => `&lt;${slash}${name}`);
}

/**
 * Strip invisible/control characters and normalize whitespace.
 * Length is capped only when `maxChars` is given.
 */
export function sanitizeUntrustedText(text, { maxChars } = {}) {
  let value = String(text ?? "")
    .replace(INVISIBLE_RE, "")
    .replace(CONTROL_RE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (Number.isFinite(maxChars) && maxChars >= 0) value = value.slice(0, Math.floor(maxChars));
  return value;
}

const INJECTION_PATTERNS = Object.freeze([
  {
    id: "ignore_instructions",
    severity: "high",
    label: "Instruction override",
    pattern:
      /(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|all\s+)?(?:previous|prior|above|earlier|system|developer)\s+(?:instructions?|prompts?|directives?|rules?)/i,
  },
  {
    id: "system_prompt",
    severity: "high",
    label: "System prompt disclosure",
    pattern: /(?:reveal|print|show|repeat|output|leak|expose)\s+(?:your\s+|the\s+)?(?:system\s+prompt|hidden\s+instructions|initial\s+prompt|developer\s+message)/i,
  },
  {
    id: "system_prompt_mention",
    severity: "medium",
    label: "System prompt mentioned",
    pattern: /\bsystem prompt\b/i,
  },
  {
    id: "role_impersonation",
    severity: "high",
    label: "Role impersonation",
    pattern: /(?:you are now|act as (?:the|a) (?:system|developer|admin)|from now on,? you (?:are|must|will))/i,
  },
  {
    id: "command_execution",
    severity: "high",
    label: "Command execution request",
    pattern: /(?:execute|run|eval)\s+(?:the\s+following\s+|this\s+)?(?:command|shell|script|code)\b|\b(?:rm\s+-rf|curl\s+https?:|wget\s+https?:|bash\s+-c|powershell\s+-)/i,
  },
  {
    id: "tool_request",
    severity: "high",
    label: "Tool invocation requested by page",
    pattern: /\b(?:call|invoke|use)\s+(?:the\s+)?(?:research_web_search|research_read_page|\w+_tool|tool\s+\w+)\b|\bresearch_(?:web_search|read_page)\b/i,
  },
  {
    id: "exfiltration",
    severity: "high",
    label: "Data exfiltration request",
    pattern: /(?:send|post|upload|forward|exfiltrate|transmit)\s+[^\n]{0,60}?\b(?:to|at)\s+https?:\/\//i,
  },
  {
    id: "forged_role_tag",
    severity: "medium",
    label: "Forged role or fence tag",
    pattern: /<\/?\s*(?:system|developer|assistant|untrusted_web_content)\b/i,
  },
  {
    id: "new_instructions",
    severity: "medium",
    label: "Injected instructions block",
    pattern: /(?:new|updated|real|actual)\s+instructions?\s*[:：]/i,
  },
  {
    id: "hidden_text",
    severity: "medium",
    label: "Hidden text",
    pattern: /(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px)?|opacity\s*:\s*0(?:\.0+)?\b)/i,
  },
]);

function excerptAround(text, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const excerpt = String(text.slice(start, end)).replace(/\s+/g, " ").trim();
  return excerpt.length > MAX_SIGNAL_EXCERPT ? `${excerpt.slice(0, MAX_SIGNAL_EXCERPT - 1)}…` : excerpt;
}

/**
 * Detect common prompt-injection / instruction-smuggling patterns.
 *
 * @param {string} text
 * @param {{ html?: string }} [options] `html` enables hidden-text detection on
 *   raw markup (the extracted text no longer carries style attributes).
 * @returns {Array<{id:string, severity:"high"|"medium"|"low", label:string, excerpt:string}>}
 */
export function detectInjectionSignals(text, { html } = {}) {
  const haystack = String(text ?? "");
  const htmlHaystack = typeof html === "string" ? html.slice(0, 2_000_000) : "";
  const signals = [];
  const seen = new Set();
  for (const { id, severity, label, pattern } of INJECTION_PATTERNS) {
    if (signals.length >= MAX_SIGNALS) break;
    if (seen.has(id)) continue;
    const target = id === "hidden_text" ? htmlHaystack : haystack;
    if (!target) continue;
    const match = target.match(pattern);
    if (!match || typeof match.index !== "number") continue;
    seen.add(id);
    signals.push({
      id,
      severity,
      label,
      excerpt: excerptAround(target, match.index, match[0].length),
    });
  }
  return signals;
}

/**
 * Build the model-facing fenced block.
 *
 * @param {{ source: string, text: string, maxChars?: number }} input
 * @returns {{ fenced: string, text: string, truncated: boolean, strippedChars: number,
 *   injectionSignals: Array<object> }}
 */
export function buildUntrustedBlock({ source, text, maxChars = 20_000, html } = {}) {
  const original = String(text ?? "");
  const sanitized = sanitizeUntrustedText(original);
  const strippedChars = Math.max(0, original.length - sanitized.length);
  const truncated = sanitized.length > maxChars;
  const body = truncated ? sanitized.slice(0, maxChars) : sanitized;
  const injectionSignals = detectInjectionSignals(body, { html });
  const safeSource = sanitizeSource(source);
  const fenced = [
    `${UNTRUSTED_OPEN} source="${safeSource}">`,
    escapeFence(body),
    UNTRUSTED_CLOSE,
  ].join("\n");
  return { fenced, text: body, truncated, strippedChars, injectionSignals };
}

/** Convenience wrapper returning only the fenced string. */
export function fenceUntrusted({ source, text, maxChars } = {}) {
  return buildUntrustedBlock({ source, text, maxChars }).fenced;
}

/** One-line policy reminder appended to tool output headers. */
export function untrustedPolicyLine() {
  return `Content policy: ${UNTRUSTED_POLICY}`;
}
