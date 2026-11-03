/**
 * Report and source-ledger materialisation for research runs (AGT-028).
 *
 * Two rules drive this module:
 *
 * 1. **Provenance over model claims.** The source ledger is built only from what
 *    the research tools actually returned (`details`): search hits that were
 *    never fetched, pages that were fetched, and fetches that failed. A URL the
 *    model merely wrote in its text is never promoted to a source.
 * 2. **Citations are checked, not trusted.** Inline `[S<n>]` references are
 *    resolved against the ledger. Unresolved references stay visible in
 *    `run.json` and in a `## Citation audit` section appended to `report.md`.
 *
 * Source ids (`S1`, `S2`, …) are assigned by the executor in tool-call order and
 * shown to the model in the tool result, so `[S<n>]` in the report refers to the
 * same ledger entry.
 */
import { SOURCE_STATUS } from "./contracts.mjs";

const REPORT_MIN_CHARS = 20;
const EXCERPT_LIMIT = 600;
/** At least one Markdown structural element: a report is not free-form prose. */
const MARKDOWN_STRUCTURE = /(^|\n)\s{0,3}(#{1,6}\s|\d+\.\s|[-*+]\s|>\s)|```|\*\*|\[[^\]]+\]\([^)]+\)/;

function asText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

/** Normalise a URL for identity comparison (fragment dropped; host lowercased by URL). */
export function canonicalizeUrl(raw) {
  const text = asText(raw);
  if (!text) return "";
  try {
    const url = new URL(text);
    url.hash = "";
    return url.href;
  } catch {
    return text;
  }
}

function uniqueList(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = canonicalizeUrl(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(value).trim());
  }
  return out;
}

/**
 * Extract the Markdown report body from the runtime's final assistant text.
 * Returns null when the runtime produced no usable report.
 */
export function extractReportBody(text) {
  if (typeof text !== "string") return null;
  let body = text.replace(/\r\n/g, "\n").trim();
  if (!body) return null;
  // Some providers wrap the whole answer in one fenced block; unwrap that.
  const fenced = body.match(/^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i);
  if (fenced) body = fenced[1].trim();
  if (!body) return null;
  if (body.replace(/\s/g, "").length < REPORT_MIN_CHARS) return null;
  if (!MARKDOWN_STRUCTURE.test(body)) return null;
  return body;
}

const CITATION_PATTERN = /\[S([1-9]\d*)\]/g;

/** Citations in first-appearance order, with occurrence counts. */
export function collectCitations(body) {
  const counts = new Map();
  if (typeof body !== "string") return [];
  for (const match of body.matchAll(CITATION_PATTERN)) {
    const id = `S${match[1]}`;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].map(([id, count]) => ({ id, count }));
}

/**
 * Resolve `[S<n>]` references against the ledger.
 *
 * - `unresolved`: cited id does not exist in the ledger.
 * - `unfetched`: cited source exists but its body was never read successfully.
 */
export function resolveCitations(body, sources = []) {
  const known = new Map((Array.isArray(sources) ? sources : []).map((source) => [source.id, source]));
  const references = collectCitations(body ?? "");
  const resolved = [];
  const unresolved = [];
  const unfetched = [];
  for (const reference of references) {
    const source = known.get(reference.id);
    if (!source) {
      unresolved.push({ ...reference });
      continue;
    }
    const entry = {
      ...reference,
      status: source.status,
      url: source.finalUrl ?? source.url ?? null,
    };
    resolved.push(entry);
    if (source.status !== SOURCE_STATUS.FETCHED) unfetched.push(entry);
  }
  return {
    references,
    resolved,
    unresolved,
    unfetched,
    citedSourceIds: resolved.map((entry) => entry.id),
  };
}

function normalizeToolError(error, fallbackCode = "internal_error") {
  if (!error || typeof error !== "object") return null;
  const code = typeof error.code === "string" ? error.code : fallbackCode;
  return {
    code,
    message: String(error.message ?? "").slice(0, 500),
    retryable: Boolean(error.retryable),
  };
}

