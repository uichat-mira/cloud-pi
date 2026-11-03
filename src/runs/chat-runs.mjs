/**
 * Persist non-research (channel) runs into the existing run store.
 *
 * The run store is the single source of run records (AGT-028), so a chat turn
 * uses the *same* store, the *same* directory layout and the *same* `run.json`
 * schema; channel-specific facts are additive fields only. There is no second
 * database, no second id space and no new observability system — this is what
 * lets `/v1/runs/<id>` resolve a `runId` that a WeCom or Feishu reply carried.
 *
 * Deliberate omissions: message text, sender ids, raw chat ids and credentials
 * are never written. A chat run stores a masked chat id and token counts only.
 */
import { join } from "node:path";
import { hashId } from "../channels/wecom/config.mjs";
import { CONTRACT_VERSION, RUN_STATUS } from "../research/contracts.mjs";
import { createRunStore, isValidRunId, resolveRunsRoot } from "../research/run-store.mjs";

/**
 * A channel-outcome chat id is the platform's own identifier (`userid`, `chatid`,
 * `open_id`); it is never written as-is. Enterprise `userid` values are stable
 * employee identifiers, so this uses the repository's truncated-hash helper
 * rather than a head/tail mask.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function maskedChatId(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  // Already-projected ids (`id:…`) are kept verbatim so re-projection stays idempotent.
  if (value.startsWith("id:")) return value;
  const hashed = hashId(value);
  return hashed.startsWith("id:") ? hashed : `id:${hashed}`;
}

/** Channel outcome status → persisted run status. */
const STATUS_MAP = Object.freeze({
  succeeded: RUN_STATUS.COMPLETED,
  failed: RUN_STATUS.FAILED,
  cancelled: RUN_STATUS.CANCELLED,
  timeout: RUN_STATUS.TIMEOUT,
});

/** Fields every run record shares; the key set is fixed, not derived. */
const BASE_PATHS = Object.freeze({
  run: "run.json",
  report: null,
  sources: null,
  sourcesMarkdown: null,
  transcript: null,
});

/**
 * Project a channel outcome into a run-store record.
 *
 * @param {object} params
 * @param {object} params.outcome channel outcome (`action`, `status`, `runId`, …)
 * @param {string} params.channel `"wecom"` or `"feishu"`
 * @param {() => Date} [params.now]
 * @returns {object|null} null when the outcome has no store-compatible run id
 */
export function toChatRunRecord({ outcome, channel, now = () => new Date() }) {
  const runId = typeof outcome?.runId === "string" ? outcome.runId : "";
  // A run that cannot be addressed by the store is not persisted at all: writing
  // it under another id would break the runId ↔ record guarantee.
  if (!isValidRunId(runId)) return null;
  const createdAt = now().toISOString();
  const durationMs = Number.isFinite(outcome?.durationMs) ? Math.max(0, Math.round(outcome.durationMs)) : 0;
  const usage = outcome?.usage && typeof outcome.usage === "object" ? outcome.usage : null;
  return {
    contractVersion: CONTRACT_VERSION,
    runId,
    // A chat run has no research topic; the fixed string keeps the shared schema
    // valid without ever storing the user's message.
    status: STATUS_MAP[outcome?.status] ?? RUN_STATUS.FAILED,
    request: { topic: "chat message", channel },
    createdAt,
    startedAt: new Date(new Date(createdAt).getTime() - durationMs).toISOString(),
    finishedAt: createdAt,
    durationMs,
    // Additive channel facts (the research keys above are unchanged).
    channel,
    chatType: typeof outcome?.chatType === "string" ? outcome.chatType : null,
    chatIdMasked: maskedChatId(outcome?.chatId),
    reply: {
      delivered: outcome?.replyDelivered === true,
      segments: Number.isFinite(outcome?.segments) ? outcome.segments : null,
      segmentsDelivered: Number.isFinite(outcome?.segmentsDelivered) ? outcome.segmentsDelivered : null,
    },
    // Same token vocabulary as a research run's `runtime.usage`, so the API
    // projection (`inputTokens`/`outputTokens`/`totalTokens`) applies unchanged.
    usage: usage
      ? {
          inputTokens: Number.isFinite(usage.input) ? usage.input : 0,
          outputTokens: Number.isFinite(usage.output) ? usage.output : 0,
          totalTokens: Number.isFinite(usage.total) ? usage.total : 0,
        }
      : null,
    paths: { ...BASE_PATHS },
    errors: [],
  };
}

/**
 * Create a fire-and-forget recorder bound to one run root.
 *
 * Persistence must never break a reply that was already delivered, so failures
 * are logged and swallowed. Invalid ids are logged once per run and skipped.
 *
 * @param {object} [options]
 * @param {string} [options.rootDir] run root (default: `RESEARCH_RUNS_DIR` or `.work/research-runs`)
 * @param {Record<string,string>} [options.env]
 * @param {() => Date} [options.now]
 * @param {Function} [options.log]
 * @param {object} [options.store] injected store (tests)
 */
export function createChatRunRecorder({ rootDir, env = process.env, now = () => new Date(), log = () => {}, store } = {}) {
  const runsRoot = resolveRunsRoot({ rootDir, env });
  const runStore = store ?? createRunStore({ rootDir: runsRoot, env, now });

  return {
    rootDir: runsRoot,

    /**
     * @param {object} outcome channel outcome
     * @param {{channel: string}} meta
     * @returns {Promise<string|null>} the persisted run id, or null
     */
    async record(outcome, { channel } = {}) {
      const record = toChatRunRecord({ outcome, channel, now });
      if (!record) {
        log({
          level: "warn",
          event: "chat_run_not_persisted",
          channel,
          reason: "run_id_not_store_compatible",
        });
        return null;
      }
      try {
        await runStore.createRun(record);
        log({ level: "info", event: "chat_run_persisted", channel, runId: record.runId, status: record.status });
        return record.runId;
      } catch (error) {
        log({
          level: "warn",
          event: "chat_run_persist_failed",
          channel,
          runId: record.runId,
          code: String(error?.code ?? error?.name ?? "error"),
        });
        return null;
      }
    },

    /** Absolute path of one persisted run directory (diagnostics only). */
    pathFor(runId) {
      return join(runsRoot, String(runId));
    },
  };
}
