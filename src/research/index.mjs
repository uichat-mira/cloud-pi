/**
 * Public API of the Cloud-Pi live research feature (AGT-028).
 *
 * This file is the stable boundary for a future scheduler and Feishu delivery:
 * start/execute one research run, read a persisted run by id, and list recent
 * runs. Nothing in this module reads credentials, builds a Pi session or
 * performs network I/O directly — the caller injects the AGT-027 runtime port
 * and the research tool layer (see `executeResearch` deps), which is also what
 * keeps offline tests deterministic.
 *
 * Usage:
 *
 * ```js
 * import {
 *   startResearch, executeResearch, readResearchRun, listResearchRuns,
 * } from "./src/research/index.mjs";
 *
 * // Blocking: resolves with the persisted run record.
 * const run = await executeResearch({ topic, goal, timeRange }, deps);
 *
 * // Non-blocking: run.json exists before this resolves.
 * const { runId, done } = await startResearch({ topic, goal, timeRange }, deps);
 * const finished = await done;
 *
 * // Read back later (fully offline; no runtime, no tools, no network).
 * const { run, report, sources } = await readResearchRun(runId, { rootDir });
 * const runs = await listResearchRuns({ rootDir }); // newest first
 * ```
 *
 * `deps` (see execute.mjs): `{ runtimePort, toolLayer, store?, now?, logger?,
 * signal?, rootDir?, env? }`.
 *
 * Artifact root resolution: `rootDir` argument > `RESEARCH_RUNS_DIR` >
 * `.work/research-runs` (relative to the process cwd).
 */
import { createRunStore, RunStoreError } from "./run-store.mjs";
import { executeResearch, startResearch } from "./execute.mjs";

export {
  executeResearch,
  startResearch,
  normalizeResearchRequest,
  generateRunId,
  RunValidationError,
  ResearchConfigError,
} from "./execute.mjs";

export { RunStoreError } from "./run-store.mjs";

/**
 * Read one persisted run by id.
 *
 * @param {string} runId
 * @param {{ rootDir?: string, env?: Record<string,string> }} [options]
 * @returns {Promise<{ run: object, report: string|null, sources: Array<object>|null }>}
 *   `report` is null when the run produced no report; `sources` is the ledger
 *   array from sources.json (null when missing).
 * @throws {RunStoreError} `not_found` for an unknown run, `parse_error` for a
 *   corrupt run.json or sources.json.
 */
export async function readResearchRun(runId, { rootDir, env = process.env } = {}) {
  const store = createRunStore({ rootDir, env });
  const run = await store.readRun(runId);
  const [report, sourcesRaw] = await Promise.all([
    store.readArtifactOrNull(runId, "report.md"),
    store.readArtifactOrNull(runId, "sources.json"),
  ]);
  let sources = null;
  if (sourcesRaw !== null) {
    let parsed;
    try {
      parsed = JSON.parse(sourcesRaw);
    } catch {
      throw new RunStoreError("parse_error", `sources.json for ${runId} is not valid JSON`);
    }
    if (Array.isArray(parsed)) sources = parsed;
    else if (parsed && Array.isArray(parsed.sources)) sources = parsed.sources;
    else {
      throw new RunStoreError("parse_error", `sources.json for ${runId} has an unexpected shape`);
    }
  }
  return { run, report, sources };
}

/**
 * List persisted runs, newest first. Corrupt run directories are skipped so one
 * broken run cannot hide the others.
 *
 * @param {{ rootDir?: string, env?: Record<string,string> }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function listResearchRuns({ rootDir, env = process.env } = {}) {
  const store = createRunStore({ rootDir, env });
  return store.listRuns();
}
