/**
 * The Feishu channel adapter.
 *
 * One inbound Feishu message that passes routing policy becomes exactly one
 * `runTurn` call (which the host wires to `createAgentRuntime().run()`) or, for
 * the explicit research command, one `runResearch` call (which the host wires
 * to the existing AGT-028 `startResearch()`). The run's answer is replied to
 * the original message. The adapter owns no model, session or tool, so it
 * cannot become a second Agent Runtime.
 *
 * Guarantees this module enforces:
 *  - routing is decided before any run (private / authorized group @ / ignore);
 *  - a dedupe key is reserved before the async run starts, so redelivery and
 *    concurrent duplicates produce one run;
 *  - only an explicit `/research <topic>` command starts research; every other
 *    text keeps the existing single-turn chat behaviour;
 *  - runs for one chat are serialized; `/stop` aborts the active run's
 *    AbortSignal immediately and queued pre-stop messages are dropped;
 *  - runtime failures and reply failures are reported, never swallowed;
 *  - a research reply is bounded and mapped from the real research terminal
 *    status, and reply/truncation failures never rewrite that status.
 */
import { createDedupeStore } from "./dedupe.mjs";
import { normalizeFeishuMessageEvent, readFeishuEventType } from "./events.mjs";
import { decideFeishuRoute } from "./policy.mjs";
import { maskId } from "./config.mjs";
import { sanitizeModelReply } from "../../redaction.mjs";

export const STOP_COMMANDS = Object.freeze(new Set(["/stop", "/cancel", "停止", "取消"]));

export const CHANNEL_REPLIES = Object.freeze({
  stopped: "已停止当前任务。",
  noActiveRun: "当前没有正在运行的任务。",
  empty: "Mira 没有生成可发送的回复。",
  cancelled: "处理已取消。",
  timeout: "处理超时，请稍后重试。",
});

/**
 * Explicit research entry points. This is a command contract, not intent
 * detection: only a message whose *first* token is exactly one of these starts
 * a research run, so ordinary chat text never becomes a high-cost run.
 */
export const RESEARCH_COMMANDS = Object.freeze(["/research", "/研究"]);

/** Hard upper bound for one research reply, including the run id line. */
export const MAX_RESEARCH_REPLY_CHARS = 1_800;

export const RESEARCH_REPLIES = Object.freeze({
  usage: "用法：/research <研究主题>。例如：/research 最近 48 小时 AI Agent 工程进展",
  unavailable: "研究入口当前不可用，请稍后重试。",
  noReport: "（本次运行没有可读报告，详情见运行记录。）",
  reportUnavailable: "（报告读取失败，详情见运行记录。）",
  truncated: "\n\n…（报告已截断，完整内容见运行记录）",
});

/** Research terminal status → the reply/outcome vocabulary. */
const RESEARCH_REPLY_STATUS = Object.freeze({
  completed: "succeeded",
  completed_with_errors: "partial",
  failed: "failed",
  cancelled: "cancelled",
  timeout: "timeout",
});

const RESEARCH_LABELS = Object.freeze({
  succeeded: "研究完成",
  partial: "研究部分完成（部分来源或工具失败）",
  failed: "研究失败",
  cancelled: "研究已取消",
  timeout: "研究超时",
});

const MAX_REPLY_CODE_LENGTH = 40;

function isStopCommand(text) {
  return STOP_COMMANDS.has(text.trim().toLowerCase()) || STOP_COMMANDS.has(text.trim());
}

/**
 * Map a research run status onto the distinct reply kinds. Unknown or missing
 * statuses fail closed instead of being presented as success.
 */
export function mapResearchStatus(status) {
  return RESEARCH_REPLY_STATUS[status] ?? "failed";
}

/**
 * Parse the explicit research command.
 *
 * @param {string} text trimmed-or-raw message text
 * @returns {{isCommand:boolean, command?:string, topic:string}}
 *   `isCommand` only when the first token is exactly `/research` or `/研究` and
 *   is followed by whitespace/end; `/researchfoo` and `please /research x` are
 *   ordinary chat text.
 */
