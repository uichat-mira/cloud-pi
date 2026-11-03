/**
 * The Feishu channel adapter.
 *
 * One inbound Feishu message that passes routing policy becomes exactly one
 * `runTurn` call (which the host wires to `createAgentRuntime().run()`); the
 * run's answer is replied to the original message. The adapter owns no model,
 * session or tool, so it cannot become a second Agent Runtime.
 *
 * Guarantees this module enforces:
 *  - routing is decided before any run (private / authorized group @ / ignore);
 *  - a dedupe key is reserved before the async run starts, so redelivery and
 *    concurrent duplicates produce one run;
 *  - runs for one chat are serialized; `/stop` aborts the active run's
 *    AbortSignal immediately and queued pre-stop messages are dropped;
 *  - runtime failures and reply failures are reported, never swallowed.
 */
import { createDedupeStore } from "./dedupe.mjs";
import { normalizeFeishuMessageEvent, readFeishuEventType } from "./events.mjs";
import { decideFeishuRoute } from "./policy.mjs";
import { maskId } from "./config.mjs";

export const STOP_COMMANDS = Object.freeze(new Set(["/stop", "/cancel", "停止", "取消"]));

export const CHANNEL_REPLIES = Object.freeze({
  stopped: "已停止当前任务。",
  noActiveRun: "当前没有正在运行的任务。",
  empty: "Mira 没有生成可发送的回复。",
  cancelled: "处理已取消。",
  timeout: "处理超时，请稍后重试。",
});

const MAX_REPLY_CODE_LENGTH = 40;

function isStopCommand(text) {
  return STOP_COMMANDS.has(text.trim().toLowerCase()) || STOP_COMMANDS.has(text.trim());
}

function safeErrorCode(record) {
  const code = record?.error?.code;
  if (typeof code === "string" && /^[a-z0-9_]{1,40}$/i.test(code)) return code.slice(0, MAX_REPLY_CODE_LENGTH);
  return "unknown";
}

function maskMessageId(value) {
  return maskId(value, { head: 6, tail: 4 });
}

/**
 * @param {object} options
 * @param {Iterable<string>|Set<string>} [options.allowedChatIds] trusted POC group allowlist
 * @param {string|Function} [options.botOpenId] verified bot open id, or a getter
 * @param {Function} options.runTurn async ({text, chatId, chatType, messageId, signal}) => run record
 * @param {Function} options.reply async (messageId, text) => {messageId?}
 * @param {object} [options.dedupe] dedupe store (tests/injection)
 * @param {Function} [options.onOutcome] observes every decision/outcome (no message text)
 * @param {Function} [options.log] structured diagnostic sink
 */
