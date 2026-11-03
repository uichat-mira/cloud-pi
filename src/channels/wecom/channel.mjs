/**
 * The WeCom channel: routing, per-conversation serialization, cancellation,
 * dedupe and the outbound reply.
 *
 * This is a channel, not a runtime: the model work arrives through injected
 * `runTurn` / `runResearch` seams, exactly like the Feishu channel, so there is
 * only one Agent execution surface in the repository.
 *
 * WeCom-specific behaviour that shapes this module:
 *  - callbacks arrive on a long-lived connection and must be acknowledged by the
 *    transport, never by awaiting a model run here (`handleEvent` is synchronous);
 *  - the platform gives no cancellation primitive, so `/stop` is a text command
 *    handled locally with an epoch per conversation;
 *  - replies are bounded by 20480 UTF-8 **bytes**, so长报告 is split by
 *    `splitForSend()` before sending.
 */
import { hashId, WECOM_DEFAULT_ACK_TEXT, WECOM_MAX_CONTENT_BYTES, WECOM_PLATFORM_ERROR } from "./config.mjs";
import { createWecomDedupeStore } from "./dedupe.mjs";
import { normalizeWecomMessageEvent } from "./events.mjs";
import { decideWecomRoute, WECOM_IGNORE_REASON } from "./policy.mjs";
import { byteLength, splitForSend, WECOM_CHAT_SEGMENT_LIMITS } from "./text.mjs";
import { sanitizeModelReply } from "../../redaction.mjs";

export const WECOM_STOP_COMMAND = "/stop";
export const WECOM_RESEARCH_COMMAND = "/research";

/** Rejections a configured `deniedReply` may answer (authorization, not routing). */
const DENIAL_REASONS = new Set([WECOM_IGNORE_REASON.USER_NOT_ALLOWED, WECOM_IGNORE_REASON.CHAT_NOT_ALLOWED]);

/**
 * Every user-visible string of this channel, in one place.
 *
 * Copy rules (rubric §4): one human sentence plus one next step, never an error
 * code, never an internal English word, never a runId. The exact codes stay in
 * the logs (`safeErrorCode`), where an operator can find them.
 */
export const WECOM_REPLIES = Object.freeze({
  stopped: "已停止当前任务。",
  noActiveRun: "当前没有正在执行的任务。",
  cancelled: "任务已取消。",
  timeout: "这次算太久了，我先停掉。要不要换个短点的问法？",
  empty: "这次没生成出内容，再问一次？",
  failure: "刚才没跑通，再试一次？",
  researchUnavailable: "研究入口还没开。先在控制台建个定时任务，结果我会发给你。",
  emptyText: "请把问题写在 @ 我 的同一句话里，例如「@Mira 帮我查一下今天的进度」。",
});

export function isWecomStopCommand(text) {
  if (typeof text !== "string") return false;
  const value = text.trim().toLowerCase();
  return value === WECOM_STOP_COMMAND || value === "停止" || value === "/停止";
}

export function isWecomResearchCommand(text) {
  return typeof text === "string" && text.trim().toLowerCase().startsWith(WECOM_RESEARCH_COMMAND);
}

function safeErrorCode(record) {
  const code = record?.error?.code;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "error";
}

