/**
 * URL safety for `research_read_page`.
 *
 * The model chooses URLs, so every URL is untrusted input. This module is the
 * only place that decides whether a URL may be requested:
 *
 * - scheme allow-list (`http:`, `https:` only);
 * - no credentials in the URL (`http://user:pass@host/`);
 * - no loopback / private / link-local / carrier-grade-NAT / reserved hosts,
 *   including IPv4-mapped, IPv4-compatible and NAT64 IPv6 forms;
 * - no `localhost`, `*.local`, `*.internal`, single-label intranet names;
 * - the *resolved* addresses are re-checked (DNS rebinding).
 *
 * Every rejection carries a `contracts.ERROR_CODE`. Callers must not fetch a
 * URL unless `classifyUrl()` returns `ok: true` *and* DNS checks pass.
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { ERROR_CODE } from "../contracts.mjs";

export const ALLOWED_SCHEMES = Object.freeze(["http:", "https:"]);

/** Hostnames that always point at the local machine or internal networks. */
export const BLOCKED_HOSTNAMES = Object.freeze([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

/** Suffixes that always point at local/intranet names. */
export const BLOCKED_HOST_SUFFIXES = Object.freeze([
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
  ".corp",
  ".private",
]);

/** One classified URL-safety failure. `code` is always a contracts.ERROR_CODE. */
export class UrlSafetyError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "UrlSafetyError";
    this.code = code;
    this.retryable = false;
    this.hostname = meta.hostname ?? null;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

/** `[::1]` (URL.hostname form) -> `::1`. */
export function stripBrackets(hostname) {
  const value = String(hostname ?? "").trim();
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
  return value;
}

/** `Example.com.` -> `example.com`. */
export function normalizeHostname(hostname) {
  return stripBrackets(hostname).toLowerCase().replace(/\.+$/, "");
}

/** Parse a dotted-quad IPv4 string into 4 bytes, or `null`. */
export function parseIpv4(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

/**
 * Parse an IPv6 string into 8 16-bit words, handling `::` compression,
 * embedded dotted-quad (`::ffff:127.0.0.1`) and zone ids (`fe80::1%en0`).
 */
export function parseIpv6(value) {
  if (typeof value !== "string") return null;
  let ip = stripBrackets(value).trim().toLowerCase();
  if (!ip.includes(":")) return null;
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.includes(".")) {
    const idx = ip.lastIndexOf(":");
    if (idx === -1) return null;
    const v4 = parseIpv4(ip.slice(idx + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    ip = `${ip.slice(0, idx + 1)}${hi}:${lo}`;
  }
  if (!/^[0-9a-f:]+$/.test(ip)) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half) => (half === "" ? [] : half.split(":"));
  const head = parseHalf(halves[0]);
  const tail = halves.length === 2 ? parseHalf(halves[1]) : null;
  let words;
  if (tail === null) {
    words = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    words = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (words.length !== 8) return null;
  const out = [];
  for (const word of words) {
    if (!/^[0-9a-f]{1,4}$/.test(word)) return null;
    out.push(parseInt(word, 16));
  }
  return out;
}

/**
 * Legacy numeric IPv4 forms browsers still resolve: `2130706433`,
 * `0x7f000001`, `0177.0.0.1`. Used to stop obfuscated SSRF attempts.
 */
export function parseLegacyIpv4(hostname) {
  const value = String(hostname ?? "").trim().toLowerCase();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  if (/^0x[0-9a-f]+$/.test(value)) {
    const n = parseInt(value, 16);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  if (/^(0\d+|\d+)\.(0\d+|\d+)\.(0\d+|\d+)\.(0\d+|\d+)$/.test(value)) {
    const parts = value.split(".");
    const bytes = parts.map((part) => {
      const base = part.length > 1 && part.startsWith("0") ? 8 : 10;
      return parseInt(part, base);
    });
    if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
    return bytes;
  }
  return null;
}

/** True when the IPv4 address must not be fetched. */
export function isBlockedIpv4(bytes, { allowLoopback = false } = {}) {
  if (!Array.isArray(bytes) || bytes.length !== 4) return true;
  const [a, b] = bytes;
  if (a === 127) return !allowLoopback;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0) return true; // 192.0.0/24 IETF + 192.0.2/24 documentation
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a === 198 && b === 51) return true; // 198.51.100/24 documentation
  if (a === 203 && b === 0) return true; // 203.0.113/24 documentation
  if (a >= 224) return true; // multicast (224/4), reserved (240/4), broadcast
  return false;
}

/** True when the IPv6 address (8 words) must not be fetched. */
export function isBlockedIpv6(words, { allowLoopback = false } = {}) {
  if (!Array.isArray(words) || words.length !== 8) return true;
  const embeddedV4 = () => [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255];
  const allZero = words.every((word) => word === 0);
  if (allZero) return true; // :: unspecified
  const isLoopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  if (isLoopback) return !allowLoopback; // ::1
  // ::ffff:a.b.c.d IPv4-mapped
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isBlockedIpv4(embeddedV4(), { allowLoopback });
  }
  // ::a.b.c.d IPv4-compatible (deprecated but still reachable on some stacks)
  if (words.slice(0, 6).every((word) => word === 0)) {
    return isBlockedIpv4(embeddedV4(), { allowLoopback });
  }
  // 64:ff9b::/96 NAT64
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) {
    return isBlockedIpv4(embeddedV4(), { allowLoopback });
  }
  if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((words[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  return false;
}

/** True for any blocked IP literal. Unparseable values count as blocked. */
export function isBlockedIp(value, options = {}) {
  const ipv6 = parseIpv6(value);
  if (ipv6) return isBlockedIpv6(ipv6, options);
  const ipv4 = parseIpv4(value);
  if (ipv4) return isBlockedIpv4(ipv4, options);
  return true;
}

/**
 * Classify a hostname without DNS. Returns `{ok: true}` or
 * `{ok: false, code, message}`.
 */
export function classifyHostname(hostname, options = {}) {
  const host = normalizeHostname(hostname);
  const { allowLoopback = false } = options;
  if (!host) return { ok: false, code: ERROR_CODE.INVALID_URL, message: "URL has no hostname" };

  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    return isBlockedIpv4(parseIpv4(host), { allowLoopback })
      ? { ok: false, code: ERROR_CODE.BLOCKED_URL, message: `Blocked private or reserved IPv4 address: ${host}` }
      : { ok: true };
  }
  if (ipVersion === 6) {
    return isBlockedIpv6(parseIpv6(host), { allowLoopback })
      ? { ok: false, code: ERROR_CODE.BLOCKED_URL, message: `Blocked private or reserved IPv6 address: ${host}` }
      : { ok: true };
  }

  const legacy = parseLegacyIpv4(host);
  if (legacy) {
    return isBlockedIpv4(legacy, { allowLoopback })
      ? { ok: false, code: ERROR_CODE.BLOCKED_URL, message: `Blocked obfuscated numeric address: ${host}` }
      : { ok: false, code: ERROR_CODE.INVALID_URL, message: `Numeric hostname is not an allowed address form: ${host}` };
  }

  if (BLOCKED_HOSTNAMES.includes(host)) {
    return { ok: false, code: ERROR_CODE.BLOCKED_URL, message: `Blocked local hostname: ${host}` };
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) {
      return { ok: false, code: ERROR_CODE.BLOCKED_URL, message: `Blocked local or internal hostname: ${host}` };
    }
  }
  if (!host.includes(".")) {
    // No public single-label TLD exists; treat as an intranet alias.
    return { ok: false, code: ERROR_CODE.BLOCKED_URL, message: `Blocked single-label (intranet) hostname: ${host}` };
  }
  return { ok: true };
}

/**
 * Validate scheme, credentials and hostname (no DNS).
 *
 * @returns {{ok: true, url: URL} | {ok: false, code: string, message: string}}
 */
export function classifyUrl(rawUrl, options = {}) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return { ok: false, code: ERROR_CODE.INVALID_URL, message: "A URL is required" };
  }
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, code: ERROR_CODE.INVALID_URL, message: "Malformed URL" };
  }
  if (!ALLOWED_SCHEMES.includes(url.protocol)) {
    return {
      ok: false,
      code: ERROR_CODE.UNSUPPORTED_SCHEME,
      message: `Unsupported URL scheme: ${url.protocol.replace(":", "")}`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, code: ERROR_CODE.INVALID_URL, message: "URL must not contain credentials" };
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    return { ok: false, code: ERROR_CODE.INVALID_URL, message: "URL has no hostname" };
  }
  const host = classifyHostname(hostname, options);
  if (!host.ok) return { ...host, hostname };
  return { ok: true, url };
}