export function parseResearchCommand(text) {
  if (typeof text !== "string") return { isCommand: false, topic: "" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { isCommand: false, topic: "" };
  const lower = trimmed.toLowerCase();
  for (const command of RESEARCH_COMMANDS) {
    if (!lower.startsWith(command)) continue;
    const rest = trimmed.slice(command.length);
    if (rest.length > 0 && !/^\s/.test(rest)) continue;
    return { isCommand: true, command, topic: rest.trim() };
  }
  return { isCommand: false, topic: "" };
}

function clipText(value, maxChars) {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return chars.slice(0, Math.max(0, maxChars)).join("");
}

function safeErrorCode(record) {
  const code = record?.error?.code;
  if (typeof code === "string" && /^[a-z0-9_]{1,40}$/i.test(code)) return code.slice(0, MAX_REPLY_CODE_LENGTH);
  return "unknown";
}

function maskMessageId(value) {
  return maskId(value, { head: 6, tail: 4 });
}

function reportBody(report) {
  if (typeof report !== "string") return "";
  return report.replace(/^\uFEFF/, "").trim();
}

/**
 * Build the bounded Feishu reply for one research result.
 *
 * The run id is part of the header and therefore always survives truncation;
 * the body is clipped to the remaining budget. A long report degrades into a
 * truncated body, never into a failed run.
 *
 * @param {{status?:string, runId?:string, report?:string|null,
 *   reportUnavailable?:boolean, error?:{code?:string}}} record
 * @param {{maxChars?:number}} [options]
 */
export function buildResearchReply(record, { maxChars = MAX_RESEARCH_REPLY_CHARS } = {}) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_RESEARCH_REPLY_CHARS;
  const kind = mapResearchStatus(record?.status);
  const runId = typeof record?.runId === "string" && record.runId.length > 0 ? record.runId : null;
  const runLabel = runId ? `run ${runId}` : "run 未创建";

  if (kind === "cancelled" || kind === "timeout") {
    return clipText(`${RESEARCH_LABELS[kind]} · ${runLabel}`, limit);
  }
  if (kind === "failed") {
    return clipText(`${RESEARCH_LABELS.failed}（${safeErrorCode(record)}） · ${runLabel}，请稍后重试。`, limit);
  }

  const header = `${RESEARCH_LABELS[kind]} · ${runLabel}`;
  const body = reportBody(record?.report);
  if (body.length === 0) {
    const fallback = record?.reportUnavailable === true ? RESEARCH_REPLIES.reportUnavailable : RESEARCH_REPLIES.noReport;
    return clipText(`${header}\n\n${fallback}`, limit);
  }

  const separator = "\n\n";
  const bodyBudget = Math.max(0, limit - Array.from(header).length - separator.length - Array.from(RESEARCH_REPLIES.truncated).length);
  const bodyChars = Array.from(body);
  const clipped = bodyChars.length > bodyBudget;
  const bodyText = clipped ? bodyChars.slice(0, bodyBudget).join("") : body;
  return clipText(`${header}${separator}${bodyText}${clipped ? RESEARCH_REPLIES.truncated : ""}`, limit);
}

/**
 * @param {object} options
 * @param {Iterable<string>|Set<string>} [options.allowedChatIds] trusted POC group allowlist
 * @param {string|Function} [options.botOpenId] verified bot open id, or a getter
 * @param {Function} options.runTurn async ({text, chatId, chatType, messageId, signal}) => run record
 * @param {Function} [options.runResearch] async ({topic, chatId, chatType, messageId, signal}) =>
 *   research record `{status, runId, report, reportUnavailable?, durationMs?}`; when absent an
 *   explicit research command fails closed without starting a run
 * @param {Function} options.reply async (messageId, text) => {messageId?}
 * @param {object} [options.dedupe] dedupe store (tests/injection)
 * @param {Function} [options.onOutcome] observes every decision/outcome (no message text)
 * @param {Function} [options.log] structured diagnostic sink
 */
