/**
 * Deterministic Guanlan fixture data for the P0.
 *
 * The data mirrors what the real product stores: a shared news index, one
 * provisioned account with two stable consumers, one second account with no
 * subscription, and per-consumer decision rows keyed by the SHA-256 fingerprint
 * of the canonical article URL (GLN-007). Nothing here touches Guanlan source.
 */
import { createHash } from "node:crypto";

export const CREATED_AT = "2026-10-31T00:00:00.000Z";

export const FIXTURE = {
  sources: {
    main: "feed-main",
    page: "feed-page",
    adopted: "feed-adopted",
    unsubscribed: "feed-unsubscribed",
  },
  accounts: {
    a: "account-a",
    b: "account-b",
  },
  consumers: {
    one: "consumer-1",
    two: "consumer-2",
    b: "consumer-b",
  },
  urls: {
    one: "https://example.com/main/one",
    two: "https://example.com/main/two",
    long: `https://example.com/main/long?token=${"a".repeat(3000)}`,
    page: (index) => `https://example.com/page/${String(index).padStart(2, "0")}`,
    adopted: (index) => `https://example.com/adopted/${String(index).padStart(3, "0")}`,
  },
};

export function fingerprint(url) {
  return createHash("sha256").update(url).digest("hex");
}

function iso(offsetSeconds) {
  return new Date(Date.UTC(2026, 9, 30, 12, 0, 0) - offsetSeconds * 1000).toISOString();
}

async function insertMany(db, table, columns, rows) {
  // D1 caps a single statement at 100 bound parameters.
  const perStatement = Math.max(1, Math.floor(100 / columns.length));
  for (let index = 0; index < rows.length; index += perStatement) {
    const chunk = rows.slice(index, index + perStatement);
    const values = chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
    await db
      .prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${values}`)
      .bind(...chunk.flat())
      .run();
  }
}

export async function seedFixture(db) {
  await db.batch([
    db.prepare("INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)")
      .bind(FIXTURE.sources.main, "https://example.com/main.xml", 1, CREATED_AT),
    db.prepare("INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)")
      .bind(FIXTURE.sources.page, "https://example.com/page.xml", 1, CREATED_AT),
    db.prepare("INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)")
      .bind(FIXTURE.sources.adopted, "https://example.com/adopted.xml", 1, CREATED_AT),
    // Exists in the global index but is not subscribed by account A.
    db.prepare("INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)")
      .bind(FIXTURE.sources.unsubscribed, "https://example.com/unsubscribed.xml", 1, CREATED_AT),
    db.prepare("INSERT INTO guanlan_accounts (account_id,created_at) VALUES (?,?)")
      .bind(FIXTURE.accounts.a, CREATED_AT),
    db.prepare("INSERT INTO guanlan_accounts (account_id,created_at) VALUES (?,?)")
      .bind(FIXTURE.accounts.b, CREATED_AT),
    db.prepare("INSERT INTO guanlan_consumers (account_id,consumer_id,created_at) VALUES (?,?,?)")
      .bind(FIXTURE.accounts.a, FIXTURE.consumers.one, CREATED_AT),
    db.prepare("INSERT INTO guanlan_consumers (account_id,consumer_id,created_at) VALUES (?,?,?)")
      .bind(FIXTURE.accounts.a, FIXTURE.consumers.two, CREATED_AT),
    db.prepare("INSERT INTO guanlan_consumers (account_id,consumer_id,created_at) VALUES (?,?,?)")
      .bind(FIXTURE.accounts.b, FIXTURE.consumers.b, CREATED_AT),
    db.prepare(
      "INSERT INTO guanlan_account_subscriptions (account_id,source_id,interval_hours,created_at) VALUES (?,?,?,?)",
    ).bind(FIXTURE.accounts.a, FIXTURE.sources.main, 1, CREATED_AT),
    db.prepare(
      "INSERT INTO guanlan_account_subscriptions (account_id,source_id,interval_hours,created_at) VALUES (?,?,?,?)",
    ).bind(FIXTURE.accounts.a, FIXTURE.sources.page, 1, CREATED_AT),
    db.prepare(
      "INSERT INTO guanlan_account_subscriptions (account_id,source_id,interval_hours,created_at) VALUES (?,?,?,?)",
    ).bind(FIXTURE.accounts.a, FIXTURE.sources.adopted, 1, CREATED_AT),
  ]);

  // Three main-source items. `two` is adopted by consumer-1, `one` is pending,
  // and `long` stays unread; consumer-2 has no decisions at all.
  await insertMany(
    db,
    "poc_news",
    ["url", "source_id", "title", "summary", "published_at", "ingested_at"],
    [
      [FIXTURE.urls.one, FIXTURE.sources.main, "Alpha one", "First alpha summary", iso(3600), iso(3600)],
      [FIXTURE.urls.two, FIXTURE.sources.main, "Beta two", "Second beta summary", iso(7200), iso(7200)],
      [FIXTURE.urls.long, FIXTURE.sources.main, "Long link", "Long URL summary", iso(1800), iso(1800)],
    ],
  );

  // Pagination source: 12 unread rows, distinct ingested_at values.
  await insertMany(
    db,
    "poc_news",
    ["url", "source_id", "title", "summary", "published_at", "ingested_at"],
    Array.from({ length: 12 }, (_, index) => [
      FIXTURE.urls.page(index + 1),
      FIXTURE.sources.page,
      `Page item ${index + 1}`,
      `Page summary ${index + 1}`,
      iso(600 + index),
      iso(600 + index),
    ]),
  );

  // Scan-budget source: 420 adopted rows and no unread row, so a bounded unread
  // scan must return an empty page with a non-null continuation cursor.
  const adoptedUrls = Array.from({ length: 420 }, (_, index) => FIXTURE.urls.adopted(index + 1));
  await insertMany(
    db,
    "poc_news",
    ["url", "source_id", "title", "summary", "published_at", "ingested_at"],
    adoptedUrls.map((url, index) => [
      url,
      FIXTURE.sources.adopted,
      `Adopted item ${index + 1}`,
      `Adopted summary ${index + 1}`,
      iso(10000 + index),
      iso(10000 + index),
    ]),
  );

  const decidedAt = "2026-10-30T13:00:00.000Z";
  const decisions = [
    [FIXTURE.consumers.one, FIXTURE.urls.one, FIXTURE.sources.main, "pending"],
    [FIXTURE.consumers.one, FIXTURE.urls.two, FIXTURE.sources.main, "adopted"],
    ...adoptedUrls.map((url) => [FIXTURE.consumers.one, url, FIXTURE.sources.adopted, "adopted"]),
  ];
  await insertMany(
    db,
    "guanlan_consumer_news_states",
    [
      "account_id",
      "consumer_id",
      "news_fingerprint",
      "source_id",
      "status",
      "reason",
      "outcome_url",
      "decided_at",
      "version",
      "last_operation_id",
    ],
    decisions.map(([consumerId, url, sourceId, status]) => [
      FIXTURE.accounts.a,
      consumerId,
      fingerprint(url),
      sourceId,
      status,
      null,
      null,
      decidedAt,
      1,
      `p0-seed-${fingerprint(url).slice(0, 12)}`,
    ]),
  );
}

/** Same fixture without the news index, to force a real storage failure. */
export async function seedBrokenFixture(db) {
  await seedFixture(db);
  await db.prepare("DROP TABLE poc_news").run();
}