/**
 * @param {object} options
 * @param {(input: object) => Promise<object>} options.runTurn
 * @param {(input: object) => Promise<object>} [options.runResearch]
 * @param {(frame: object, text: string) => Promise<{messageId?: string}>} options.reply
 *   immediate reply inside the callback (bound to that callback's `req_id`)
 * @param {(input: {chatId: string, chatType: "single"|"group", text: string}) => Promise<{errcode?: number}>}
 *   [options.push] proactive `aibot_send_msg` delivery to the same conversation.
 *   Requires `sessions`, because the platform only accepts a push into a
 *   conversation it has already delivered a message from (`93006` otherwise).
 * @param {object} [options.sessions] known-conversation store (`assertDeliverable`)
 * @param {{enabled?: boolean, text?: string}} [options.ack] acknowledgement of the
 *   first phase (`{enabled: true, text: "已收到，正在处理…"}` by default). Only
 *   effective together with `push`
 * @param {{botName?: string, allowedUserIds?: readonly string[], allowedChatIds?: readonly string[]}} [options.policy]
 * @param {string} [options.deniedReply] fixed sentence for a rejected sender
 *   (`user_not_allowed` / `chat_not_allowed`); empty means silence, which is the
 *   default so the allowlist cannot be probed
 * @param {{maxBytes?: number, maxSegments?: number}} [options.segment]
 * @param {object} [options.dedupe]
 * @param {Function} [options.log]
 * @param {Function} [options.onOutcome]
 */
