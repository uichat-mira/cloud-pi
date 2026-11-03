/**
 * Public API of scheduled-research delivery (AGT-033).
 *
 * Minimal usage:
 *
 * ```js
 * import { createDeliveringScheduler } from "./src/delivery/index.mjs";
 * import { createFeishuTransport } from "./src/channels/feishu/transport.mjs";
 * import { loadFeishuConfig } from "./src/channels/feishu/config.mjs";
 *
 * const config = loadFeishuConfig(process.env);
 * const transport = createFeishuTransport({ config, onEvent: async () => {} });
 *
 * const delivering = await createDeliveringScheduler({
 *   schedulerOptions: {
 *     stateDir: ".work/scheduler",
 *     researchDeps: { runtimePort, toolLayer, rootDir: ".work/research-runs" },
 *   },
 *   delivery: {
 *     stateDir: ".work/delivery",
 *     sendMessage: transport.send,
 *     researchRunsDir: ".work/research-runs",
 *   },
 * });
 *
 * await delivering.scheduler.createSchedule({
 *   kind: "recurring",
 *   timezone: "Asia/Shanghai",
 *   cron: "0 9 * * *",
 *   request: { topic: "…" },
 *   deliveryTargets: [
 *     { type: "open_id", id: "ou_…", label: "维护者" },
 *     { type: "chat_id", id: "oc_…", label: "测试群" },
 *   ],
 * });
 * ```
 *
 * The coordinator can also be used directly with a completion callback:
 * `coordinator.deliverRun({ runId, researchStatus, triggerStatus, schedule })`.
 * Repeating that call is safe: `runId + destination` is the persisted key.
 */
export {
  DEFAULT_DELIVERY_STATE_DIR,
  DELIVERY_CONTRACT_VERSION,
  DELIVERY_ENV,
  DELIVERY_ERROR,
  DELIVERY_KIND,
  DELIVERY_LIMITS,
  DELIVERY_RUN_STATUS,
  DELIVERY_STATUS,
  DeliveryError,
  buildDeliveryKey,
  deliveryFileStem,
  describeResearchStatus,
  maskDestination,
  normalizeDestination,
  planDelivery,
  resolveDeliveryStateDir,
  summarizeRunDelivery,
  toDeliveryError,
} from "./contracts.mjs";
export { buildDeliveryMessage, segmentUuid, splitBounded } from "./format.mjs";
export { assertDeliveryRecordShape, createDeliveryStore } from "./store.mjs";
export { createDeliveryCoordinator } from "./coordinator.mjs";
export { createDeliveringScheduler } from "./scheduler.mjs";
