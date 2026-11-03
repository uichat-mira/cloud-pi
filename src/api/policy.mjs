/**
 * Local-only listening policy for the management API.
 *
 * Cloud Pi has no Cloud Auth delegation contract yet, so this server must never
 * be reachable from another host. The policy resolves no hostnames: only the
 * literal loopback addresses `127.0.0.1` (IPv4) and `::1` (IPv6) are accepted.
 * `0.0.0.0`, `::`, `localhost` and every other value are refused *before* a
 * socket is created, so a typo cannot silently expose a control plane.
 */
import { API_ERROR, ApiError, LOOPBACK_HOSTS } from "./contracts.mjs";

const LOOPBACK_SET = new Set(LOOPBACK_HOSTS);

/** @param {unknown} host */
export function normalizeApiHost(host = LOOPBACK_HOSTS[0]) {
  if (typeof host !== "string" || !host.trim()) {
    throw new ApiError(API_ERROR.INVALID_REQUEST, "host must be a loopback address (127.0.0.1 or ::1)");
  }
  const value = host.trim();
  if (!LOOPBACK_SET.has(value)) {
    throw new ApiError(
      API_ERROR.INVALID_REQUEST,
      `refusing to bind non-loopback host ${JSON.stringify(value)}; only 127.0.0.1 and ::1 are allowed`,
    );
  }
  return value;
}

/**
 * Validate a TCP port. `0` asks the OS for an ephemeral port and is allowed
 * (tests and the local smoke use it); a concrete port must be an integer in
 * 1..65535.
 *
 * @param {unknown} port
 */
export function normalizeApiPort(port) {
  if (port === undefined) return 8787;
  if (typeof port === "string" && /^\d+$/.test(port.trim())) port = Number(port.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ApiError(API_ERROR.INVALID_REQUEST, "port must be an integer between 0 and 65535");
  }
  return port;
}

/**
 * Render a base URL for an actual listening address. IPv6 addresses need
 * brackets and contain `:` so the family is taken from the socket address.
 *
 * @param {{ address: string, family: string, port: number }} address
 */
export function formatListenAddress(address) {
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  return {
    host: address.address,
    family: address.family,
    port: address.port,
    url: `http://${host}:${address.port}${"/v1"}`,
  };
}