export function createFeishuChannel({
  allowedChatIds = [],
  botOpenId,
  runTurn,
  runResearch,
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

  /** Drop queued (not yet started) tasks and release their pending slots. */
  function dropQueued(queue) {
    while (queue.items.length > 0) {
      queue.items.pop();
      end();
    }
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

  async function replyResearchUsage(event, epoch) {
    if (disposed) return ignored(event, "channel_disposed");
    if ((epochs.get(event.chatId) ?? 0) !== epoch) {
      return ignored(event, "stopped_before_start");
    }
    const sent = await safeReply(event.messageId, RESEARCH_REPLIES.usage);
    const outcome = {
      action: "research_usage",
      kind: "research",
      reason: "missing_topic",
      replyMessageId: sent.messageId,
      replyDelivered: sent.ok,
      ...baseOutcome(event),
    };
    emit(outcome);
    return outcome;
  }

  async function runMessage(event, epoch, research = null) {
    if (disposed) return ignored(event, "channel_disposed");
    if ((epochs.get(event.chatId) ?? 0) !== epoch) {
      // A /stop arrived after this message was queued; it must never run.
      return ignored(event, "stopped_before_start");
    }

    const controller = new AbortController();
    const state = { controller, stopped: false };
    activeRuns.set(event.chatId, state);
    const isResearch = Boolean(research);

    let record;
    try {
      if (isResearch) {
        if (typeof runResearch !== "function") {
          record = {
            status: "failed",
            text: "",
            runId: undefined,
            error: { code: "research_unavailable" },
          };
        } else {
          record = await runResearch({
            text: event.text,
            topic: research.topic,
            chatId: event.chatId,
            chatType: event.chatType,
            messageId: event.messageId,
            eventId: event.eventId,
            senderOpenId: event.senderOpenId,
            signal: controller.signal,
          });
        }
      } else {
        record = await runTurn({
          text: event.text,
          chatId: event.chatId,
          chatType: event.chatType,
          messageId: event.messageId,
          eventId: event.eventId,
          senderOpenId: event.senderOpenId,
          signal: controller.signal,
        });
      }
    } catch (error) {
      log({
        level: "error",
        event: isResearch ? "feishu_research_turn_failed" : "feishu_run_turn_failed",
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
        ...(isResearch ? { kind: "research", researchStatus: status } : {}),
        runId: typeof record?.runId === "string" ? record.runId : undefined,
        ...baseOutcome(event),
      };
      emit(outcome);
      return outcome;
    }

    let replyText;
    if (isResearch) {
      replyText = buildResearchReply(record);
    } else if (status === "succeeded") {
      const answer = typeof record?.text === "string" ? record.text.trim() : "";
      replyText = answer.length > 0 ? answer : CHANNEL_REPLIES.empty;
    } else if (status === "cancelled") {
      replyText = CHANNEL_REPLIES.cancelled;
    } else if (status === "timeout") {
      replyText = CHANNEL_REPLIES.timeout;
    } else {
      replyText = `Mira 处理失败（${safeErrorCode(record)}），请稍后重试。`;
    }

    // Pseudo tool syntax written as prose must never reach the user; the reply is
    // replaced and the turn is recorded as failed so the trace matches the chat.
    const { text: sanitizedReply, leaked } = sanitizeModelReply(replyText);
    if (leaked) {
      log({ level: "warn", event: "feishu_reply_pseudo_tool_text", action: "replaced" });
      replyText = sanitizedReply;
    }
    const sent = await safeReply(event.messageId, replyText);

    if (isResearch) {
      const kind = mapResearchStatus(status);
      const outcome = {
        action: kind === "cancelled" ? "cancelled" : kind === "failed" || kind === "timeout" ? "failed" : "replied",
        kind: "research",
        status: kind,
        researchStatus: status,
        runId: typeof record?.runId === "string" ? record.runId : undefined,
        durationMs: Number.isFinite(record?.durationMs) ? record.durationMs : undefined,
        sources: Number.isFinite(record?.sources) ? record.sources : undefined,
        errorCode: kind === "succeeded" || kind === "partial" ? undefined : safeErrorCode(record),
        replyMessageId: sent.messageId,
        replyDelivered: sent.ok,
        ...baseOutcome(event),
      };
      if (leaked) Object.assign(outcome, { action: "failed", reason: "pseudo_tool_text", status: "failed" });
      emit(outcome);
      return outcome;
    }

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
      errorCode: leaked ? "pseudo_tool_text" : status === "succeeded" ? undefined : safeErrorCode(record),
      replyMessageId: sent.messageId,
      replyDelivered: sent.ok,
      ...baseOutcome(event),
    };
    if (leaked) Object.assign(outcome, { action: "failed", reason: "pseudo_tool_text", status: "failed" });
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
    const research = parseResearchCommand(event.text);
    if (research.isCommand) {
      // An explicit command is the only way to start research; a missing topic
      // replies with usage instead of calling the research executor.
      if (research.topic.length === 0) {
        enqueue(event.chatId, () => replyResearchUsage(event, epoch));
      } else {
        enqueue(event.chatId, () => runMessage(event, epoch, research));
      }
      const outcome = {
        action: "accepted",
        reason: route.reason,
        kind: "research",
        command: research.command,
        topicProvided: research.topic.length > 0,
        ...baseOutcome(event),
      };
      emit(outcome);
      return outcome;
    }

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
    for (const queue of queues.values()) dropQueued(queue);
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
