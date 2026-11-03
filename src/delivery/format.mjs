/**
 * Bounded text formatting for scheduled-research delivery (AGT-033).
 *
 * Feishu text messages have a platform length limit, but the real risk is an
 * unbounded send loop: a long report must never turn into "send until it fits".
 * This module produces a deterministic, bounded list of segments:
 *
 *   - each segment is at most `maxCharsPerSegment` Unicode code points;
 *   - at most `maxSegments` messages are produced;
 *   - the last segment carries an explicit truncation marker naming the run id,
 *     so a shortened delivery is never presented as the complete report.
 *
 * Splitting happens on paragraph boundaries when that keeps a useful amount of
 * text, otherwise on a code-point boundary (never inside a surrogate pair).
 */
import { createHash } from "node:crypto";
import { DELIVERY_KIND, DELIVERY_LIMITS, describeResearchStatus } from "./contracts.mjs";

const TRUNCATION_PREFIX = "\n\n…（报告超出单次投递上限，已截断；完整报告见 run ";

function truncateCodepoints(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

function countCodepoints(text) {
  return Array.from(text).length;
}

/**
 * Split text into at most `maxSegments` chunks of at most `maxCharsPerSegment`
 * code points, prefixing each with `（i/n）`.
 *
 * The prefix budget is reserved before splitting, so the final message can
 * never exceed the declared limit.
 *
 * @param {string} text
 * @param {{ maxCharsPerSegment?: number, maxSegments?: number, runId: string }} options
 * @returns {{ segments: string[], truncated: boolean }}
 */
export function splitBounded(text, { maxCharsPerSegment = DELIVERY_LIMITS.maxCharsPerSegment, maxSegments = DELIVERY_LIMITS.maxSegments, runId } = {}) {
  if (typeof text !== "string") throw new TypeError("splitBounded requires text");
  const total = countCodepoints(text);
  if (total <= maxCharsPerSegment) return { segments: [text], truncated: false };

  // Reserve room for the widest possible "（n/n）\n" prefix.
  const prefixReserve = 16;
  const marker = `${TRUNCATION_PREFIX}${runId}）`;
  const budget = Math.max(1, maxCharsPerSegment - prefixReserve);

  const chunks = [];
  let offset = 0;
  const chars = Array.from(text);
  while (offset < chars.length && chunks.length < maxSegments) {
    let end = Math.min(offset + budget, chars.length);
    if (end < chars.length) {
      // Prefer a paragraph boundary in the second half of the window.
      const window = chars.slice(offset, end).join("");
      const boundary = window.lastIndexOf("\n\n");
      if (boundary >= Math.floor(window.length / 2)) {
        end = offset + countCodepoints(window.slice(0, boundary));
      }
    }
    chunks.push(chars.slice(offset, end).join(""));
    offset = end;
  }

  let truncated = offset < chars.length;
  if (truncated) {
    const lastIndex = chunks.length - 1;
    const markerCost = countCodepoints(marker) + 1;
    const room = Math.max(1, budget - markerCost);
    chunks[lastIndex] = `${truncateCodepoints(chunks[lastIndex], room).trimEnd()}${marker}`;
  }

  const totalSegments = chunks.length;
  const segments = chunks.map((chunk, index) => {
    const prefix = `（${index + 1}/${totalSegments}）\n`;
    const body = truncateCodepoints(chunk, maxCharsPerSegment - countCodepoints(prefix));
    return `${prefix}${body}`;
  });
  for (const segment of segments) {
    if (countCodepoints(segment) > maxCharsPerSegment) {
      // Defensive: a formatter bug must fail closed, not send an oversized chunk.
      throw new Error("delivery segment exceeds the configured codepoint limit");
    }
  }
  return { segments, truncated };
}

function shortLine(value, max = 120) {
  if (typeof value !== "string") return "";
  const single = value.replace(/\s+/g, " ").trim();
  return truncateCodepoints(single, max);
}

/**
 * Build the bounded messages for one terminal run.
 *
 * @param {object} input
 * @param {string} input.kind DELIVERY_KIND value (not `none`)
 * @param {string} input.runId
 * @param {string|null} [input.researchStatus]
 * @param {string|null} [input.triggerStatus]
 * @param {object} [input.schedule] `{ scheduleId, name }` trusted configuration
 * @param {object} [input.run] persisted run record (topic, finishedAt, errors)
 * @param {string|null} [input.report] report.md content when a report exists
 * @param {{code?:string,message?:string}|null} [input.triggerError]
 * @param {{maxCharsPerSegment?:number,maxSegments?:number}} [input.limits]
 * @returns {{ segments: string[], truncated: boolean, kind: string }}
 */
export function buildDeliveryMessage({
  kind,
  runId,
  researchStatus = null,
  triggerStatus = null,
  schedule = null,
  run = null,
  report = null,
  triggerError = null,
  limits = {},
}) {
  if (!kind || kind === DELIVERY_KIND.NONE) {
    throw new Error("buildDeliveryMessage requires a deliverable kind");
  }
  const topic = shortLine(run?.request?.topic, 200);
  const statusText = researchStatus
    ? describeResearchStatus(researchStatus)
    : triggerStatus
      ? `触发结束（${triggerStatus}）`
      : "状态未知";
  const lines = [
    "[Cloud Pi · 定时研究]",
    `状态：${statusText}`,
  ];
  if (schedule?.name) lines.push(`任务：${shortLine(schedule.name, 120)}`);
  else if (schedule?.scheduleId) lines.push(`任务：${shortLine(schedule.scheduleId, 120)}`);
  if (topic) lines.push(`主题：${topic}`);
  lines.push(`Run：${runId}`);
  if (run?.finishedAt) lines.push(`结束时间：${run.finishedAt}`);

  const errorCount = Array.isArray(run?.errors) ? run.errors.length : 0;
  if (kind === DELIVERY_KIND.REPORT_PARTIAL) {
    const codes = Array.isArray(run?.errors)
      ? [...new Set(run.errors.map((entry) => entry?.code).filter(Boolean))].slice(0, 4)
      : [];
    lines.push(`提示：部分完成 — 报告已生成，但记录了 ${errorCount} 项错误${
      codes.length ? `（${codes.join(", ")}）` : ""
    }。以下为已有报告内容，不代表全部步骤成功。`);
  }
  if (kind === DELIVERY_KIND.STATUS) {
    lines.push("说明：本次研究未生成可投递的成功报告。");
    const errorCode = triggerError?.code ?? run?.errors?.[0]?.code ?? null;
    if (errorCode) lines.push(`原因：${shortLine(String(errorCode), 80)}`);
    if (triggerError?.message) lines.push(`详情：${shortLine(String(triggerError.message), 300)}`);
  }

  let text = lines.join("\n");
  if (kind !== DELIVERY_KIND.STATUS && typeof report === "string" && report.trim()) {
    text += `\n\n──────────\n${report.trim()}`;
  }
  text += "\n\n— Mira Cloud Agent（自动投递）";
  const split = splitBounded(text, {
    runId,
    maxCharsPerSegment: limits.maxCharsPerSegment,
    maxSegments: limits.maxSegments,
  });
  return { ...split, kind };
}

/**
 * Deterministic Feishu `uuid` for one segment. Feishu may suppress an identical
 * retry within its own window; the local delivery store is still the primary
 * idempotency guard.
 */
export function segmentUuid(deliveryKey, index) {
  return createHash("sha256").update(`${deliveryKey}:segment:${index}`).digest("hex").slice(0, 32);
}
