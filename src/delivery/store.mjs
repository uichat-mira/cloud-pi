/**
 * File-backed delivery result store (AGT-033).
 *
 * Layout, one document per `runId + destination`:
 *
 *   <stateDir>/runs/<runId>/<sha256(deliveryKey)[0..32]>.json
 *
 * The raw Feishu id is inside the document because a restart must be able to
 * re-send to the same destination; the file name and evidence are masked. This
 * store is the single source of truth for delivery status: the research run
 * store is never modified.
 *
 * Writes use the shared same-directory atomic replacement. As with the
 * scheduler POC, the contract is one process per state directory; the store
 * deliberately adds no cross-process lock.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../fs/atomic.mjs";
import { isValidRunId } from "../research/run-store.mjs";
import {
  DELIVERY_CONTRACT_VERSION,
  DELIVERY_ERROR,
  DELIVERY_KIND,
  DELIVERY_STATUS,
  DeliveryError,
  buildDeliveryKey,
  deliveryFileStem,
  normalizeDestination,
  resolveDeliveryStateDir,
} from "./contracts.mjs";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const DELIVERY_STATUSES = new Set(Object.values(DELIVERY_STATUS));
const DELIVERY_KINDS = new Set(Object.values(DELIVERY_KIND));

/** Validate a persisted delivery record; corrupt records fail closed. */
export function assertDeliveryRecordShape(record) {
  const invalid = (reason) => {
    throw new DeliveryError(
      DELIVERY_ERROR.INTERNAL_ERROR,
      `invalid delivery record: ${reason}`,
    );
  };
  if (!isPlainObject(record)) invalid("not a JSON object");
  if (record.contractVersion !== DELIVERY_CONTRACT_VERSION) {
    invalid(`unsupported contractVersion ${JSON.stringify(record.contractVersion)}`);
  }
  if (!isValidRunId(record.runId)) invalid("missing or malformed runId");
  const destination = normalizeDestination(record.destination);
  if (record.deliveryKey !== buildDeliveryKey(record.runId, destination)) {
    invalid("deliveryKey does not match runId + destination");
  }
  if (!DELIVERY_STATUSES.has(record.status)) invalid(`unknown status ${JSON.stringify(record.status)}`);
  if (!DELIVERY_KINDS.has(record.deliveryKind)) {
    invalid(`unknown deliveryKind ${JSON.stringify(record.deliveryKind)}`);
  }
  if (!Number.isInteger(record.attempts) || record.attempts < 0) invalid("attempts must be a non-negative integer");
  if (!Array.isArray(record.segmentsSent)) invalid("missing segmentsSent array");
  for (const entry of record.segmentsSent) {
    if (!Number.isInteger(entry.index) || entry.index < 0) invalid("segment index must be an integer");
    if (typeof entry.messageId !== "string" || !entry.messageId) invalid("segment messageId is required");
    if (typeof entry.sentAt !== "string" || Number.isNaN(Date.parse(entry.sentAt))) invalid("segment sentAt is invalid");
  }
  if (record.status === DELIVERY_STATUS.SENT) {
    if (!record.sentAt || Number.isNaN(Date.parse(record.sentAt))) invalid("sent record needs sentAt");
    if (!record.messageId) invalid("sent record needs messageId");
  }
  return record;
}

/**
 * Create a delivery store bound to one state directory.
 *
 * @param {{ stateDir?: string, env?: Record<string,string> }} [options]
 */
export function createDeliveryStore({ stateDir, env = process.env } = {}) {
  const rootDir = resolveDeliveryStateDir({ stateDir, env });
  const runsDir = join(rootDir, "runs");

  function assertRunId(runId) {
    if (!isValidRunId(runId)) {
      throw new DeliveryError(DELIVERY_ERROR.INTERNAL_ERROR, `invalid research run id: ${String(runId)}`);
    }
  }

  function runDir(runId) {
    assertRunId(runId);
    return join(runsDir, runId);
  }

  function recordPath(runId, destination) {
    const key = buildDeliveryKey(runId, destination);
    return join(runDir(runId), `${deliveryFileStem(key)}.json`);
  }

  /** Read one record, or `null` when this run has never tried this destination. */
  async function readRecord(runId, destination) {
    const file = recordPath(runId, destination);
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DeliveryError(
        DELIVERY_ERROR.INTERNAL_ERROR,
        `delivery record for ${runId} is not valid JSON`,
      );
    }
    return assertDeliveryRecordShape(parsed);
  }

  /** All records for one run, ordered by delivery key for deterministic views. */
  async function listRun(runId) {
    let entries;
    try {
      entries = await readdir(runDir(runId));
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
      throw error;
    }
    const records = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const raw = await readFile(join(runDir(runId), name), "utf8");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new DeliveryError(
          DELIVERY_ERROR.INTERNAL_ERROR,
          `delivery record ${runId}/${name} is not valid JSON`,
        );
      }
      records.push(assertDeliveryRecordShape(parsed));
    }
    return records.sort((a, b) => a.deliveryKey.localeCompare(b.deliveryKey));
  }

  async function writeRecord(record) {
    assertDeliveryRecordShape(record);
    await atomicWriteFile(
      recordPath(record.runId, record.destination),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    return record;
  }

  return {
    rootDir,
    runsDir,
    runDir,
    recordPath,
    readRecord,
    listRun,
    writeRecord,
  };
}
