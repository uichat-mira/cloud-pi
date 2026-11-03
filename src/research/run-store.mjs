/**
 * Local persistence for research runs (AGT-028).
 *
 * A run is one directory under the runs root:
 *
 *   <root>/<runId>/run.json      record (written at start and on every transition)
 *   <root>/<runId>/report.md     final Markdown report (when one was produced)
 *   <root>/<runId>/sources.json  independent source ledger
 *   <root>/<runId>/sources.md    human-readable source list
 *
 * Every write is atomic: content goes to a temporary file in the same directory
 * and is then renamed over the target, so a crash can never leave a truncated
 * `run.json` that parses as valid JSON but loses fields.
 *
 * `run.json` stores artifact locations as paths relative to the run directory
 * (see `paths`), never absolute host paths, so a run directory can be moved or
 * archived together. The store never reads or writes credentials.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_RUNS_DIR, ENV, isRunStatus } from "./contracts.mjs";

/** `r-<UTC yyyymmddThhmmss>-<6 hex>`; stable and sortable by time. */
export const RUN_ID_PATTERN = /^r-\d{8}T\d{6}-[0-9a-f]{6}$/;

/** Stable artifact file names inside one run directory. */
export const ARTIFACT = Object.freeze({
  RUN: "run.json",
  REPORT: "report.md",
  SOURCES_JSON: "sources.json",
  SOURCES_MD: "sources.md",
  TRANSCRIPT: "transcript.md",
});

const ARTIFACT_NAMES = new Set(Object.values(ARTIFACT));
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** Machine-readable store failure classes. */
export const STORE_ERROR = Object.freeze({
  NOT_FOUND: "not_found",
  PARSE_ERROR: "parse_error",
  INVALID_RUN_ID: "invalid_run_id",
  INVALID_REQUEST: "invalid_request",
});

export class RunStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RunStoreError";
    this.code = code;
  }
}

/** @param {unknown} runId */
export function isValidRunId(runId) {
  return typeof runId === "string" && RUN_ID_PATTERN.test(runId);
}

/**
 * Resolve the artifact root: explicit argument > `RESEARCH_RUNS_DIR` > default.
 * Always returns an absolute path.
 */
export function resolveRunsRoot({ rootDir, env = process.env } = {}) {
  if (typeof rootDir === "string" && rootDir.trim()) return resolve(rootDir.trim());
  const fromEnv = env?.[ENV.RUNS_DIR];
  if (typeof fromEnv === "string" && fromEnv.trim()) return resolve(fromEnv.trim());
  return resolve(DEFAULT_RUNS_DIR);
}

/**
 * Atomic write: `data` → `<file>.tmp-<pid>-<rand>` → rename over `file`.
 * The temporary file lives in the target directory so rename is same-filesystem.
 */