function numericId(source) {
  const match = /^S(\d+)$/.exec(source?.id ?? "");
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function mergeSources(target, duplicate) {
  if (target === duplicate) return target;
  target.title = target.title || duplicate.title;
  target.siteName = target.siteName || duplicate.siteName;
  if (duplicate.publishedAtConfidence === "verified" || !target.publishedAt) {
    target.publishedAt = duplicate.publishedAt || target.publishedAt;
    target.publishedAtSource = duplicate.publishedAt ? duplicate.publishedAtSource : target.publishedAtSource;
    target.publishedAtConfidence = duplicate.publishedAt ? duplicate.publishedAtConfidence : target.publishedAtConfidence;
  }
  target.accessedAt = target.accessedAt || duplicate.accessedAt;
  target.excerpt = target.excerpt || duplicate.excerpt;
  if (target.contentChars === null) target.contentChars = duplicate.contentChars;
  if (target.httpStatus === null) target.httpStatus = duplicate.httpStatus;
  if (target.finalUrl === null) target.finalUrl = duplicate.finalUrl;
  if (target.error === null) target.error = duplicate.error;
  // A successful fetch always wins over a failed/not-fetched record.
  if (duplicate.status === SOURCE_STATUS.FETCHED || target.status === SOURCE_STATUS.NOT_FETCHED) {
    target.status = duplicate.status;
  }
  target.aliases = uniqueList([
    ...(target.aliases ?? []),
    ...(duplicate.aliases ?? []),
    target.url,
    duplicate.url,
    target.finalUrl,
    duplicate.finalUrl,
  ]).filter((url) => canonicalizeUrl(url) !== canonicalizeUrl(target.url));
  return target;
}

/**
 * Build the run's source ledger from tool provenance.
 *
 * `addSearch(details)` and `addPage(details)` accept exactly the `details`
 * objects returned by `research_web_search` / `research_read_page`; each returns
 * `{id, url, title?}` so the executor can annotate the model-facing tool result
 * with the source ids the report must cite.
 */
export function createSourceLedger() {
  /** @type {Array<object>} */
  const sources = [];
  /** @type {Map<string, object>} */
  const byUrl = new Map();
  let nextId = 1;

  function remember(url, source) {
    const key = canonicalizeUrl(url);
    if (key && !byUrl.has(key)) byUrl.set(key, source);
  }

  function find(url) {
    const key = canonicalizeUrl(url);
    return key ? byUrl.get(key) ?? null : null;
  }

  function createSource(fields) {
    const source = {
      id: `S${nextId++}`,
      kind: "search",
      title: null,
      url: "",
      finalUrl: null,
      status: SOURCE_STATUS.NOT_FETCHED,
      httpStatus: null,
      siteName: null,
      publishedAt: null,
      publishedAtSource: "none",
      publishedAtConfidence: "none",
      accessedAt: null,
      excerpt: null,
      contentChars: null,
      error: null,
      aliases: [],
      ...fields,
    };
    sources.push(source);
    remember(source.url, source);
    remember(source.finalUrl, source);
    return source;
  }

  /** Resolve the single source that owns a final URL (merging duplicates). */
  function claimFinalUrl(source, finalUrl) {
    const owner = find(finalUrl);
    if (!owner || owner === source) {
      remember(finalUrl, source);
      return source;
    }
    // Keep the lowest numeric id so ids stay stable for earlier citations.
    const [keep, drop] = numericId(owner) <= numericId(source) ? [owner, source] : [source, owner];
    mergeSources(keep, drop);
    remember(finalUrl, keep);
    for (const alias of [...(drop.aliases ?? []), drop.url, drop.finalUrl]) {
      remember(alias, keep);
    }
    const index = sources.indexOf(drop);
    if (index >= 0) sources.splice(index, 1);
    return keep;
  }

  /**
   * Record one `research_web_search` result set.
   * @returns {Array<{id: string, url: string, title: string|null}>}
   */
  function addSearch(details) {
    const results = Array.isArray(details?.results) ? details.results : [];
    const annotations = [];
    for (const item of results) {
      const url = asText(item?.url);
      if (!url) continue;
      let source = find(url);
      if (!source) {
        source = createSource({
          kind: "search",
          title: asText(item?.title),
          url,
          siteName: asText(item?.siteName),
          publishedAt: asText(item?.publishedAt),
          publishedAtSource: asText(item?.dateSource) ?? "provider",
          publishedAtConfidence: asText(item?.dateConfidence) ?? "unverified",
        });
      } else {
        source.title = source.title || asText(item?.title);
        source.siteName = source.siteName || asText(item?.siteName);
        if (!source.publishedAt && asText(item?.publishedAt)) {
          source.publishedAt = asText(item?.publishedAt);
          source.publishedAtSource = asText(item?.dateSource) ?? "provider";
          source.publishedAtConfidence = asText(item?.dateConfidence) ?? "unverified";
        }
      }
      annotations.push({ id: source.id, url: source.url, title: source.title });
    }
    return annotations;
  }

  /**
   * Record one `research_read_page` result (success or classified failure).
   * @returns {{id: string, url: string, status: string}|null}
   */
  function addPage(details) {
    const requestedUrl = asText(details?.url) ?? "";
    const finalUrl = asText(details?.finalUrl) ?? requestedUrl;
    const fetched = details?.status === "ok";
    if (!requestedUrl && !finalUrl) return null;

    let source = find(requestedUrl) ?? find(finalUrl);
    if (!source) {
      source = createSource({ kind: "page", url: requestedUrl || finalUrl });
    }
    if (!fetched && source.status === SOURCE_STATUS.FETCHED) {
      // Preserve the successful source's URL, HTTP status and evidence when a
      // subsequent attempt fails. The separate tool-call ledger owns failures.
      remember(requestedUrl, source);
      return { id: source.id, url: source.finalUrl ?? source.url, status: source.status };
    }
    source.finalUrl = finalUrl || source.finalUrl;
    if (fetched) {
      source = claimFinalUrl(source, finalUrl);
      source.status = SOURCE_STATUS.FETCHED;
      source.error = null;
    } else if (source.status !== SOURCE_STATUS.FETCHED) {
      // A later failed retry must not erase an earlier successful read.
      // The failed tool call remains visible in the separate call/error ledger.
      source.status = SOURCE_STATUS.FAILED;
      source.error = normalizeToolError(details?.error, "extract_failed") ?? {
        code: "extract_failed",
        message: "page fetch failed",
        retryable: false,
      };
    }
    source.httpStatus = asNumber(details?.httpStatus) ?? source.httpStatus;
    source.title = source.title || asText(details?.title);
    source.siteName = source.siteName || asText(details?.siteName);
    const pagePublishedAt = asText(details?.publishedAt);
    const pageDateConfidence = asText(details?.dateConfidence) ?? (pagePublishedAt ? "verified" : "none");
    if (pagePublishedAt && (pageDateConfidence === "verified" || !source.publishedAt)) {
      source.publishedAt = pagePublishedAt;
      source.publishedAtSource = asText(details?.dateSource) ?? "page";
      source.publishedAtConfidence = pageDateConfidence;
    }
    source.accessedAt = asText(details?.accessedAt) ?? source.accessedAt;
    source.excerpt = asText(details?.excerpt) ?? source.excerpt;
    source.contentChars = asNumber(details?.contentChars) ?? source.contentChars;
    source.aliases = uniqueList([...source.aliases, requestedUrl, finalUrl]).filter(
      (url) => canonicalizeUrl(url) !== canonicalizeUrl(source.url),
    );
    remember(requestedUrl, source);
    remember(finalUrl, source);
    return { id: source.id, url: source.finalUrl ?? source.url, status: source.status };
  }

  /** Immutable snapshot, ordered by numeric id. */
  function snapshot() {
    return [...sources]
      .sort((a, b) => numericId(a) - numericId(b))
      .map((source) => ({
        ...source,
        aliases: uniqueList(source.aliases ?? []),
      }));
  }

  return {
    addSearch,
    addPage,
    snapshot,
    get size() {
      return sources.length;
    },
  };
}

/** Counts used by the provenance footer and `run.json`. */
export function summarizeSources(sources = []) {
  const counts = {
    total: sources.length,
    fetched: 0,
    failed: 0,
    not_fetched: 0,
    failures: [],
  };
  for (const source of sources) {
    if (source.status === SOURCE_STATUS.FETCHED) counts.fetched += 1;
    else if (source.status === SOURCE_STATUS.FAILED) {
      counts.failed += 1;
      counts.failures.push({
        id: source.id,
        url: source.finalUrl ?? source.url ?? null,
        error: source.error ?? null,
      });
    } else counts.not_fetched += 1;
  }
  return counts;
}

function citationAuditLines(citations) {
  const lines = [];
  const list = (entries) => entries.map((entry) => `${entry.id}×${entry.count}`).join("、");
  if (citations.unresolved?.length) {
    lines.push(`- 未解析引用（来源清单中不存在）: ${list(citations.unresolved)}`);
  }
  if (citations.unfetched?.length) {
    lines.push(`- 引用了未成功读取的来源: ${list(citations.unfetched)}`);
  }
  return lines;
}

/** Provenance footer shared by `report.md` and `sources.md`. */
export function buildProvenanceFooter({ runId, generatedAt, sources = [], failures = [] }) {
  const summary = summarizeSources(sources);
  const failureCount = failures.length + summary.failed;
  return [
    "---",
    "",
    `> 运行 ID: ${runId} ｜ 生成时间: ${generatedAt}`,
    `> 来源: 共 ${summary.total} 条，已读取 ${summary.fetched}，读取失败 ${summary.failed}，仅搜索命中 ${summary.not_fetched}`,
    `> 失败项: ${failureCount > 0 ? `${failureCount} 项（详见 sources.json / run.json）` : "无"}`,
  ].join("\n");
}

/**
 * Materialise `report.md`: model body + optional citation audit + provenance
 * footer. The audit is appended only when there is something to report.
 */
export function buildReportMarkdown({
  body,
  runId,
  generatedAt,
  sources = [],
  citations = { unresolved: [], unfetched: [] },
  failures = [],
}) {
  const parts = [String(body ?? "").trimEnd()];
  const audit = citationAuditLines(citations);
  if (audit.length > 0) {
    parts.push(["## Citation audit", "", ...audit].join("\n"));
  }
  parts.push(
    buildProvenanceFooter({ runId, generatedAt, sources, failures }),
  );
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

function sourceHeading(source) {
  const statusLabel = {
    [SOURCE_STATUS.FETCHED]: "已读取",
    [SOURCE_STATUS.FAILED]: "读取失败",
    [SOURCE_STATUS.NOT_FETCHED]: "仅搜索命中（未读取）",
  }[source.status] ?? source.status;
  const title = source.title || source.url || "(untitled)";
  return `## ${source.id} · ${statusLabel} · ${title}`;
}

/** Materialise the human-readable `sources.md`. */
export function buildSourcesMarkdown({
  sources = [],
  runId,
  generatedAt,
  failures = [],
}) {
  const summary = summarizeSources(sources);
  const lines = [
    "# 来源清单",
    "",
    `- 运行 ID: ${runId}`,
    `- 生成时间: ${generatedAt}`,
    `- 统计: 共 ${summary.total} 条（已读取 ${summary.fetched} / 读取失败 ${summary.failed} / 仅搜索命中 ${summary.not_fetched}）`,
    "",
  ];
  for (const source of sources) {
    lines.push(sourceHeading(source), "");
    lines.push(`- URL: ${source.url || "(unknown)"}`);
    if (source.finalUrl && canonicalizeUrl(source.finalUrl) !== canonicalizeUrl(source.url)) {
      lines.push(`- 最终 URL: ${source.finalUrl}`);
    }
    if (source.aliases?.length) lines.push(`- 别名: ${source.aliases.join("、")}`);
    if (source.siteName) lines.push(`- 站点: ${source.siteName}`);
    if (source.publishedAt) {
      const label =
        source.publishedAtConfidence === "verified"
          ? "发布时间（页面核验）"
          : "发布时间（来源方自报，未核验）";
      lines.push(`- ${label}: ${source.publishedAt}`);
    } else if (source.publishedAtConfidence === "none" && source.status !== SOURCE_STATUS.FAILED) {
      lines.push("- 发布时间: 未提供/无法核验");
    }
    if (source.accessedAt) lines.push(`- 访问时间: ${source.accessedAt}`);
    if (source.httpStatus !== null) lines.push(`- HTTP 状态: ${source.httpStatus}`);
    if (source.contentChars !== null) lines.push(`- 正文字数: ${source.contentChars}`);
    if (source.status === SOURCE_STATUS.FAILED && source.error) {
      lines.push(`- 失败: [${source.error.code}] ${source.error.message}`);
    }
    if (source.status === SOURCE_STATUS.NOT_FETCHED) {
      lines.push("- 说明: 仅用于发现线索，正文未读取，不可作为事实依据");
    }
    if (source.excerpt) {
      const excerpt = String(source.excerpt).replace(/\s+/g, " ").slice(0, EXCERPT_LIMIT);
      lines.push(`- 摘要: ${excerpt}`);
    }
    lines.push("");
  }
  lines.push(buildProvenanceFooter({ runId, generatedAt, sources, failures }));
  return `${lines.join("\n")}\n`;
}