export function createFeishuChannel({
  allowedChatIds = [],
  botOpenId,
  runTurn,
  reply,
  dedupe = createDedupeStore(),
  onOutcome,
  log = () => {},
} = {}) {
  if (typeof runTurn !== "function") throw new TypeError("createFeishuChannel requires runTurn()");
  if (typeof reply !== "function") throw new TypeError("createFeishuChannel requires reply()");

  const policy = {
    allowedChatIds: allowedChatIds instanceof Set ? allowedChatIds : new Set(allowedChatIds),
    get botOpenId() {
      return typeof botOpenId === "function" ? botOpenId() : botOpenId;
    },
  };

  /** @type {Map<string, {items: Function[], running: boolean}>} */
  const queues = new Map();
  /** @type {Map<string, {controller: AbortController, stopped: boolean}>} */
  const activeRuns = new Map();
  /** @type {Map<string, number>} bumped by /stop so queued pre-stop work is dropped */
  const epochs = new Map();

  let pending = 0;
  let closing = false;
  let disposed = false;
  const idleWaiters = new Set();

  function begin() {
    pending += 1;
  }

  function end() {
    if (pending > 0) pending -= 1;
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
    // Diagnostics never carry full Feishu ids or message text.
    log({
      level: "info",
      event: "feishu_channel_outcome",
      ...outcome,
      eventId: outcome.eventId ? maskId(outcome.eventId) : undefined,
      messageId: outcome.messageId ? maskMessageId(outcome.messageId) : undefined,
      chatId: outcome.chatId ? maskMessageId(outcome.chatId) : undefined,
      replyMessageId: outcome.replyMessageId ? maskMessageId(outcome.replyMessageId) : undefined,
    });
    if (typeof onOutcome !== "function") return;
    try {
      onOutcome(outcome);
    } catch (error) {
      log({
        level: "error",
        event: "feishu_outcome_listener_failed",
        message: String(error?.message ?? error),
      });
    }
  }

  function baseOutcome(event) {
    return {
      eventId: event?.eventId,
      messageId: event?.messageId,
      chatId: event?.chatId,
      chatType: event?.chatType,
    };
  }

  function ignored(event, reason, detail = {}) {
    const outcome = { action: "ignored", reason, ...baseOutcome(event), ...detail };
    emit(outcome);
    return outcome;
  }

  async function safeReply(messageId, text) {
    try {
      const result = await reply(messageId, text);
      return { ok: true, messageId: result?.messageId };
    } catch (error) {
      log({
        level: "error",
        event: "feishu_reply_failed",
        messageId: maskMessageId(messageId),
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

  async function drain(chatId, queue) {
    queue.running = true;
    while (queue.items.length > 0) {
      const task = queue.items.shift();
      try {
        await task();
      } catch (error) {
        log({
          level: "error",
          event: "feishu_channel_task_failed",
          chatId: maskMessageId(chatId),
          message: String(error?.message ?? error),
        });
      } finally {
        end();
      }
    }
    queue.running = false;
    if (queues.get(chatId) === queue) queues.delete(chatId);
  }

  async function runMessage(event, epoch) {
    if (disposed) return ignored(event, "channel_disposed");
    if ((epochs.get(event.chatId) ?? 0) !== epoch) {
      // A /stop arrived after this message was queued; it must never run.
      return ignored(event, "stopped_before_start");
    }

    const controller = new AbortController();
    const state = { controller, stopped: false };
    activeRuns.set(event.chatId, state);

    let record;
    try {
      record = await runTurn({
        text: event.text,
        chatId: event.chatId,
        chatType: event.chatType,
        messageId: event.messageId,
        eventId: event.eventId,
        senderOpenId: event.senderOpenId,
        signal: controller.signal,
      });
    } catch (error) {
      log({
        level: "error",
        event: "feishu_run_turn_failed",
        messageId: maskMessageId(event.messageId),
        message: String(error?.message ?? error),
      });
      record = { status: "failed", text: "", error: { code: "channel_error" } };
    } finally {
      if (activeRuns.get(event.chatId) === state) activeRuns.delete(event.chatId);
    }

    const status = typeof record?.status === "string" ? record.status : "failed";

    if (state.stopped) {
      // /stop already replied. The aborted run must not send a second message.
      const outcome = {
        action: "cancelled",
        reason: "stop_command",
        status: "cancelled",
        runId: typeof record?.runId === "string" ? record.runId : undefined,
        ...baseOutcome(event),
      };
      emit(outcome);
      return outcome;
    }

    let replyText;
    if (status === "succeeded") {
      const answer = typeof record?.text === "string" ? record.text.trim() : "";
      replyText = answer.length > 0 ? answer : CHANNEL_REPLIES.empty;
    } else if (status === "cancelled") {
      replyText = CHANNEL_REPLIES.cancelled;
    } else if (status === "timeout") {
      replyText = CHANNEL_REPLIES.timeout;
    } else {
      replyText = `Mira 处理失败（${safeErrorCode(record)}），请稍后重试。`;
    }

    const sent = await safeReply(event.messageId, replyText);
    const outcome = {
      action: status === "succeeded" ? "replied" : status === "cancelled" ? "cancelled" : "failed",
      status,
      runId: typeof record?.runId === "string" ? record.runId : undefined,
      modelId: typeof record?.model?.modelId === "string" ? record.model.modelId : undefined,
      durationMs: Number.isFinite(record?.durationMs) ? record.durationMs : undefined,
      usage: record?.usage
        ? {
            input: Number.isFinite(record.usage.input) ? record.usage.input : undefined,
            output: Number.isFinite(record.usage.output) ? record.usage.output : undefined,
            total: Number.isFinite(record.usage.total) ? record.usage.total : undefined,
          }
        : undefined,
      errorCode: status === "succeeded" ? undefined : safeErrorCode(record),
      replyMessageId: sent.messageId,
      replyDelivered: sent.ok,
      ...baseOutcome(event),
    };
    emit(outcome);
    return outcome;
  }

  function handleStop(event) {
    const active = activeRuns.get(event.chatId);
    epochs.set(event.chatId, (epochs.get(event.chatId) ?? 0) + 1);
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
    void safeReply(event.messageId, active ? CHANNEL_REPLIES.stopped : CHANNEL_REPLIES.noActiveRun)
      .then((sent) => {
        outcome.replyMessageId = sent.messageId;
        outcome.replyDelivered = sent.ok;
        emit(outcome);
      })
      .finally(end);
    return outcome;
  }

  /**
   * Handle one raw Feishu event. Returns the immediate routing decision; the run
   * itself completes asynchronously and is reported through `onOutcome`.
   * Use `whenIdle()` to await accepted work in tests and shutdown.
   */
  function handleEvent(rawPayload) {
    if (disposed || closing) {
      const reason = disposed ? "channel_disposed" : "channel_closing";
      const outcome = { action: "ignored", reason };
      emit(outcome);
      return outcome;
    }

    const event = normalizeFeishuMessageEvent(rawPayload);
    if (!event) {
      const type = readFeishuEventType(rawPayload);
      const outcome = { action: "ignored", reason: type ? "unsupported_event" : "invalid_event" };
      emit(outcome);
      return outcome;
    }

    const route = decideFeishuRoute(event, policy);
    if (!route.allowed) return ignored(event, route.reason, { routing: route.kind });

    if (event.senderType !== "user") return ignored(event, "non_user_sender");
    if (event.messageType !== "text" || event.text === null) return ignored(event, "unsupported_message_type");
    if (event.text.trim().length === 0) return ignored(event, "empty_text");
    if (!event.dedupeKey) return ignored(event, "missing_dedupe_key");
    if (!dedupe.reserve(event.dedupeKey)) return ignored(event, "duplicate_event");

    if (isStopCommand(event.text)) return handleStop(event);

    const epoch = epochs.get(event.chatId) ?? 0;
    enqueue(event.chatId, () => runMessage(event, epoch));
    const outcome = { action: "accepted", reason: route.reason, ...baseOutcome(event) };
    emit(outcome);
    return outcome;
  }

  async function stopAll({ timeoutMs = 5_000 } = {}) {
    closing = true;
    for (const [chatId, active] of activeRuns) {
      active.stopped = true;
      active.controller.abort();
      epochs.set(chatId, (epochs.get(chatId) ?? 0) + 1);
    }
    for (const queue of queues.values()) queue.items.length = 0;
    if (pending === 0) return true;
    return await Promise.race([
      whenIdle().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
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
