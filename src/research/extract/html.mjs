/**
 * HTML -> article text extraction for `research_read_page`.
 *
 * `linkedom` builds a DOM, `@mozilla/readability` finds the main article, and a
 * body-text fallback keeps pages readable when Readability declines (short
 * pages, app shells, unusual markup). Metadata (title, site name, published
 * time) is read from OpenGraph, standard meta tags, JSON-LD and `<time>`
 * before Readability mutates anything.
 *
 * The output is text for the model, so it is normalized (no control chars, no
 * repeated blank lines) and capped by the caller's `maxChars`.
 */
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { normalizeWhitespace } from "../net/rss.mjs";

/** Content types `research_read_page` is willing to parse. */
export const READABLE_CONTENT_TYPES = Object.freeze(["text/html", "text/plain", "application/xhtml+xml"]);

const MIN_READABILITY_CHARS = 200;
const MIN_EXTRACT_CHARS = 20;
const META_SCAN_BYTES = 4096;
/** Ledger excerpt length: a body-text preview, not the page's meta description. */
const EXCERPT_CHARS = 600;

/** Parse `text/html; charset=UTF-8` into `{mediaType, charset}`. */
export function parseContentType(header) {
  const value = String(header ?? "").trim();
  if (!value) return { mediaType: "", charset: null };
  const [rawType, ...params] = value.split(";");
  const mediaType = rawType.trim().toLowerCase();
  let charset = null;
  for (const param of params) {
    const match = param.trim().match(/^charset\s*=\s*"?([^";\s]+)"?$/i);
    if (match) charset = match[1].toLowerCase();
  }
  return { mediaType, charset };
}

/** True when the byte prefix looks like a BOM for a supported encoding. */
function bomCharset(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return "utf-8";
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return "utf-16le";
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return "utf-16be";
  return null;
}

