/**
 * Feishu channel public surface.
 *
 * The channel adapter itself (`channel.mjs`) has no network or Pi SDK import;
 * transport and the Cloud Pi runtime adapter are separate so tests can prove
 * routing/dedupe/cancel without opening a socket or calling a model.
 */
export {
  FEISHU_CONFIG_KEYS,
  FeishuConfigError,
  SUPPORTED_DOMAINS,
  describeFeishuConfig,
  loadFeishuConfig,
  maskId,
} from "./config.mjs";
export { FEISHU_MESSAGE_EVENT, normalizeFeishuMessageEvent, readFeishuEventType } from "./events.mjs";
export { decideFeishuRoute } from "./policy.mjs";
export { DEFAULT_DEDUPE_MAX_ENTRIES, DEFAULT_DEDUPE_TTL_MS, createDedupeStore } from "./dedupe.mjs";
export { CHANNEL_REPLIES, STOP_COMMANDS, createFeishuChannel } from "./channel.mjs";
export {
  FEISHU_CHANNEL_SYSTEM_PROMPT,
  createFeishuAgentRunner,
  feishuChannelPromptExtension,
} from "./runtime.mjs";
export { createFeishuTransport } from "./transport.mjs";
export { startFeishuService } from "./service.mjs";
