/**
 * Deterministic local HTTP fixtures for the research tool tests.
 *
 * Every research test runs against `http.createServer` on 127.0.0.1; no test in
 * this repository may touch the real network. Routes are plain handlers
 * `(req, res, url) => void | Promise<void>` or descriptors
 * `{status, headers, body, delayMs}`.
 */
import { createServer } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

/** Send an HTML response. */
export function sendHtml(res, html, { status = 200, headers = {} } = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    ...headers,
  });
  res.end(html);
}

/** Send a plain-text response. */
export function sendText(res, text, { status = 200, contentType = "text/plain; charset=utf-8", headers = {} } = {}) {
  res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Send an XML response (RSS). */
export function sendXml(res, xml, { status = 200, headers = {} } = {}) {
  res.writeHead(status, {
    "content-type": "text/xml; charset=utf-8",
    "content-length": Buffer.byteLength(xml),
    ...headers,
  });
  res.end(xml);
}

/** Send a JSON response. */
export function sendJson(res, payload, { status = 200, headers = {} } = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** Send raw bytes (binary/PDF fixtures). */
export function sendBinary(res, buffer, { status = 200, contentType = "application/octet-stream", headers = {} } = {}) {
  res.writeHead(status, { "content-type": contentType, "content-length": buffer.length, ...headers });
  res.end(buffer);
}

/** Send a gzip-compressed text body with `content-encoding: gzip`. */
export function sendGzip(res, text, { status = 200, contentType = "text/html; charset=utf-8", headers = {} } = {}) {
  const body = gzipSync(Buffer.from(text, "utf8"));
  res.writeHead(status, {
    "content-type": contentType,
    "content-encoding": "gzip",
    "content-length": body.length,
    ...headers,
  });
  res.end(body);
}

/** Send a brotli-compressed text body with `content-encoding: br`. */
export function sendBrotli(res, text, { status = 200, contentType = "text/html; charset=utf-8", headers = {} } = {}) {
  const body = brotliCompressSync(Buffer.from(text, "utf8"));
  res.writeHead(status, {
    "content-type": contentType,
    "content-encoding": "br",
    "content-length": body.length,
    ...headers,
  });
  res.end(body);
}

/** Send a deflate-compressed text body with `content-encoding: deflate`. */
export function sendDeflate(res, text, { status = 200, contentType = "text/html; charset=utf-8", headers = {} } = {}) {
  const body = deflateSync(Buffer.from(text, "utf8"));
  res.writeHead(status, {
    "content-type": contentType,
    "content-encoding": "deflate",
    "content-length": body.length,
    ...headers,
  });
  res.end(body);
}

/** Redirect helper. */
export function sendRedirect(res, location, status = 302) {
  res.writeHead(status, { location, "content-type": "text/plain" });
  res.end("redirecting");
}

/** Promise-based delay usable inside handlers. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRoute(route) {
  if (typeof route === "function") return route;
  if (!route || typeof route !== "object") {
    return (req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    };
  }
  return async (req, res) => {
    if (route.delayMs) await delay(route.delayMs);
    const headers = route.headers ?? {};
    const body = typeof route.body === "function" ? route.body() : route.body;
    res.writeHead(route.status ?? 200, { "content-type": "text/plain; charset=utf-8", ...headers });
    res.end(body ?? "");
  };
}

/**
 * Start one fixture server.
 *
 * @param {Record<string, Function|object> | Function} routes Path -> handler, or
 *   a single catch-all handler.
 * @returns {Promise<{url: string, port: number, requests: Array<object>,
 *   close: () => Promise<void>}>}
 */
export async function startFixtureServer(routes = {}) {
  const requests = [];
  const handler =
    typeof routes === "function"
      ? routes
      : (req, res, url) => normalizeRoute(routes[url.pathname] ?? routes["*"])(req, res, url);

  const server = createServer(async (req, res) => {
    // Clients abort on timeout/size-cap tests; never let a destroyed socket crash
    // the fixture server.
    req.on("error", () => {});
    res.on("error", () => {});
    const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: { ...req.headers },
    });
    try {
      await handler(req, res, url);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`fixture error: ${error?.message ?? error}`);
      } else {
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

/** Build an RSS document from item descriptors. */
export function rssFeed(items, { title = "Search results", link = "https://www.bing.com/search" } = {}) {
  const itemXml = items
    .map((item) => {
      const parts = [
        `<item>`,
        `<title><![CDATA[${item.title}]]></title>`,
        `<link>${item.link}</link>`,
        `<description><![CDATA[${item.description ?? ""}]]></description>`,
      ];
      if (item.pubDate) parts.push(`<pubDate>${item.pubDate}</pubDate>`);
      if (item.source) parts.push(`<source>${item.source}</source>`);
      parts.push(`</item>`);
      return parts.join("");
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${title}</title>
<link>${link}</link>
${itemXml}
</channel></rss>`;
}

/** Build a Bing-like HTML result page. */
export function bingHtmlResults(items) {
  const blocks = items
    .map((item) => {
      const href = item.wrapped
        ? `https://www.bing.com/ck/a?!&&p=fixture&u=a1${Buffer.from(item.url, "utf8").toString("base64url")}&ntb=1`
        : item.url;
      return `<li class="b_algo"><h2><a href="${href}">${item.title}</a></h2><div class="b_caption"><p>${item.snippet ?? ""}</p></div><cite>${new URL(item.url).hostname}</cite>${item.newsDt ? `<span class="news_dt">${item.newsDt}</span>` : ""}</li>`;
    })
    .join("\n");
  return `<!doctype html><html><head><title>Bing</title></head><body><ol id="b_results">${blocks}</ol></body></html>`;
}