/** Throwing variant of {@link classifyUrl}. */
export function assertSafeUrl(rawUrl, options = {}) {
  const result = classifyUrl(rawUrl, options);
  if (!result.ok) {
    throw new UrlSafetyError(result.code, result.message, { hostname: result.hostname });
  }
  return result.url;
}

/**
 * Resolve a hostname to addresses. IP literals resolve to themselves without
 * touching the network. Rejections: `dns_error` when resolution fails.
 *
 * @param {string} hostname
 * @param {{ lookup?: typeof dnsLookup }} [options]
 */
export async function resolveHostAddresses(hostname, { lookup = dnsLookup } = {}) {
  const host = normalizeHostname(hostname);
  const ipVersion = isIP(host);
  if (ipVersion) return [{ address: host, family: ipVersion }];
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new UrlSafetyError(
      ERROR_CODE.DNS_ERROR,
      `DNS resolution failed for ${host}: ${String(error?.code ?? error?.message ?? "unknown error").slice(0, 120)}`,
      { hostname: host, cause: error },
    );
  }
  const list = Array.isArray(records) ? records : [records];
  const addresses = list
    .filter((record) => record && typeof record.address === "string")
    .map((record) => ({ address: record.address, family: record.family ?? isIP(record.address) }));
  if (addresses.length === 0) {
    throw new UrlSafetyError(ERROR_CODE.DNS_ERROR, `DNS returned no addresses for ${host}`, { hostname: host });
  }
  return addresses;
}

