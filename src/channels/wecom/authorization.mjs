/**
 * Startup gate: enabling external tools requires an explicitly authorized WeCom
 * session list.
 *
 * Why this exists (V1 authorization boundary):
 *
 *   - Every Guanlan read in V1 uses the *maintainer-delegated* service credential
 *     (single-tenant delegation, ADR-002; per-account X1–X4 deferred). There is no
 *     per-user identity to fall back on: whatever the bot reads, it reads as the
 *     maintainer.
 *   - `WECOM_ALLOWED_USER_IDS` / `WECOM_ALLOWED_CHAT_IDS` are optional for a
 *     chat-only deployment, and an empty list means "anyone who can message the
 *     bot". That default is fine when the run can only talk; it is not fine when
 *     the run can reach an external service under someone else's identity.
 *
 * So the two facts may not be true at once: external tools enabled **and** no
 * allowlist. When they meet, the process refuses to start instead of serving an
 * implicit "everyone is authorized" policy.
 *
 * What the allowlist is: local conversation authorization for this channel
 * process — who may trigger a run. It is **not** Cloud Auth authorization, and it
 * grants no account, tool or data privilege. The tool still decides what it will
 * return to the delegated identity.
 */
import { WECOM_CONFIG_KEYS, WecomConfigError } from "./config.mjs";

/**
 * Environment keys that mean "this process can reach an external tool service".
 *
 * Kept to the Guanlan MCP binding because that is the only external tool in V1;
 * a second one must be added here deliberately, together with its own review.
 */
export const EXTERNAL_TOOL_ENV_KEYS = Object.freeze([
  "GUANLAN_MCP_URL",
  "GUANLAN_MCP_TOKEN",
  "GUANLAN_MCP_TOKEN_FILE",
]);

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** @returns {string[]} the external-tool env keys actually set. */
export function enabledExternalToolSources(env = {}) {
  return EXTERNAL_TOOL_ENV_KEYS.filter((key) => present(env?.[key]));
}

/** Non-secret projection of the conversation allowlist. */
export function describeSessionAuthorization(config = {}) {
  const allowedUserCount = Array.isArray(config.allowedUserIds) ? config.allowedUserIds.length : 0;
  const allowedChatCount = Array.isArray(config.allowedChatIds) ? config.allowedChatIds.length : 0;
  return {
    allowedUserCount,
    allowedChatCount,
    explicitlyAuthorized: allowedUserCount > 0 || allowedChatCount > 0,
  };
}

/**
 * Refuse to build a WeCom channel that reaches external tools without an
 * explicit session allowlist.
 *
 * @param {{env?: Record<string,string|undefined>, config?: object}} [input]
 * @returns {{enforced: boolean, sources: string[], allowedUserCount: number, allowedChatCount: number}}
 * @throws {WecomConfigError} when external tools are enabled and both allowlists are empty
 */
export function assertWecomSessionAuthorization({ env = {}, config = {} } = {}) {
  const sources = enabledExternalToolSources(env);
  const authorization = describeSessionAuthorization(config);
  if (sources.length === 0) {
    return { enforced: false, ...authorization, sources };
  }
  if (authorization.explicitlyAuthorized) {
    return { enforced: true, ...authorization, sources };
  }
  throw new WecomConfigError(
    [WECOM_CONFIG_KEYS.ALLOWED_USER_IDS, WECOM_CONFIG_KEYS.ALLOWED_CHAT_IDS],
    "external tools are enabled (" +
      sources.join(", ") +
      "), so WeCom sessions must be explicitly authorized before the channel starts: set " +
      WECOM_CONFIG_KEYS.ALLOWED_USER_IDS +
      " (direct chat) and/or " +
      WECOM_CONFIG_KEYS.ALLOWED_CHAT_IDS +
      " (group) to the sessions allowed to trigger a run. Without an allowlist anyone who can " +
      "message the bot could trigger a tool call under the maintainer-delegated service identity. " +
      "The allowlist is local conversation authorization, not Cloud Auth authorization.",
  );
}