function metaCharset(buffer) {
  const head = buffer.subarray(0, META_SCAN_BYTES).toString("latin1");
  const direct = head.match(/<meta\b[^>]*\bcharset\s*=\s*["']?\s*([\w.-]+)/i);
  if (direct) return direct[1].toLowerCase();
  const httpEquiv = head.match(
    /<meta\b[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([\w.-]+)/i,
  );
  return httpEquiv ? httpEquiv[1].toLowerCase() : null;
}

/**
 * Charset precedence: BOM, then HTTP header, then `<meta charset>`, then UTF-8.
 * Unknown or invalid labels fall back to UTF-8 instead of throwing.
 */
export function sniffCharset(buffer, contentTypeHeader) {
  const fromBom = bomCharset(buffer);
  if (fromBom) return fromBom;
  const fromHeader = parseContentType(contentTypeHeader).charset;
  if (fromHeader) return fromHeader;
  const fromMeta = metaCharset(buffer);
  if (fromMeta) return fromMeta;
  return "utf-8";
}

/** Decode a response body with charset sniffing. Never throws. */
export function decodeBuffer(buffer, contentTypeHeader) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const charset = sniffCharset(bytes, contentTypeHeader);
  const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  try {
    return { text: stripBom(new TextDecoder(charset, { fatal: false }).decode(bytes)), charset };
  } catch {
    return { text: stripBom(new TextDecoder("utf-8", { fatal: false }).decode(bytes)), charset: "utf-8" };
  }
}

/** Collapse whitespace while keeping paragraph breaks. */
export function normalizeExtractedText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function metaContent(document, selector) {
  const node = document.querySelector(selector);
  const content = node?.getAttribute?.("content");
  return content ? String(content).trim() : "";
}

function firstJsonLdDate(document) {
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 5);
  for (const script of scripts) {
    const raw = script.textContent ?? "";
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed["@graph"] ?? [])];
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        const value = node.datePublished ?? node.dateCreated ?? node.uploadDate;
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    } catch {
      // Invalid JSON-LD is common; a regex fallback still finds the field.
      const match = raw.match(/"datePublished"\s*:\s*"([^"]+)"/);
      if (match) return match[1];
    }
  }
  return "";
}

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(String(value).trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Metadata that survives Readability's DOM work, read first. */
export function readHtmlMetadata(document, { url } = {}) {
  const ogTitle = metaContent(document, 'meta[property="og:title"]') || metaContent(document, 'meta[name="twitter:title"]');
  const docTitle = normalizeWhitespace(document.querySelector("title")?.textContent ?? "");
  const h1 = normalizeWhitespace(document.querySelector("h1")?.textContent ?? "");
  const published =
    metaContent(document, 'meta[property="article:published_time"]') ||
    metaContent(document, 'meta[name="article:published_time"]') ||
    metaContent(document, 'meta[itemprop="datePublished"]') ||
    metaContent(document, 'meta[name="date"]') ||
    metaContent(document, 'meta[name="pubdate"]') ||
    metaContent(document, 'meta[property="og:updated_time"]') ||
    firstJsonLdDate(document) ||
    document.querySelector("time[datetime]")?.getAttribute("datetime") ||
    "";
  const siteName =
    metaContent(document, 'meta[property="og:site_name"]') ||
    metaContent(document, 'meta[name="application-name"]') ||
    metaContent(document, 'meta[name="twitter:site"]') ||
    "";
  let hostname = "";
  try {
    hostname = new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    hostname = "";
  }
  return {
    title: ogTitle || docTitle || h1 || "",
    siteName: siteName || hostname,
    publishedAt: normalizeDate(published),
    description:
      metaContent(document, 'meta[property="og:description"]') ||
      metaContent(document, 'meta[name="description"]') ||
      metaContent(document, 'meta[name="twitter:description"]') ||
      "",
  };
}

function bodyTextFallback(document) {
  for (const node of document.querySelectorAll("script,style,noscript,svg,iframe,template")) {
    node.remove?.();
  }
  const body = document.body ?? document.documentElement;
  return normalizeExtractedText(body?.textContent ?? "");
}

/**
 * Excerpt for the source ledger: what the model actually read, i.e. the start of
 * the extracted body. The page's meta description is only a fallback for pages
 * whose body is empty (where it is the only human-readable text).
 */
function excerptOf(text, description) {
  const body = normalizeWhitespace(text);
  if (body) return body.slice(0, EXCERPT_CHARS);
  return normalizeWhitespace(description).slice(0, EXCERPT_CHARS);
}

/**
 * Extract the readable part of an HTML document.
 *
 * @param {string} html
 * @param {{ url?: string, maxChars?: number }} [options]
 * @returns {{extractor:"readability"|"body_text", title:string, siteName:string,
 *   publishedAt:string|null, excerpt:string, text:string, contentChars:number,
 *   rawChars:number, truncated:boolean}}
 */
export function extractFromHtml(html, { url, maxChars = 20_000 } = {}) {
  const source = String(html ?? "");
  let document;
  try {
    ({ document } = parseHTML(source));
  } catch (error) {
    const wrapped = new Error(`HTML parse failed: ${String(error?.message ?? error).slice(0, 200)}`);
    wrapped.code = "parse_error";
    throw wrapped;
  }
  const metadata = readHtmlMetadata(document, { url });

  let article = null;
  try {
    article = new Readability(document, { charThreshold: 100 }).parse();
  } catch {
    article = null;
  }

  const readabilityText = normalizeExtractedText(article?.textContent ?? "");
  let extractor = "readability";
  let text = readabilityText;
  if (readabilityText.length < MIN_READABILITY_CHARS) {
    const fallback = bodyTextFallback(document);
    if (fallback.length > readabilityText.length) {
      text = fallback;
      extractor = "body_text";
    } else {
      extractor = "readability";
    }
  }

  const rawChars = text.length;
  const truncated = rawChars > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  return {
    extractor,
    title: normalizeWhitespace(article?.title ?? "") || metadata.title,
    siteName: normalizeWhitespace(article?.siteName ?? "") || metadata.siteName,
    publishedAt: metadata.publishedAt,
    excerpt: excerptOf(text, metadata.description),
    text,
    contentChars: text.length,
    rawChars,
    truncated,
    minChars: MIN_EXTRACT_CHARS,
  };
}

/** Extract from `text/plain` bodies (and the tail of `->` plain documents). */
export function extractFromPlainText(body, { url, maxChars = 20_000 } = {}) {
  const text = normalizeExtractedText(body);
  const rawChars = text.length;
  const truncated = rawChars > maxChars;
  const capped = truncated ? text.slice(0, maxChars) : text;
  const firstLine = capped.split("\n").find((line) => line.trim()) ?? "";
  let hostname = "";
  try {
    hostname = new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    hostname = "";
  }
  return {
    extractor: "plain_text",
    title: normalizeWhitespace(firstLine).slice(0, 200),
    siteName: hostname,
    publishedAt: null,
    excerpt: normalizeWhitespace(capped).slice(0, EXCERPT_CHARS),
    text: capped,
    contentChars: capped.length,
    rawChars,
    truncated,
    minChars: MIN_EXTRACT_CHARS,
  };
}
