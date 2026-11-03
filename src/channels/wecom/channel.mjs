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
import { byteLength, splitForSend } from "./text.mjs";

export const WECOM_STOP_COMMAND = "/stop";
export const WECOM_RESEARCH_COMMAND = "/research";

/** Rejections a configured `deniedReply` may answer (authorization, not routing). */
const DENIAL_REASONS = new Set([WECOM_IGNORE_REASON.USER_NOT_ALLOWED, WECOM_IGNORE_REASON.CHAT_NOT_ALLOWED]);

export const WECOM_REPLIES = Object.freeze({
  stopped: "已停止当前任务。",
  noActiveRun: "当前没有正在执行的任务。",
  cancelled: "任务已取消。",
  timeout: "处理超时，请稍后重试。",
  empty: "（模型没有返回内容）",
  failure: "处理失败，请稍后重试。",
  researchUnavailable: "研究功能未启用。",
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
  const pushMaxBytes = Math.min(segment.maxBytes ?? WECOM_MAX_CONTENT_BYTES, WECOM_MAX_CONTENT_BYTES);

  /** @type {Map<string, {items: Function[], running: boolean}>} */
  const queues = new Map();
  /** @type {Map<string, {controller: AbortController, stopped: boolean}>} */
  const activeRuns = new Map();
  /** @type {Map<string, number>} bumped by /stop so queued pre-stop work is dropped */
  const epochs = new Map();
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
   * Phase 1: acknowledge the callback immediately.
   *
   * The platform's reply handle is bound to the callback and expires long before a
   * real model or research run finishes, so `/research` and slow answers cannot
   * wait for the run. Fired without awaiting: the run must not queue behind the
   * network round-trip, and `whenIdle()` still counts it.
   */
  function sendAck(event) {
    if (!twoPhase) return;
    const startedAt = Date.now();
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
    const { segments, truncated } = splitForSend(text, { ...segment, maxBytes: pushMaxBytes });
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
    return await sendSegments(event.frame, text);
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

  async function sendSegments(frame, text) {
    const { segments, truncated } = splitForSend(text, segment);
    let delivered = 0;
    let replyMessageId;
    let errcode;
    for (const part of segments) {
      const sent = await safeReply(frame, part);
      if (!sent.ok) break;
      delivered += 1;
      replyMessageId = sent.messageId ?? replyMessageId;
      errcode = typeof sent.errcode === "number" ? sent.errcode : errcode;
    }
    return { delivered, total: segments.length, truncated, replyMessageId, errcode };
  }

  function buildReplyText(record) {
    const status = typeof record?.status === "string" ? record.status : "failed";
    if (status === "succeeded") {
      const answer = typeof record?.text === "string" ? record.text.trim() : "";
      return answer.length > 0 ? answer : WECOM_REPLIES.empty;
    }
    if (status === "cancelled") return WECOM_REPLIES.cancelled;
    if (status === "timeout") return WECOM_REPLIES.timeout;
    return `${WECOM_REPLIES.failure}（${safeErrorCode(record)}）`;
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
      // A research run must be identifiable in the conversation: the reply
      // carries its runId so the chat message, the run record and the report can
      // be correlated without a new tracing system.
      const answer =
        kind === "research" && typeof record?.runId === "string" && record.runId.length > 0
          ? `${text}\n\nrunId: ${record.runId}`
          : text;
      const sent = await deliver(event, answer);
      const ackInfo = event.messageId ? ackRecords.get(event.messageId) : undefined;
      if (event.messageId) ackRecords.delete(event.messageId);
      return emit({
        kind,
        status: typeof record?.status === "string" ? record.status : "failed",
        runId: typeof record?.runId === "string" ? record.runId : undefined,
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
    // callback's reply handle is short-lived and the run may take minutes.
    sendAck(event);
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
