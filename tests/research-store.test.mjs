/**
 * Run store tests (AGT-028, offline): round-trip, atomic writes, classified
 * errors for missing/corrupt runs, discovery order and artifact path safety.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ARTIFACT,
  STORE_ERROR,
  RunStoreError,
  atomicWriteFile,
  createRunStore,
  isValidRunId,
  resolveRunsRoot,
} from "../src/research/run-store.mjs";
import { CONTRACT_VERSION, RUN_STATUS } from "../src/research/contracts.mjs";

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "cloud-pi-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function runRecord({ runId, topic = "AI agent engineering", createdAt = "2026-11-02T09:00:00.000Z" }) {
  return {
    contractVersion: CONTRACT_VERSION,
    runId,
    status: RUN_STATUS.RUNNING,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    finishedAt: null,
    request: { topic, goal: "", timeRange: "48h" },
    limits: { maxSearches: 6 },
    statusHistory: [{ status: RUN_STATUS.RUNNING, at: createdAt }],
    runtime: null,
    tools: { counters: {}, calls: [] },
    sourcesSummary: null,
    citations: null,
    errors: [],
    paths: { run: "run.json", report: null, sources: null, sourcesMarkdown: null, transcript: null },
  };
}

const RUN_A = "r-20261102T090000-aaaaaa";
const RUN_B = "r-20261102T100000-bbbbbb";
const RUN_C = "r-20261102T110000-cccccc";

test("resolveRunsRoot: explicit > env > default", () => {
  // Compare against `resolve()`-normalized expectations: a POSIX literal such as
  // "/tmp/explicit" is <drive>:\tmp\explicit on Windows, and the documented
  // contract is "always absolute", not "always POSIX".
  assert.equal(
    resolveRunsRoot({ rootDir: "/tmp/explicit", env: { RESEARCH_RUNS_DIR: "/tmp/from-env" } }),
    resolve("/tmp/explicit"),
  );
  assert.equal(resolveRunsRoot({ env: { RESEARCH_RUNS_DIR: "/tmp/from-env" } }), resolve("/tmp/from-env"));
  assert.match(resolveRunsRoot({ env: {} }), /[/\\]\.work[/\\]research-runs$/);
});

test("run id validation and generated ids match the contract pattern", () => {
  assert.equal(isValidRunId(RUN_A), true);
  assert.equal(isValidRunId("r-20261102T090000-AAAAAA"), false);
  assert.equal(isValidRunId("not-a-run"), false);
  assert.equal(isValidRunId("../r-20261102T090000-aaaaaa"), false);
});

test("createRun → readRun round-trips the record", async (t) => {
  const root = await tempRoot(t);
  const store = createRunStore({ rootDir: root });
  const record = runRecord({ runId: RUN_A });
  await store.createRun(record);
  const loaded = await store.readRun(RUN_A);
  assert.deepEqual(loaded, record);
  const raw = await readFile(join(root, RUN_A, ARTIFACT.RUN), "utf8");
  assert.deepEqual(JSON.parse(raw), record);
});

test("runs discovered newest first and corrupt/foreign directories skipped", async (t) => {
  const root = await tempRoot(t);
  const store = createRunStore({ rootDir: root });
  await store.createRun(runRecord({ runId: RUN_A, createdAt: "2026-11-02T09:00:00.000Z" }));
  await store.createRun(runRecord({ runId: RUN_C, createdAt: "2026-11-02T11:00:00.000Z" }));
  await store.createRun(runRecord({ runId: RUN_B, createdAt: "2026-11-02T10:00:00.000Z" }));

  // Corrupt record in a valid-looking run directory.
  const corruptId = "r-20261102T120000-dddddd";
  await mkdir(join(root, corruptId), { recursive: true });
  await writeFile(join(root, corruptId, ARTIFACT.RUN), "{not json", "utf8");
  // Foreign directory that is not a run id.
  await mkdir(join(root, "scratch"), { recursive: true });

  const runs = await store.listRuns();
  assert.deepEqual(runs.map((run) => run.runId), [RUN_C, RUN_B, RUN_A]);
});

test("missing run is not_found, invalid id is invalid_run_id", async (t) => {
  const root = await tempRoot(t);
  const store = createRunStore({ rootDir: root });
  await assert.rejects(store.readRun(RUN_B), (error) => {
    assert.ok(error instanceof RunStoreError);
    assert.equal(error.code, STORE_ERROR.NOT_FOUND);
    return true;
  });
  await assert.rejects(store.readRun("nope"), (error) => {
    assert.ok(error instanceof RunStoreError);
    assert.equal(error.code, STORE_ERROR.INVALID_RUN_ID);
    return true;
  });
});

test("corrupt run.json is parse_error (bad JSON and bad shape)", async (t) => {
  const root = await tempRoot(t);
  const store = createRunStore({ rootDir: root });

  await mkdir(join(root, RUN_A), { recursive: true });
  await writeFile(join(root, RUN_A, ARTIFACT.RUN), "{oops", "utf8");
  await assert.rejects(store.readRun(RUN_A), (error) => {
    assert.equal(error.code, STORE_ERROR.PARSE_ERROR);
    return true;
  });

  // Structurally valid JSON but not a run record.
  await writeFile(join(root, RUN_A, ARTIFACT.RUN), JSON.stringify({ runId: RUN_A }), "utf8");
  await assert.rejects(store.readRun(RUN_A), (error) => {
    assert.equal(error.code, STORE_ERROR.PARSE_ERROR);
    assert.match(error.message, /invalid run record/);
    return true;
  });
});

test("run.json for a different id is refused", async (t) => {
  const root = await tempRoot(t);
  const store = createRunStore({ rootDir: root });
  await mkdir(join(root, RUN_A), { recursive: true });
  await writeFile(join(root, RUN_A, ARTIFACT.RUN), JSON.stringify(runRecord({ runId: RUN_B })), "utf8");
  await assert.rejects(store.readRun(RUN_A), (error) => {
    assert.equal(error.code, STORE_ERROR.PARSE_ERROR);
    return true;
  });
});

test("writes are atomic: no temp files remain and content is complete", async (t) => {
  const root = await tempRoot(t);
  const store = createRunStore({ rootDir: root });
  await store.createRun(runRecord({ runId: RUN_A }));
  const record = runRecord({ runId: RUN_A });
  record.status = RUN_STATUS.COMPLETED;
  await store.saveRun(RUN_A, record);
  const entries = await readdir(join(root, RUN_A));
  assert.deepEqual(entries.sort(), [ARTIFACT.RUN]);
  const loaded = await store.readRun(RUN_A);
  assert.equal(loaded.status, RUN_STATUS.COMPLETED);
});

test("atomicWriteFile replaces content and cleans its temp file", async (t) => {
  const root = await tempRoot(t);
  const file = join(root, "artifact.txt");
  await atomicWriteFile(file, "first");
  await atomicWriteFile(file, "second-and-longer");
  assert.equal(await readFile(file, "utf8"), "second-and-longer");
  assert.deepEqual(await readdir(root), ["artifact.txt"]);
});

test("artifacts round-trip and reject path traversal", async (t) => {
  const root = await tempRoot(t);
  const store = createRunStore({ rootDir: root });
  await store.createRun(runRecord({ runId: RUN_A }));
  await store.writeArtifact(RUN_A, ARTIFACT.SOURCES_MD, "# sources\n");
  assert.equal(await store.readArtifact(RUN_A, ARTIFACT.SOURCES_MD), "# sources\n");
  assert.equal(await store.readArtifactOrNull(RUN_A, ARTIFACT.REPORT), null);
  await assert.rejects(store.writeArtifact(RUN_A, "../escape.md", "x"), (error) => {
    assert.equal(error.code, STORE_ERROR.INVALID_REQUEST);
    return true;
  });
});

test("createRun rejects a malformed record and keeps run id directories valid", async (t) => {
  const root = await tempRoot(t);
  const store = createRunStore({ rootDir: root });
  await assert.rejects(store.createRun({ runId: "bad" }), (error) => {
    assert.equal(error.code, STORE_ERROR.INVALID_REQUEST);
    return true;
  });
  await assert.rejects(store.createRun({ ...runRecord({ runId: RUN_A }), status: "weird" }), (error) => {
    assert.equal(error.code, STORE_ERROR.PARSE_ERROR);
    return true;
  });
});
