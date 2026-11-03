/**
 * Minimal, dependency-free RSS 2.0 / Atom parser for search results.
 *
 * The parser is deliberately tolerant: real feeds are malformed, and a search
 * result page must not fail because of a stray tag. It is also deliberately
 * inert: DOCTYPE/ENTITY declarations are dropped and unknown entities are left
 * literal, so an "XXE-looking" feed cannot expand to a file or network read.
 *
 * Item shape (stable, mirrored into `details.results`):
 *   { title, url, snippet, publishedAt, siteName }
 */
import { ERROR_CODE } from "../contracts.mjs";

const NAMED_ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
});

/** Decode XML/HTML entities. Unknown entities are preserved verbatim. */
export function decodeXmlEntities(text) {
  return String(text ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return "";
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return "";
      }
    }
    const key = body.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

/** Remove markup and normalize whitespace. Entities are decoded last. */
export function stripTags(value) {
  const withoutBlocks = String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  return normalizeWhitespace(decodeXmlEntities(withoutBlocks.replace(/<[^>]*>/g, " ")));
}

/** Collapse runs of whitespace, drop control characters. */
export function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove XML declarations, comments, DOCTYPE (with internal subset) and ENTITY decls. */
export function stripXmlDeclarations(xml) {
  return String(xml ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "");
}

function unwrapCdata(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return match ? match[1] : text;
}

function tagBody(block, tag) {
  const selfClosing = new RegExp(`<${tag}\\b[^>]*/>`, "i");
  if (selfClosing.test(block)) return "";
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? unwrapCdata(match[1]) : "";
}

function tagAttribute(block, tag, attribute) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  if (!match) return "";
  return decodeXmlEntities(match[2] ?? match[3] ?? "");
}

function linkOf(block) {
  const textLink = normalizeWhitespace(tagBody(block, "link"));
  if (textLink && /^https?:\/\//i.test(textLink)) return textLink;
  const href = normalizeWhitespace(tagAttribute(block, "link", "href"));
  if (href && /^https?:\/\//i.test(href)) return href;
  return "";
}

/**
 * Parse a date string from RSS/Atom. Returns an ISO 8601 string or `null`.
 * Never throws and never guesses "now".
 */
export function parseFeedDate(value) {
  const text = normalizeWhitespace(value);
  if (!text) return null;
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const normalized = text.replace(/\s+/g, " ").replace(/^(\w{3})\s+(\d{1,2})/, "$1 $2");
  const retry = new Date(normalized);
  if (!Number.isNaN(retry.getTime())) return retry.toISOString();
  return null;
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/**
 * @param {string} xml
 * @param {{ baseUrl?: string }} [options]
 * @returns {{items: Array<{title:string,url:string,snippet:string,publishedAt:string|null,siteName:string}>,
 *   channelTitle: string|null, itemCount: number}}
 */
export function parseRssFeed(xml, { baseUrl } = {}) {
  const source = typeof xml === "string" ? xml : String(xml ?? "");
  if (!source.trim()) return { items: [], channelTitle: null, itemCount: 0 };
  const cleaned = stripXmlDeclarations(source);
  const itemBlocks = [...cleaned.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => match[2]);
  const items = [];
  for (const block of itemBlocks) {
    const title = stripTags(tagBody(block, "title"));
    let url = linkOf(block);
    if (!url && baseUrl) {
      const path = normalizeWhitespace(tagBody(block, "link"));
      if (path) {
        try {
          url = new URL(path, baseUrl).href;
        } catch {
          url = "";
        }
      }
    }
    if (!title || !url) continue;
    const rawSnippet = tagBody(block, "description") || tagBody(block, "summary") || tagBody(block, "content");
    const rawDate = tagBody(block, "pubDate") || tagBody(block, "published") || tagBody(block, "updated") || tagBody(block, "dc:date");
    const sourceName = stripTags(tagBody(block, "source"));
    items.push({
      title,
      url,
      snippet: stripTags(rawSnippet).slice(0, 800),
      publishedAt: parseFeedDate(rawDate),
      siteName: sourceName || hostnameOf(url),
    });
  }
  let channelTitle = null;
  const channelMatch = cleaned.match(/<channel\b[^>]*>([\s\S]*?)<(item|entry)\b/i);
  if (channelMatch) {
    const title = stripTags(tagBody(channelMatch[1], "title"));
    if (title) channelTitle = title;
  }
  return { items, channelTitle, itemCount: items.length };
}

/**
 * Parse a Bing RSS response. Throws a classified error only when the payload is
 * not XML at all (e.g. a captcha HTML page), which callers treat as
 * `provider_blocked`/`provider_unavailable`.
 */
export function parseBingRss(xml) {
  const source = String(xml ?? "");
  if (!source.trim()) return { items: [], channelTitle: null, itemCount: 0 };
  if (!/<(rss|feed|channel)\b/i.test(source)) {
    const error = new Error("Response is not an RSS/Atom feed");
    error.code = ERROR_CODE.PARSE_ERROR;
    throw error;
  }
  return parseRssFeed(source);
}