export async function atomicWriteFile(filePath, data) {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tmpPath = join(directory, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmpPath, data, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a persisted run record. Corrupt or forged records must be refused
 * instead of being returned to a caller, so every failure is `parse_error`.
 *
 * @param {unknown} run
 * @param {{ expectRunId?: string }} [options]
 */
export function assertRunShape(run, { expectRunId } = {}) {
  const fail = (reason) => {
    throw new RunStoreError(STORE_ERROR.PARSE_ERROR, `invalid run record: ${reason}`);
  };
  if (!isPlainObject(run)) fail("not a JSON object");
  if (typeof run.contractVersion !== "number" || !Number.isInteger(run.contractVersion)) {
    fail("missing numeric contractVersion");
  }
  if (!isValidRunId(run.runId)) fail("missing or malformed runId");
  if (expectRunId && run.runId !== expectRunId) {
    fail(`runId ${run.runId} does not match directory ${expectRunId}`);
  }
  if (!isRunStatus(run.status)) fail(`unknown status ${JSON.stringify(run.status)}`);
  if (!isPlainObject(run.request) || typeof run.request.topic !== "string") {
    fail("missing request.topic");
  }
  if (typeof run.createdAt !== "string" || Number.isNaN(Date.parse(run.createdAt))) {
    fail("missing or invalid createdAt");
  }
  if (!isPlainObject(run.paths)) fail("missing paths");
  if (!Array.isArray(run.errors)) fail("missing errors array");
  return run;
}

function validateArtifactName(name) {
  if (typeof name !== "string" || !ARTIFACT_NAME_PATTERN.test(name) || name.includes("..")) {
    throw new RunStoreError(
      STORE_ERROR.INVALID_REQUEST,
      `artifact name must be a simple file name, got ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/**
 * Create a run store bound to one root directory.
 *
 * @param {{ rootDir?: string, env?: Record<string,string>, now?: () => Date }} [options]
 */
export function createRunStore({ rootDir, env = process.env, now = () => new Date() } = {}) {
  const root = resolveRunsRoot({ rootDir, env });
  const clock = typeof now === "function" ? now : () => new Date(now);

  function runDir(runId) {
    if (!isValidRunId(runId)) {
      throw new RunStoreError(STORE_ERROR.INVALID_RUN_ID, `invalid research run id: ${String(runId)}`);
    }
    return join(root, runId);
  }

  function artifactPath(runId, name) {
    return join(runDir(runId), validateArtifactName(name));
  }

  async function writeRunFile(runId, record) {
    assertRunShape(record, { expectRunId: runId });
    await atomicWriteFile(
      join(runDir(runId), ARTIFACT.RUN),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }

  /** Create the run directory and write the initial `run.json` (status running). */
  async function createRun(record) {
    if (!isPlainObject(record) || !isValidRunId(record.runId)) {
      throw new RunStoreError(STORE_ERROR.INVALID_REQUEST, "createRun requires a record with a valid runId");
    }
    await mkdir(runDir(record.runId), { recursive: true });
    await writeRunFile(record.runId, record);
    return record;
  }

  /** Atomically replace `run.json` for an existing run. */
  async function saveRun(runId, record) {
    if (!isPlainObject(record) || record.runId !== runId) {
      throw new RunStoreError(STORE_ERROR.INVALID_REQUEST, "saveRun record does not match the run id");
    }
    await mkdir(runDir(runId), { recursive: true });
    await writeRunFile(runId, record);
    return record;
  }

  /** Read and validate `run.json`; unknown → not_found, corrupt → parse_error. */
  async function readRun(runId) {
    const file = join(runDir(runId), ARTIFACT.RUN);
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw new RunStoreError(STORE_ERROR.NOT_FOUND, `research run not found: ${runId}`);
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RunStoreError(
        STORE_ERROR.PARSE_ERROR,
        `run.json for ${runId} is not valid JSON`,
      );
    }
    return assertRunShape(parsed, { expectRunId: runId });
  }

  /** All valid runs, newest first. Corrupt directories are skipped, not fatal. */
  async function listRuns() {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
      try {
        records.push(await readRun(entry.name));
      } catch {
        // A half-written or foreign directory must not break discovery.
      }
    }
    records.sort((a, b) => {
      const delta = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      return delta !== 0 ? delta : b.runId.localeCompare(a.runId);
    });
    return records;
  }

  /** Atomically write one artifact (string, Buffer or JSON-serialisable value). */
  async function writeArtifact(runId, name, content) {
    const file = artifactPath(runId, name);
    const data =
      typeof content === "string" || Buffer.isBuffer(content)
        ? content
        : `${JSON.stringify(content, null, 2)}\n`;
    await atomicWriteFile(file, data);
    return file;
  }

  async function readArtifact(runId, name) {
    try {
      return await readFile(artifactPath(runId, name), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new RunStoreError(STORE_ERROR.NOT_FOUND, `artifact not found: ${runId}/${name}`);
      }
      throw error;
    }
  }

  /** Like readArtifact, but returns null when the artifact does not exist. */
  async function readArtifactOrNull(runId, name) {
    try {
      return await readArtifact(runId, name);
    } catch (error) {
      if (error instanceof RunStoreError && error.code === STORE_ERROR.NOT_FOUND) return null;
      throw error;
    }
  }

  return {
    rootDir: root,
    now: clock,
    runDir,
    artifactPath,
    createRun,
    saveRun,
    readRun,
    listRuns,
    writeArtifact,
    readArtifact,
    readArtifactOrNull,
    artifactNames: ARTIFACT_NAMES,
  };
}