/** Throw `blocked_url` when any resolved address is private/reserved. */
export function assertResolvedAddressesSafe(addresses, { hostname, allowLoopback = false } = {}) {
  for (const record of addresses ?? []) {
    const address = typeof record === "string" ? record : record?.address;
    if (!address) continue;
    if (isBlockedIp(address, { allowLoopback })) {
      throw new UrlSafetyError(
        ERROR_CODE.BLOCKED_URL,
        `Blocked hostname ${hostname ?? ""} because it resolves to a private or reserved address`,
        { hostname },
      );
    }
  }
}

/**
 * Full DNS-rebinding check for a URL. Returns the resolved addresses so the
 * caller can pin the connection if it ever needs to.
 */
export async function assertResolvedHostSafe(url, { allowLoopback = false, lookup = dnsLookup } = {}) {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const addresses = await resolveHostAddresses(parsed.hostname, { lookup });
  assertResolvedAddressesSafe(addresses, { hostname: normalizeHostname(parsed.hostname), allowLoopback });
  return addresses;
}

/**
 * Classify + DNS check in one call. `read-page` uses this before every hop.
 */
export async function assertUrlSafe(rawUrl, { allowLoopback = false, lookup = dnsLookup } = {}) {
  const url = assertSafeUrl(rawUrl, { allowLoopback });
  await assertResolvedHostSafe(url, { allowLoopback, lookup });
  return url;
}
