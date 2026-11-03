/**
 * Public surface of the WeCom channel.
 *
 * Consumers outside `src/channels/wecom/` should only need this barrel; the
 * channel is wired by `service.mjs`, never by reaching into transport internals.
 */
export {
  WECOM_CONFIG_KEYS,
  WECOM_DEFAULTS,
  WECOM_MAX_CONTENT_BYTES,
  WecomConfigError,
  describeWecomConfig,
  hashId,
  loadWecomConfig,
} from "./config.mjs";
export { WECOM_MESSAGE_CALLBACK, normalizeWecomMessageEvent, stripBotMention } from "./events.mjs";
export { WECOM_IGNORE_REASON, WECOM_ROUTE, decideWecomRoute } from "./policy.mjs";
export { createWecomDedupeStore } from "./dedupe.mjs";
export {
  WECOM_RESEARCH_COMMAND,
  WECOM_REPLIES,
  WECOM_STOP_COMMAND,
  createWecomChannel,
  isWecomResearchCommand,
  isWecomStopCommand,
} from "./channel.mjs";
export { WECOM_CHANNEL_SYSTEM_PROMPT, createWecomAgentRunner, wecomChannelPromptExtension } from "./runtime.mjs";
export { WECOM_RATE_LIMITS, WecomTransportError, createWecomTransport } from "./transport.mjs";
export { createKnownSessionStore } from "./sessions.mjs";
export { WecomInstanceError, createInstanceLock } from "./instance.mjs";
export { DEFAULT_WECOM_STATE_DIR, createWecomService } from "./service.mjs";
export { createJsonLogger, exitCodeFor, main } from "./server.mjs";
export { WECOM_SEGMENT_DEFAULTS, byteLength, splitForSend } from "./text.mjs";
