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
import { hashId } from "./config.mjs";
import { createWecomDedupeStore } from "./dedupe.mjs";
import { normalizeWecomMessageEvent } from "./events.mjs";
import { decideWecomRoute } from "./policy.mjs";
import { splitForSend } from "./text.mjs";
import { sanitizeModelReply } from "../../redaction.mjs";

export const WECOM_STOP_COMMAND = "/stop";
export const WECOM_RESEARCH_COMMAND = "/research";

export const WECOM_REPLIES = Object.freeze({
  stopped: "已停止当前任务。",
  noActiveRun: "当前没有正在执行的任务。",
  cancelled: "任务已取消。",
  timeout: "处理超时，请稍后重试。",
  empty: "（模型没有返回内容）",
  failure: "处理失败，请稍后重试。",
  researchUnavailable: "研究功能未启用。",
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
 * @param {{botName?: string, allowedUserIds?: readonly string[], allowedChatIds?: readonly string[]}} [options.policy]
 * @param {{maxBytes?: number, maxSegments?: number}} [options.segment]
 * @param {object} [options.dedupe]
 * @param {Function} [options.log]
 * @param {Function} [options.onOutcome]
 */
export function createWecomChannel({
  runTurn,
  runResearch,
  reply,
  policy = {},
  segment = {},
  dedupe = createWecomDedupeStore(),
  log = () => {},
  onOutcome,
} = {}) {
  if (typeof runTurn !== "function") throw new TypeError("createWecomChannel requires runTurn()");
  if (typeof reply !== "function") throw new TypeError("createWecomChannel requires reply()");

  /** @type {Map<string, {items: Function[], running: boolean}>} */
  const queues = new Map();
  /** @type {Map<string, {controller: AbortController, stopped: boolean}>} */
  const activeRuns = new Map();
  /** @type {Map<string, number>} bumped by /stop so queued pre-stop work is dropped */
  const epochs = new Map();
  const idleWaiters = new Set();
  let pending = 0;
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
          await safeReply(event.frame, WECOM_REPLIES.researchUnavailable);
          return emit({ action: "replied", kind, status: "unavailable", ...baseOutcome(event) });
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
      // A model that could not use a tool sometimes writes the invocation syntax as
      // prose. It must never reach the user: replace it with a human sentence and
      // record the turn as failed, so the run trace matches what the user saw.
      const { text: outbound, leaked } = sanitizeModelReply(answer);
      if (leaked) {
        log({ level: "warn", event: "wecom_reply_pseudo_tool_text", action: "replaced" });
      }
      const sent = await sendSegments(event.frame, outbound);
      if (leaked) {
        return emit({
          action: "failed",
          reason: "pseudo_tool_text",
          phase: "final",
          kind,
          status: "failed",
          runId: typeof record?.runId === "string" ? record.runId : undefined,
          durationMs: Date.now() - started,
          segments: sent.total,
          segmentsDelivered: sent.delivered,
          replyDelivered: sent.delivered > 0,
          replyMessageId: sent.replyMessageId,
          platformErrcode: sent.errcode,
          ...baseOutcome(event),
        });
      }
      return emit({
        action: "replied",
        kind,
        status: typeof record?.status === "string" ? record.status : "failed",
        runId: typeof record?.runId === "string" ? record.runId : undefined,
        // Token accounting only: never the prompt, the provider credentials or the
        // rendered system prompt.
        usage: usageOf(record),
        durationMs: Date.now() - started,
        segments: sent.total,
        segmentsDelivered: sent.delivered,
        truncated: sent.truncated || undefined,
        replyDelivered: sent.delivered > 0,
        replyMessageId: sent.replyMessageId,
        // Platform acknowledgement code of the last accepted segment (0 = ok).
        platformErrcode: sent.errcode,
        ...baseOutcome(event),
      });
    } catch (error) {
      if (state.stopped) {
        return emit({ action: "cancelled", reason: "stop_command", status: "cancelled", ...baseOutcome(event) });
      }
      log({ level: "error", event: "wecom_run_failed", code: String(error?.code ?? error?.name ?? "error") });
      await safeReply(event.frame, WECOM_REPLIES.failure);
      return emit({ action: "failed", reason: "run_error", status: "failed", ...baseOutcome(event) });
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
    if (!route.allowed) return ignored(event, route.reason, { routing: route.kind });

    if (!event.dedupeKey) return ignored(event, "missing_dedupe_key");
    if (!dedupe.reserve(event.dedupeKey)) return ignored(event, "duplicate_event");

    if (isWecomStopCommand(route.text)) return handleStop(event);

    const kind = isWecomResearchCommand(route.text) ? "research" : "chat";
    const routeText =
      kind === "research" ? route.text.slice(WECOM_RESEARCH_COMMAND.length).trim() : route.text;
    if (kind === "research" && routeText.length === 0) return ignored(event, "empty_research_topic");

    const epoch = epochs.get(event.chatId) ?? 0;
    emit({ action: "accepted", kind, ...baseOutcome(event) });
    enqueue(event.chatId, () => runOne(event, kind, routeText, epoch));
    return {
      action: "accepted",
      kind,
      messageId: event.messageId,
      chatId: event.chatId,
      chatType: event.chatType,
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
      return pending;
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
