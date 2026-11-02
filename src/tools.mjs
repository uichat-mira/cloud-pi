/**
 * A real, low-risk, restricted local tool for the base runtime.
 *
 * Research integrations (AGT-028) supply their own extension factories and MCP
 * tools; this tool exists so a live session has a trustworthy read-only action
 * that cannot touch credentials, the repository's `.env`, or anything outside an
 * explicitly configured directory.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";

export const LOCAL_READ_TOOL_NAME = "local_read_text";

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_EXTENSIONS = Object.freeze([".md", ".txt", ".json", ".yaml", ".yml", ".csv"]);

function failure(reason) {
  return {
    isError: true,
    content: [{ type: "text", text: `local_read_text: ${reason}` }],
    details: { error: reason },
  };
}

function inside(root, absolute) {
  const rel = relative(root, absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * @param {object} options
 * @param {string} options.root absolute directory the tool may read
 * @param {number} [options.maxBytes]
 * @param {readonly string[]} [options.extensions]
 */
export function createLocalReadTool({ root, maxBytes = DEFAULT_MAX_BYTES, extensions = DEFAULT_EXTENSIONS } = {}) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new TypeError("createLocalReadTool requires an absolute `root` directory");
  }
  const allowed = new Set(extensions.map((ext) => ext.toLowerCase()));

  return {
    name: LOCAL_READ_TOOL_NAME,
    label: "Local read-only text",
    description:
      "Read a UTF-8 text file from the session's read-only notes directory. " +
      "Use it when the task refers to a local note or fixture file.",
    promptSnippet: "Read a file from the read-only notes directory",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the read-only notes root, e.g. welcome.md" }),
    }),
    async execute(_toolCallId, { path: requested }, signal) {
      if (signal?.aborted) return failure("aborted");
      if (typeof requested !== "string" || requested.length === 0) return failure("path is required");
      if (requested.includes("\0")) return failure("path contains a NUL byte");
      if (isAbsolute(requested)) return failure("absolute paths are not allowed");

      let rootReal;
      try {
        rootReal = realpathSync(root);
      } catch {
        return failure(`read-only root is not available: ${root}`);
      }

      const candidate = resolve(rootReal, requested);
      if (!inside(rootReal, candidate)) return failure("path escapes the read-only root");

      let real;
      try {
        real = realpathSync(candidate);
      } catch {
        return failure(`file not found: ${requested}`);
      }
      if (!inside(rootReal, real)) return failure("path escapes the read-only root");

      const dot = real.lastIndexOf(".");
      const extension = dot >= 0 ? real.slice(dot).toLowerCase() : "";
      if (!allowed.has(extension)) return failure(`unsupported file type: ${extension || "(none)"}`);

      let stat;
      try {
        stat = statSync(real);
      } catch {
        return failure(`file not found: ${requested}`);
      }
      if (!stat.isFile()) return failure(`not a regular file: ${requested}`);
      if (stat.size > maxBytes) return failure(`file is larger than ${maxBytes} bytes`);

      let buffer;
      try {
        const fd = openSync(real, "r");
        try {
          buffer = readFileSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        return failure(`could not read: ${requested}`);
      }
      if (buffer.includes(0)) return failure("file does not look like UTF-8 text");

      const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
      const displayPath = relative(rootReal, real).split(sep).join("/");
      return {
        content: [{ type: "text", text }],
        details: {
          path: displayPath,
          bytes: buffer.byteLength,
          sha256: createHash("sha256").update(buffer).digest("hex"),
        },
      };
    },
  };
}
