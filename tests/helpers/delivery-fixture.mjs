/**
 * Deterministic fixtures for AGT-033 delivery tests.
 *
 * Only the external Feishu network boundary is faked. The delivery store,
 * coordinator, scheduler, AGT-028 executor and run store under test are the real
 * modules; `fakeSendMessage` records exactly what would have crossed the wire.
 */
import { FeishuSendError } from "../../src/channels/feishu/transport.mjs";

export const RUN_ID = "r-20261103T010000-abcdef";

export function makeRun({
  runId = RUN_ID,
  status = "completed",
  topic = "研究最近 48 小时 AI Agent 工程进展",
  report = "## 摘要\n\nfixture 报告正文。\n",
  errors = [],
  finishedAt = "2026-11-03T01:00:30.000Z",
} = {}) {
  return {
    run: {
      contractVersion: 1,
      runId,
      status,
      request: { topic },
      createdAt: "2026-11-03T01:00:00.000Z",
      finishedAt,
      paths: { run: "run.json", report: report ? "report.md" : null },
      errors,
    },
    report,
  };
}

/**
 * Fake send function with scripted failures.
 *
 * `failures` is consumed in order; each entry is either an Error to throw or
 * `null` to succeed.
 */
export function fakeSendMessage({ failures = [], onSend } = {}) {
  const calls = [];
  async function sendMessage(request) {
    calls.push({ ...request });
    onSend?.(request, calls.length);
    const scripted = failures.length > 0 ? failures.shift() : null;
    if (scripted) throw scripted;
    return { messageId: `om_${String(calls.length).padStart(4, "0")}` };
  }
  return { sendMessage, calls };
}

export function retryableError(message = "feishu network failure") {
  return new FeishuSendError(message, { code: "feishu_network_error", retryable: true });
}

export function nonRetryableError(message = "invalid receive id") {
  return new FeishuSendError(message, { code: "feishu_api_error", retryable: false, feishuCode: 230001 });
}

export const TWO_TARGETS = Object.freeze([
  { type: "open_id", id: "ou_testperson0001", label: "个人" },
  { type: "chat_id", id: "oc_test_group_0001", label: "群" },
]);