export function createWecomChannel({
  runTurn,
  runResearch,
  reply,
  push,
  sessions,
  ack = {},
  policy = {},
  deniedReply,
  segment = {},
  dedupe = createWecomDedupeStore(),
  log = () => {},
  onOutcome,
} = {}) {
  if (typeof runTurn !== "function") throw new TypeError("createWecomChannel requires runTurn()");
  if (typeof reply !== "function") throw new TypeError("createWecomChannel requires reply()");
  if (push !== undefined && typeof push !== "function") throw new TypeError("createWecomChannel: push must be a function");
  if (typeof push === "function" && typeof sessions?.assertDeliverable !== "function") {
    // Pushing without the registry would rely on the platform alone to reject an
    // unknown conversation; refuse to build such a channel.
    throw new TypeError("createWecomChannel requires a known-session store when push() is wired");
  }

  // Two-phase only makes sense when a push path exists: without it the answer has
  // to come back inside the same callback reply, and acking first would mean two
  // replies competing for one short-lived `req_id`.
  const twoPhase = typeof push === "function" && ack.enabled !== false;
  const ackText =
    typeof ack.text === "string" && ack.text.trim().length > 0 ? ack.text.trim() : WECOM_DEFAULT_ACK_TEXT;
  /**
   * Ack merge window (ms): a chat answer that finishes inside this window sends
   * only the answer. `0` restores "ack every accepted message".
   */
  const ackMergeMs = Number.isFinite(ack.mergeMs) && ack.mergeMs > 0 ? Math.floor(ack.mergeMs) : 0;
  const pushMaxBytes = Math.min(segment.maxBytes ?? WECOM_MAX_CONTENT_BYTES, WECOM_MAX_CONTENT_BYTES);
  /** Chat replies are capped per conversation type (rubric L2/L4): groups never split. */
  const chatSegmentLimits = {
    single: segment.singleMaxSegments ?? WECOM_CHAT_SEGMENT_LIMITS.single,
    group: segment.groupMaxSegments ?? WECOM_CHAT_SEGMENT_LIMITS.group,
  };

  /** @type {Map<string, {items: Function[], running: boolean}>} */
  const queues = new Map();
  /** @type {Map<string, {controller: AbortController, stopped: boolean}>} */
  const activeRuns = new Map();
  /** @type {Map<string, number>} bumped by /stop so queued pre-stop work is dropped */
  const epochs = new Map();
  /** Pending delayed acks: `ackKeyOf(event) -> {timer, startedAt}`. */
  const pendingAckTimers = new Map();
  const idleWaiters = new Set();
  let pending = 0;
  /** Acks in flight: part of `pending` (so shutdown waits) but not a queued run. */
  let pendingAcks = 0;
  let disposed = false;
  let closing = false;

  function begin() {
    pending += 1;
  }

  function end() {
    pending = Math.max(0, pending - 1);
    if (pending === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  }

  function beginAck() {
    pendingAcks += 1;
    begin();
  }

  function endAck() {
    pendingAcks = Math.max(0, pendingAcks - 1);
    end();
  }

  function whenIdle() {
    if (pending === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  function emit(outcome) {
    // Diagnostics never carry raw ids or message text. `runId` is a Cloud Pi
    // identifier (not a credential) and is what lets a message be traced to the
    // run and to the research record.
    log({
      level: "info",
      event: "wecom_channel_outcome",
      channel: "wecom",
      ...outcome,
      messageId: outcome.messageId ? hashId(outcome.messageId) : undefined,
      chatId: outcome.chatId ? hashId(outcome.chatId) : undefined,
      senderUserId: outcome.senderUserId ? hashId(outcome.senderUserId) : undefined,
      replyMessageId: outcome.replyMessageId ? hashId(outcome.replyMessageId) : undefined,
    });
    if (typeof onOutcome !== "function") return;
    try {
      onOutcome(outcome);
    } catch (error) {
      log({ level: "error", event: "wecom_outcome_listener_failed", message: String(error?.message ?? error) });
    }
  }

  function baseOutcome(event) {
    return {
      messageId: event?.messageId,
      chatId: event?.chatId,
      senderUserId: event?.senderUserId,
      chatType: event?.chatType,
    };
  }

  function ignored(event, reason, detail = {}) {
    const outcome = { action: "ignored", reason, ...baseOutcome(event), ...detail };
    emit(outcome);
    return outcome;
  }

  async function safeReply(frame, text) {
    try {
      const result = await reply(frame, text);
      return { ok: true, messageId: result?.messageId, errcode: result?.errcode };
    } catch (error) {
      log({
        level: "error",
        event: "wecom_reply_failed",
        code: String(error?.code ?? error?.name ?? "error"),
      });
      return { ok: false };
    }
  }

  /**
   * The callback's `req_id` is the only handle that can answer *this* message, and
   * it expires. Recording it lets the later push be correlated with the ack that
   * answered the same message, without a second tracing system.
   */
  function requestIdOf(event) {
    const reqId = event?.frame?.headers?.req_id ?? event?.frame?.headers?.reqId;
    return typeof reqId === "string" && reqId.length > 0 ? reqId : undefined;
  }

  /** Ack bookkeeping per inbound message (bounded; entries are consumed below). */
  const ackRecords = new Map();
  const ACK_RECORD_LIMIT = 256;

  function rememberAck(event, record) {
    const key = event?.messageId ?? event?.chatId;
    if (!key) return;
    ackRecords.set(key, record);
    while (ackRecords.size > ACK_RECORD_LIMIT) {
      const oldest = ackRecords.keys().next();
      if (oldest.done) break;
      ackRecords.delete(oldest.value);
    }
  }

  /**
   * Phase 1: acknowledge the callback.
   *
   * The platform's reply handle is bound to the callback and expires long before a
   * real model or research run finishes, so a slow answer cannot wait for the run.
   * Fired without awaiting: the run must not queue behind the network round-trip,
   * and `whenIdle()` still counts it.
   *
   * Whether an ack is sent at all is a product decision (rubric §3 A3a/A3b): a
   * short question should get exactly one message, not "收到" plus the answer. Two
   * triggers, both explicit:
   *  - `immediate: true` for a long-task intent (a `/research` command), which is
   *    known to be slow before the model runs;
   *  - otherwise the ack is delayed by `ackMergeMs` and only sent if the answer has
   *    not been delivered by then (`cancelPendingAck` below).
   */
  function fireAck(event, startedAt = Date.now()) {
    beginAck();
    void safeReply(event.frame, ackText)
      .then((sent) => {
        const ackMs = Date.now() - startedAt;
        rememberAck(event, { ackMs, ok: sent.ok, handle: sent.messageId });
        emit({
          action: sent.ok ? "acked" : "ack_failed",
          phase: "ack",
          requestId: requestIdOf(event),
          ackMs,
          ackTextBytes: byteLength(ackText),
          replyDelivered: sent.ok,
          replyMessageId: sent.messageId,
          platformErrcode: sent.errcode,
          ...baseOutcome(event),
        });
      })
      .finally(endAck);
  }

  function ackKeyOf(event) {
    return event?.messageId ?? event?.chatId;
  }

  function sendAck(event, { immediate = false } = {}) {
    if (!twoPhase) return;
    if (immediate || ackMergeMs <= 0) {
      fireAck(event);
      return;
    }
    const key = ackKeyOf(event);
    if (key === undefined) {
      fireAck(event);
      return;
    }
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      pendingAckTimers.delete(key);
      fireAck(event, startedAt);
    }, ackMergeMs);
    if (typeof timer.unref === "function") timer.unref();
    pendingAckTimers.set(key, { timer, startedAt, chatId: event.chatId });
  }

  /**
   * Drop every ack still waiting in `chatId`'s merge window.
   *
   * Used when the conversation stops the work (`/stop`, shutdown): an ack that
   * arrives after "已停止当前任务。" would be a second, contradictory message.
   */
  function cancelAcksForChat(chatId, reason) {
    if (chatId === undefined) return 0;
    let cancelled = 0;
    for (const [key, pendingAck] of pendingAckTimers) {
      if (pendingAck.chatId !== chatId) continue;
      clearTimeout(pendingAck.timer);
      pendingAckTimers.delete(key);
      cancelled += 1;
    }
    if (cancelled > 0) {
      emit({
        action: "ack_suppressed",
        phase: "ack",
        reason,
        mergeMs: ackMergeMs,
        chatIdHash: hashId(chatId),
      });
    }
    return cancelled;
  }

  /**
   * The answer arrived inside the merge window: the user gets one message, not an
   * ack plus the answer.
   *
   * @returns {boolean} true when a still-pending ack was cancelled
   */
  function cancelPendingAck(event, { durationMs } = {}) {
    const key = ackKeyOf(event);
    if (key === undefined) return false;
    const pendingAck = pendingAckTimers.get(key);
    if (!pendingAck) return false;
    clearTimeout(pendingAck.timer);
    pendingAckTimers.delete(key);
    emit({
      action: "ack_suppressed",
      phase: "ack",
      reason: "answered_within_merge_window",
      mergeMs: ackMergeMs,
      durationMs,
      ...baseOutcome(event),
    });
    return true;
  }

  /** Answer a message that carries no question (for example a bare `@Mira`). */
  function sendHint(event, text) {
    const startedAt = Date.now();
    beginAck();
    void safeReply(event.frame, text)
      .then((sent) => {
        emit({
          action: sent.ok ? "replied" : "failed",
          phase: "hint",
          reason: "empty_text",
          requestId: requestIdOf(event),
          durationMs: Date.now() - startedAt,
          replyDelivered: sent.ok,
          replyMessageId: sent.messageId,
          platformErrcode: sent.errcode,
          ...baseOutcome(event),
        });
      })
      .finally(endAck);
  }

  function pushErrorCode(error) {
    const code = typeof error?.code === "string" ? error.code : "push_failed";
    return code === "content_too_large" ? "segment_too_large" : code;
  }

  function pushPlatformCode(error) {
    if (typeof error?.platformCode === "number") return error.platformCode;
    if (error?.code === "content_too_large") return WECOM_PLATFORM_ERROR.PAYLOAD_TOO_LARGE;
    return undefined;
  }

  /**
   * Phase 2: push the finished answer with `aibot_send_msg`.
   *
   * The target is only ever the conversation this callback came from, and the
   * known-session store must agree: a target assembled from thin air (or from a
   * model output) would be refused by the platform with `93006` anyway, so it is
   * refused here with the same meaning and an explicit reason.
   */
  async function pushSegments(event, text) {
    const { segments, truncated } = splitForSend(text, {
      ...segment,
      maxBytes: pushMaxBytes,
      maxSegments: chatSegmentLimits[event.chatType] ?? chatSegmentLimits.single,
    });
    const verdict = sessions.assertDeliverable({ chatId: event.chatId, chatType: event.chatType });
    if (!verdict.deliverable) {
      return {
        delivered: 0,
        total: segments.length,
        truncated,
        error: verdict.reason,
        platformCode: verdict.platformCode,
      };
    }
    let delivered = 0;
    let errcode;
    for (const part of segments) {
      // `splitForSend` is byte-budgeted; this is the second, explicit guard for the
      // platform limit so an oversized segment is a typed failure (40058) rather
      // than a transport surprise.
      const bytes = byteLength(part);
      if (bytes > WECOM_MAX_CONTENT_BYTES) {
        return {
          delivered,
          total: segments.length,
          truncated,
          error: "segment_too_large",
          platformCode: WECOM_PLATFORM_ERROR.PAYLOAD_TOO_LARGE,
          oversizedBytes: bytes,
        };
      }
      try {
        const acked = await push({ chatId: event.chatId, chatType: event.chatType, text: part });
        delivered += 1;
        if (typeof acked?.errcode === "number") errcode = acked.errcode;
      } catch (error) {
        return {
          delivered,
          total: segments.length,
          truncated,
          error: pushErrorCode(error),
          platformCode: pushPlatformCode(error),
          errcode,
        };
      }
    }
    return { delivered, total: segments.length, truncated, errcode };
  }

  /** The answer leaves through the push path when wired, otherwise as a reply. */
  async function deliver(event, text) {
    if (typeof push === "function") return await pushSegments(event, text);
    return await sendSegments(event, text);
  }

  function deliveryFields(sent) {
    const failed = sent.error !== undefined;
    return {
      action: failed ? "failed" : "replied",
      phase: "final",
      delivery: typeof push === "function" ? "push" : "reply",
      reason: failed ? sent.error : undefined,
      ...(sent.platformCode !== undefined ? { platformCode: sent.platformCode } : {}),
      segments: sent.total,
      segmentsDelivered: sent.delivered,
      truncated: sent.truncated || undefined,
      replyDelivered: sent.delivered > 0,
      replyMessageId: sent.replyMessageId,
      platformErrcode: sent.errcode,
    };
  }

  function enqueue(chatId, task) {
    let queue = queues.get(chatId);
    if (!queue) {
      queue = { items: [], running: false };
      queues.set(chatId, queue);
    }
    queue.items.push(task);
    begin();
    if (!queue.running) void drain(chatId, queue);
  }

  function dropQueued(queue) {
    while (queue.items.length > 0) {
      queue.items.pop();
      end();
    }
  }

  async function drain(chatId, queue) {
    queue.running = true;
    try {
      while (queue.items.length > 0) {
        const task = queue.items.shift();
        try {
          await task();
        } catch (error) {
          log({ level: "error", event: "wecom_task_failed", message: String(error?.message ?? error) });
        } finally {
          end();
        }
      }
    } finally {
      queue.running = false;
      if (queue.items.length === 0) queues.delete(chatId);
    }
  }

  async function sendSegments(event, text) {
    const { segments, truncated } = splitForSend(text, {
      ...segment,
      maxSegments: chatSegmentLimits[event.chatType] ?? chatSegmentLimits.single,
    });
    let delivered = 0;
    let replyMessageId;
    let errcode;
    for (const part of segments) {
      const sent = await safeReply(event.frame, part);
      if (!sent.ok) break;
      delivered += 1;
      replyMessageId = sent.messageId ?? replyMessageId;
      errcode = typeof sent.errcode === "number" ? sent.errcode : errcode;
    }
    return { delivered, total: segments.length, truncated, replyMessageId, errcode };
  }

  /**
   * The user-visible answer.
   *
   * Copy never carries an internal code (rubric §4/E5): the code goes to the log
   * through `wecom_turn_failed`, the user gets one sentence and a next step.
   */
  function buildReplyText(record) {
    const status = typeof record?.status === "string" ? record.status : "failed";
    if (status === "succeeded") {
      const answer = typeof record?.text === "string" ? record.text.trim() : "";
      return answer.length > 0 ? answer : WECOM_REPLIES.empty;
    }
    if (status === "cancelled") return WECOM_REPLIES.cancelled;
    if (status === "timeout") return WECOM_REPLIES.timeout;
    return WECOM_REPLIES.failure;
  }

  /** Token accounting projection: numbers only, no prompt or credential material. */
  function usageOf(record) {
    const usage = record?.usage;
    if (!usage || typeof usage !== "object") return undefined;
    const pick = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    return Object.freeze({
      input: pick(usage.input),
      output: pick(usage.output),
      total: pick(usage.total),
    });
  }

  async function runOne(event, kind, routeText, epoch) {
    const controller = new AbortController();
    const state = { controller, stopped: false };
    activeRuns.set(event.chatId, state);
    const started = Date.now();
    try {
      if (signalAborted(controller)) return ignored(event, "stopped_before_start");
      await taskYield();
      if ((epochs.get(event.chatId) ?? 0) !== epoch) {
        // A /stop arrived after this message was queued; it must never run.
        return ignored(event, "stopped_before_start");
      }

      let record;
      if (kind === "research") {
        if (typeof runResearch !== "function") {
          cancelPendingAck(event, { durationMs: Date.now() - started });
          const sent = await deliver(event, WECOM_REPLIES.researchUnavailable);
          return emit({ kind, status: "unavailable", ...deliveryFields(sent), ...baseOutcome(event) });
        }
        record = await runResearch({
          topic: routeText,
          chatId: event.chatId,
          chatType: event.chatType,
          messageId: event.messageId,
          senderUserId: event.senderUserId,
          signal: controller.signal,
        });
      } else {
        record = await runTurn({
          text: routeText,
          chatId: event.chatId,
          chatType: event.chatType,
          messageId: event.messageId,
          senderUserId: event.senderUserId,
          signal: controller.signal,
        });
      }

      if (state.stopped) {
        // /stop already replied; the aborted run must not send a second message.
        return emit({
          action: "cancelled",
          reason: "stop_command",
          status: "cancelled",
          ...baseOutcome(event),
        });
      }

      const text = buildReplyText(record);
      const failedStatus = typeof record?.status === "string" && record.status !== "succeeded";
      if (failedStatus) {
        // The user-visible copy never carries the code; the log must, or a failure
        // becomes unreportable.
        log({
          level: "warn",
          event: "wecom_turn_failed",
          kind,
          status: record.status,
          code: safeErrorCode(record),
          chatType: event.chatType,
        });
      }
      if (typeof record?.promptVersion === "string") {
        log({ level: "info", event: "wecom_prompt_selected", chatType: event.chatType, promptVersion: record.promptVersion });
      }
      // D7: the runId is a trace identifier, not conversation content. It stays in
      // the outcome/run record and never in the message the user reads.
      const answer = text;
      // A model that could not use a tool sometimes writes the invocation syntax as
      // prose. It must never reach the user: replace it with a human sentence and
      // record the turn as failed, so the run trace matches what the user saw.
      const { text: outbound, leaked } = sanitizeModelReply(answer);
      if (leaked) {
        log({ level: "warn", event: "wecom_reply_pseudo_tool_text", action: "replaced" });
      }
      // The answer is ready: if the ack is still inside its merge window, cancel it
      // so a short question gets one message instead of "收到" plus the answer.
      cancelPendingAck(event, { durationMs: Date.now() - started });
      const sent = await deliver(event, outbound);
      const ackInfo = event.messageId ? ackRecords.get(event.messageId) : undefined;
      if (event.messageId) ackRecords.delete(event.messageId);
      if (leaked) {
        return emit({
          ...deliveryFields(sent),
          action: "failed",
          reason: "pseudo_tool_text",
          status: "failed",
          kind,
          runId: typeof record?.runId === "string" ? record.runId : undefined,
          durationMs: Date.now() - started,
          // Two-phase correlation: the same `requestId` and the ack seen for this
          // inbound message, so evidence can join ack and final.
          requestId: requestIdOf(event),
          ackMs: ackInfo?.ackMs,
          ackDelivered: ackInfo?.ok,
          ...baseOutcome(event),
        });
      }
      return emit({
        kind,
        status: typeof record?.status === "string" ? record.status : "failed",
        runId: typeof record?.runId === "string" ? record.runId : undefined,
        // Which prompt version produced this turn (`wecom-single-v2` /
        // `wecom-group-v2`); the prompt text itself is never logged.
        promptVersion: typeof record?.promptVersion === "string" ? record.promptVersion : undefined,
        // Token accounting only: never the prompt, the provider credentials or the
        // rendered system prompt.
        usage: usageOf(record),
        durationMs: Date.now() - started,
        // Two-phase correlation: the same `requestId` and the ack seen for this
        // inbound message, so evidence can join ack and final.
        requestId: requestIdOf(event),
        ackMs: ackInfo?.ackMs,
        ackDelivered: ackInfo?.ok,
        ...deliveryFields(sent),
        ...baseOutcome(event),
      });
    } catch (error) {
      if (state.stopped) {
        return emit({ action: "cancelled", reason: "stop_command", status: "cancelled", ...baseOutcome(event) });
      }
      log({ level: "error", event: "wecom_run_failed", code: String(error?.code ?? error?.name ?? "error") });
      cancelPendingAck(event, { durationMs: Date.now() - started });
      const sent = await deliver(event, WECOM_REPLIES.failure);
      return emit({
        action: "failed",
        reason: "run_error",
        phase: "final",
        delivery: typeof push === "function" ? "push" : "reply",
        status: "failed",
        requestId: requestIdOf(event),
        replyDelivered: sent.delivered > 0,
        platformErrcode: sent.errcode,
        ...(sent.platformCode !== undefined ? { platformCode: sent.platformCode } : {}),
        ...baseOutcome(event),
      });
    } finally {
      if (activeRuns.get(event.chatId) === state) activeRuns.delete(event.chatId);
    }
  }

  function handleStop(event) {
    const active = activeRuns.get(event.chatId);
    epochs.set(event.chatId, (epochs.get(event.chatId) ?? 0) + 1);
    const queued = queues.get(event.chatId);
    if (queued) dropQueued(queued);
    // A pending ack for the stopped message must not arrive after the stop reply.
    cancelAcksForChat(event.chatId, "stopped_before_answer");
    if (active) {
      active.stopped = true;
      active.controller.abort();
    }
    const outcome = {
      action: active ? "stopped" : "stop_noop",
      status: active ? "cancelled" : undefined,
      reason: active ? "stop_command" : "no_active_run",
      ...baseOutcome(event),
    };
    begin();
    void safeReply(event.frame, active ? WECOM_REPLIES.stopped : WECOM_REPLIES.noActiveRun)
      .then((sent) => {
        outcome.replyMessageId = sent.messageId;
        outcome.replyDelivered = sent.ok;
        emit(outcome);
      })
      .finally(end);
    return outcome;
  }

  /**
   * Handle one raw callback frame. Returns the immediate routing decision; the
   * run itself completes asynchronously and is reported through `onOutcome`.
   * The transport must not await model work on the connection's receive path.
   */
  function handleEvent(rawPayload) {
    if (disposed || closing) {
      const reason = disposed ? "channel_disposed" : "channel_closing";
      const outcome = { action: "ignored", reason };
      emit(outcome);
      return outcome;
    }

    const event = normalizeWecomMessageEvent(rawPayload);
    if (!event) return ignored(null, "invalid_event");

    const route = decideWecomRoute(event, policy);
    if (!route.allowed) {
      // A bare mention (`@Mira`) carries no question. Answering it is better than
      // swallowing the message: the user gets a hint in the same conversation.
      if (route.reason === "empty_text") sendHint(event, WECOM_REPLIES.emptyText);
      // A rejected sender gets no model run and no tool call. By default they get
      // no reply either, so the allowlist cannot be probed; a deployment may set
      // one fixed sentence instead.
      const denial = DENIAL_REASONS.has(route.reason);
      const denyText = typeof deniedReply === "string" ? deniedReply.trim() : "";
      if (denial && denyText.length > 0) {
        void safeReply(event.frame, denyText).then((sent) => {
          log({
            level: "info",
            event: "wecom_denied_reply",
            reason: route.reason,
            senderUserId: event.senderUserId ? hashId(event.senderUserId) : undefined,
            chatId: event.chatId ? hashId(event.chatId) : undefined,
            delivered: sent.ok === true,
          });
        });
      }
      return ignored(event, route.reason, {
        routing: route.kind,
        replied: route.reason === "empty_text" || (denial && denyText.length > 0),
      });
    }

    if (!event.dedupeKey) return ignored(event, "missing_dedupe_key");
    if (!dedupe.reserve(event.dedupeKey)) return ignored(event, "duplicate_event");

    if (isWecomStopCommand(route.text)) return handleStop(event);

    const kind = isWecomResearchCommand(route.text) ? "research" : "chat";
    const routeText =
      kind === "research" ? route.text.slice(WECOM_RESEARCH_COMMAND.length).trim() : route.text;
    if (kind === "research" && routeText.length === 0) return ignored(event, "empty_research_topic");

    const epoch = epochs.get(event.chatId) ?? 0;
    emit({ action: "accepted", kind, ...baseOutcome(event) });
    // Phase 1 happens here, on the receive path, before the model is called: the
    // callback's reply handle is short-lived and the run may take minutes. A
    // `/research` command is a long task by construction, so it acks at once; a
    // chat message only acks if it outlives the merge window.
    sendAck(event, { immediate: kind === "research" });
    enqueue(event.chatId, () => runOne(event, kind, routeText, epoch));
    return {
      action: "accepted",
      kind,
      acked: twoPhase,
      messageId: event.messageId,
      chatId: event.chatId,
      chatType: event.chatType,
      requestId: requestIdOf(event),
    };
  }

  async function stopAll({ timeoutMs = 5_000 } = {}) {
    if (closing) return false;
    closing = true;
    for (const [chatId, state] of activeRuns) {
      state.stopped = true;
      state.controller.abort();
      epochs.set(chatId, (epochs.get(chatId) ?? 0) + 1);
    }
    for (const queue of queues.values()) dropQueued(queue);
    if (pending === 0) return true;
    let timer;
    const drained = await Promise.race([
      whenIdle().then(() => true),
      new Promise((resolve) => {
        // Not unref'd: shutdown must observe the bounded drain rather than exit
        // while a run is still unwinding.
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return drained;
  }

  return {
    handleEvent,
    whenIdle,
    stopAll,
    async dispose(options) {
      await stopAll(options);
      disposed = true;
      // A delayed ack that never fires would otherwise keep a timer alive after
      // shutdown; cancel them all (the run that would have cancelled them is gone).
      for (const { timer } of pendingAckTimers.values()) clearTimeout(timer);
      pendingAckTimers.clear();
    },
    get activeRunCount() {
      return activeRuns.size;
    },
    get pendingCount() {
      // Queued or running turns; in-flight acks are reported separately so an ack
      // never looks like a stuck run.
      return pending - pendingAcks;
    },
    get pendingAckCount() {
      return pendingAcks;
    },
    get dedupeSize() {
      return dedupe.size;
    },
  };
}

function signalAborted(controller) {
  return controller.signal.aborted;
}

async function taskYield() {
  await Promise.resolve();
}
