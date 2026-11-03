/**
 * Public API of the Cloud Pi local management control plane (AGT-034).
 *
 * This module is a thin, versioned JSON HTTP facade. The Scheduler owns schedule
 * definitions, leases and triggers; the Research run store owns run records and
 * artifacts. Nothing here persists task state or reads/writes those JSON files.
 *
 * The only accepted listeners are the literal loopback addresses `127.0.0.1`
 * and `::1`. There is no token/account system and no public listener; Cloud Auth
 * delegation is a later, separately authorized card.
 *
 * Usage:
 *
 * ```js
 * import { createScheduler } from "./src/scheduler/index.mjs";
 * import { createManagementApi } from "./src/api/index.mjs";
 *
 * const scheduler = await createScheduler({ stateDir, researchDeps });
 * const api = createManagementApi({ scheduler, runsDir, host: "127.0.0.1", port: 8787 });
 * const address = await api.start(); // { host, family, port, url }
 * // ... console uses address.url + /v1/...
 * await api.stop(); // bounded drain, then force-close
 * ```
 */
export {
  API_CONTRACT_VERSION,
  API_ERROR,
  API_HTTP_STATUS,
  API_LIMITS,
  API_PREFIX,
  ApiError,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  LOOPBACK_HOSTS,
  apiErrorRecord,
  isApiErrorCode,
} from "./contracts.mjs";
export { formatListenAddress, normalizeApiHost, normalizeApiPort } from "./policy.mjs";
export { createApiController } from "./controller.mjs";
export { createApiRouter, mapApiError } from "./router.mjs";
export { toDeliveryView, toReportView, toRunView, toScheduleView, toSourceView, toTriggerView } from "./views.mjs";
export { createManagementApi } from "./server.mjs";
