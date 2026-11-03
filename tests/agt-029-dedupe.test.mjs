/**
 * AGT-029 T1: dedupe store behavior.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createDedupeStore } from "../src/channels/feishu/dedupe.mjs";

describe("AGT-029 T1: event dedupe store", () => {
  test("reserves a key once and rejects duplicates", () => {
    const dedupe = createDedupeStore();
    assert.equal(dedupe.reserve("event:1"), true);
    assert.equal(dedupe.reserve("event:1"), false);
    assert.equal(dedupe.reserve("event:2"), true);
    assert.equal(dedupe.has("event:1"), true);
    assert.equal(dedupe.size, 2);
  });

  test("rejects empty keys so a caller cannot silently skip dedupe", () => {
    const dedupe = createDedupeStore();
    assert.equal(dedupe.reserve(""), false);
    assert.equal(dedupe.reserve(undefined), false);
    assert.equal(dedupe.has(""), false);
  });

  test("expires entries after the TTL", () => {
    let now = 1_000;
    const dedupe = createDedupeStore({ ttlMs: 100, now: () => now });
    assert.equal(dedupe.reserve("event:1"), true);
    now = 1_050;
    assert.equal(dedupe.has("event:1"), true);
    now = 1_100;
    assert.equal(dedupe.has("event:1"), false);
    assert.equal(dedupe.reserve("event:1"), true);
  });

  test("bounds memory by evicting the oldest entry", () => {
    const dedupe = createDedupeStore({ maxEntries: 2 });
    dedupe.reserve("event:1");
    dedupe.reserve("event:2");
    dedupe.reserve("event:3");
    assert.equal(dedupe.size, 2);
    assert.equal(dedupe.has("event:1"), false);
    assert.equal(dedupe.has("event:3"), true);
  });
});
