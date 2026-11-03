/**
 * Minimal `KEY=VALUE` env-file reader shared by the process entries.
 *
 * Credentials in this repository are injected per process, never committed. A
 * secrets file is read into memory and merged into the process environment; the
 * values are never logged, returned by a describe/summary function or written
 * back to disk. This module is deliberately tiny: it is not a dotenv
 * implementation, it only accepts the shape the maintainer files use.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Default channel-credential file (outside the repository). */
export function defaultSecretsPath(home = homedir()) {
  return join(home, ".mira-secrets", "wecom.env");
}

/**
 * Parse `KEY=VALUE` lines. Blank lines and `#` comments are ignored; a leading
 * `export ` is accepted; matching surrounding quotes are removed.
 *
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const at = withoutExport.indexOf("=");
    if (at <= 0) continue;
    const key = withoutExport.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(at + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read one env file. `missing: "ignore"` returns an empty object when the file
 * does not exist (the caller decides whether that is a degradation).
 *
 * @param {string} path
 * @param {{ missing?: "ignore"|"error" }} [options]
 * @returns {Record<string,string>}
 */
export function loadEnvFile(path, { missing = "error" } = {}) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (missing === "ignore" && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return {};
    throw error;
  }
  return parseEnvText(text);
}

/**
 * Resolve a path that may be absolute, `~/...`, or relative to `baseDir`.
 *
 * @param {string} value
 * @param {string} [baseDir]
 */
export function resolveUserPath(value, baseDir = process.cwd()) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (text === "~") return homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return join(homedir(), text.slice(2));
  return isAbsolute(text) ? text : join(baseDir, text);
}
