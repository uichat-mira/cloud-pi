#!/usr/bin/env node
/**
 * Shared helpers for the AGT-03x E2E acceptance harness (scenarios A–D).
 *
 * This module is *harness* code, not product code: it is never imported by
 * `src/`, and it never starts a channel, sends a message or alters state. It
 * only parses arguments, gates on environment presence, runs read-only
 * commands, projects evidence into a fixed whitelist and turns per-criterion
 * results into a verdict.
 *
 * The three modes every scenario script supports:
 *
 *   (default)  real mode – requires credentials; refuses to run without them
 *   --dry-run  print what would be executed, then exit with a blocker verdict
 *   --offline  exercise the judge with bundled synthetic input (self-test);
 *              never claims a real result, always reports `blocker`
 *
 * Exit codes: 0 pass, 1 fail, 2 usage error, 3 blocker (never a silent success).
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (`<root>/scripts/agt-03x/lib/harness.mjs`). */
export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, USAGE: 2, BLOCKER: 3 });

export const VERDICT = Object.freeze({ PASS: "pass", FAIL: "fail", BLOCKER: "blocker" });

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Evidence whitelist. Anything else in an emitted record is a programming
 * error and throws, so a scenario cannot accidentally write a chat id, a
 * message body or a provider payload into the JSONL file.
 */
const ALLOWED_KEYS = new Set([
  "scenario",
  "check",
  "event",
  "kind",
  "at",
  "runId",
  "scheduleId",
  "channel",
  "targetType",
  "status",
  "code",
  "durationMs",
  "usage",
  "counts",
  "tools",
  "note",
  "detail",
  "mode",
]);

const ALLOWED_NESTED_KEYS = Object.freeze({
  usage: new Set(["input", "output", "total"]),
  counts: new Set(["total", "sent", "failed", "pending", "attempts"]),
  tools: new Set(["exposed"]),
});

/** Value shapes that must never appear in evidence, whatever the field name. */
export const SECRET_SCAN_PATTERNS = Object.freeze([
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]{8,}/ },
  { name: "api_key", pattern: /sk-[A-Za-z0-9]{16,}/ },
  { name: "pem", pattern: /-----BEGIN/ },
  { name: "feishu_open_id", pattern: /\bou_[A-Za-z0-9_-]{6,}/ },
  { name: "feishu_chat_id", pattern: /\boc_[A-Za-z0-9_-]{6,}/ },
  { name: "feishu_message_id", pattern: /\bom_(?!(?:local|fixture)_)[A-Za-z0-9_-]{6,}/ },
  { name: "feishu_union_id", pattern: /\bon_[A-Za-z0-9_-]{6,}/ },
  // `wm_local_*` / `wmfixture_*` are the documented synthetic fixture namespace.
  { name: "wecom_message_id", pattern: /\bwm(?!(?:_)?(?:local|fixture))[A-Za-z0-9]{8,}/ },
  // Masks such as `chat_id=0f3b9e…a9b6` (or the ASCII `...` form that generated
  // evidence must use) are the sanctioned projection; an untruncated id is not.
  { name: "wecom_chat_id", pattern: /\b(?:chatid|chat_id)=(?![A-Za-z0-9_-]*(?:…|\.\.\.))[A-Za-z0-9_-]{4,}/i },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: "app_secret", pattern: /app_?secret\s*[=:]\s*[A-Za-z0-9]{8,}/i },
  // Mixed-case 32+ character tokens (base64url secrets). Requires a digit, rejects
  // long alphabetic runs (camelCase identifiers), URL path segments and Pi tool-call
  // ids (`call_...`), and leaves git SHAs (lowercase hex) writable.
  {
    name: "long_token",
    pattern:
      /(?<![\/\w.-])(?![A-Za-z]{13})(?!(?:call_|msg_|req_|tool_))(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,}/,
  },
  { name: "absolute_path", pattern: /[A-Za-z]:\\Users\\|\/home\/[a-z]+/ },
]);

/**
 * The only strings allowed to carry non-ASCII text into evidence. Message
 * bodies, chat transcripts and titles must never reach a JSONL file, so free
 * text is ASCII-only unless it is one of these verbatim labels.
 *
 * KEEP THIS TO THE SEED LABEL. Any second label - even a seemingly harmless
 * one - turns the "no Chinese prose in evidence" rule into "no Chinese prose
 * except these N phrases", and the list only grows. A new approved label needs
 * an explicit maintainer decision, not a convenient commit.
 */
export const APPROVED_TEXT_LABELS = Object.freeze([
  "seed 数据，非 A2 注册链能力（证据必须原样标注）",
]);

const MAX_FREE_TEXT = 160;

/** Remove approved labels so the ASCII check below only judges the remainder. */
function stripApprovedLabels(value) {
  return APPROVED_TEXT_LABELS.reduce((text, label) => text.split(label).join(""), value);
}

/**
 * Evidence free text is a machine summary, not a transcript: reject ids,
 * secrets, non-ASCII prose (outside approved labels) and oversized blobs.
 */
export function findTextViolations(value) {
  const violations = findSecretHits(value).map((name) => `looks like ${name}`);
  const remainder = stripApprovedLabels(value);
  const nonAscii = remainder.match(/[^\x20-\x7E\n\t]/g);
  if (nonAscii) {
    // Report codepoints only - never the surrounding text (it may be the leak).
    const points = [...new Set(nonAscii)].slice(0, 5).map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase()}`);
    violations.push(`contains non-ASCII text (${points.join(" ")}) (message body?)`);
  }
  if (value.length > MAX_FREE_TEXT) violations.push(`longer than ${MAX_FREE_TEXT} characters`);
  return violations;
}

/** Count secret-shaped hits in a text blob; used by D8 and by the writer guard. */
export function findSecretHits(text) {
  return SECRET_SCAN_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

function assertWhitelisted(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("evidence record must be a plain object");
  }
  for (const [key, value] of Object.entries(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`evidence key "${key}" is not on the whitelist`);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = ALLOWED_NESTED_KEYS[key];
      if (!nested) throw new Error(`evidence key "${key}" must not hold an object`);
      for (const nestedKey of Object.keys(value)) {
        if (!nested.has(nestedKey)) throw new Error(`evidence key "${key}.${nestedKey}" is not on the whitelist`);
      }
    }
    if (typeof value === "string") {
      const violations = findTextViolations(value);
      if (violations.length > 0) throw new Error(`evidence key "${key}" ${violations[0]}; refusing to write it`);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== "string") throw new Error(`evidence key "${key}" must hold strings only`);
        const violations = findTextViolations(item);
        if (violations.length > 0) throw new Error(`evidence key "${key}" ${violations[0]}; refusing to write it`);
      }
    }
  }
}

/**
 * Append-only JSONL writer. `emit` validates every record against the
 * whitelist before it touches the disk.
 */
export function createEvidence(path, { scenario } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  return {
    path,
    emit(record) {
      const event = { scenario, at: new Date().toISOString(), ...record };
      assertWhitelisted(event);
      appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return event;
    },
  };
}

/** Deterministic, non-reversible projection of any external identifier. */
export function maskId(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

/** Names (never values) of required environment variables that are absent. */
export function missingEnv(names) {
  return names.filter((name) => {
    const value = process.env[name];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

/**
 * Argument parser with a declarative spec.
 *
 * spec = { values: { "--api": "api" }, flags: { "--offline": "offline" },
 *          aliases: { "--dry-run": "--offline" } }
 */
export function parseArgs(argv, spec = {}, { usage } = {}) {
  const values = spec.values ?? {};
  const flags = spec.flags ?? {};
  const aliases = spec.aliases ?? {};
  const options = { help: false };
  for (const name of Object.values(flags)) options[name] = false;

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const arg = aliases[raw] ?? raw;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(flags, arg)) {
      options[flags[arg]] = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(values, arg)) {
      index += 1;
      if (index >= argv.length) throw new UsageError(`${raw} requires a value`);
      const key = values[arg];
      if (key.endsWith("[]")) {
        const name = key.slice(0, -2);
        (options[name] ??= []).push(argv[index]);
      } else {
        options[key] = argv[index];
      }
      continue;
    }
    throw new UsageError(`unknown argument: ${raw}${usage ? `\n${usage}` : ""}`);
  }
  return options;
}

export function writeUsage(usage) {
  if (usage) process.stderr.write(`${usage}\n`);
}

/** Read a ref (branch/tag) from the ref file or `packed-refs`, as git does. */
function readRef(gitDir, commonDir, ref) {
  for (const base of [gitDir, commonDir]) {
    const candidate = join(base, ref);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8").trim();
  }
  const packed = join(commonDir, "packed-refs");
  if (!existsSync(packed)) return null;
  for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, name] = line.split(" ");
    if (name === ref) return sha;
  }
  return null;
}

/** `.git` may be a directory or, in a worktree, a pointer file. */
function resolveGitDirs() {
  const dotGit = join(ROOT, ".git");
  if (!existsSync(dotGit)) return null;
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const pointer = readFileSync(dotGit, "utf8").trim();
    if (!pointer.startsWith("gitdir:")) return null;
    gitDir = resolve(ROOT, pointer.slice("gitdir:".length).trim());
  }
  const commonFile = join(gitDir, "commondir");
  const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
  return { gitDir, commonDir };
}

/**
 * HEAD of the checkout, read straight from the git metadata. Worktrees store
 * refs in the common dir, so both are consulted. Reading files beats spawning
 * `git`: no PATH lookup, no subprocess, and it still works when git is absent.
 */
export function gitHead() {
  try {
    const dirs = resolveGitDirs();
    if (!dirs) return null;
    const head = readFileSync(join(dirs.gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const sha = readRef(dirs.gitDir, dirs.commonDir, head.slice(5));
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Run one read-only command. Never uses a shell, so no glob expansion happens
 * behind our back; Node expands the `--test` globs itself.
 */
export function runCommand({ label, argv, cwd = ROOT, timeoutMs = 180_000, env = {} }) {
  const startedAt = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: { ...process.env, ...env, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    label,
    argv,
    exitCode: typeof result.status === "number" ? result.status : null,
    signal: result.signal ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
    durationMs: Date.now() - startedAt,
    stdout,
    stderr,
    /** Last meaningful line, for a compact evidence `detail`. */
    tail: (stderr.trim() || stdout.trim()).split("\n").slice(-2).join(" | ").slice(0, 300),
  };
}

/** Parse the TAP summary that `node --test --test-reporter=tap` prints. */
export function parseTestSummary(text) {
  const read = (name) => {
    const match = new RegExp(`^# ${name} ([0-9.]+)$`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  const tests = read("tests");
  if (tests === null) return null;
  return { tests, pass: read("pass"), fail: read("fail"), durationMs: read("duration_ms") };
}

/** Names of failing TAP cases (`not ok N - <name>`), de-duplicated. */
export function failingTests(text) {
  const names = [];
  for (const line of text.split("\n")) {
    const match = /^not ok \d+ - (.+)$/.exec(line.trim());
    if (match) names.push(match[1].trim());
  }
  return [...new Set(names)];
}

/** One acceptance criterion result. */
export function check(id, status, detail) {
  return { check: id, status, detail: String(detail ?? "").slice(0, 300) };
}

/**
 * Aggregate per-criterion results. A real failure outranks a blocker: if
 * something observed is wrong we must say `fail`, not hide behind a missing
 * credential elsewhere.
 */
export function decide(checks) {
  const failures = checks.filter((item) => item.status === VERDICT.FAIL);
  const blockers = checks.filter((item) => item.status === VERDICT.BLOCKER);
  if (failures.length > 0) return { status: VERDICT.FAIL, exitCode: EXIT.FAIL, failures, blockers };
  if (blockers.length > 0) return { status: VERDICT.BLOCKER, exitCode: EXIT.BLOCKER, failures, blockers };
  return { status: VERDICT.PASS, exitCode: EXIT.PASS, failures, blockers };
}

/** Emit the per-check rows plus one aggregate `result` row, then exit. */
export function report(evidence, { scenario, mode, checks, extra = {} }) {
  for (const item of checks) {
    evidence.emit({ ...item, mode });
  }
  const verdict = decide(checks);
  evidence.emit({
    event: "result",
    mode,
    status: verdict.status,
    counts: {
      total: checks.length,
      sent: checks.filter((item) => item.status === VERDICT.PASS).length,
      failed: verdict.failures.length,
      pending: verdict.blockers.length,
    },
    note: `${scenario} verdict=${verdict.status}`,
    ...extra,
  });
  process.exitCode = verdict.exitCode;
  return verdict;
}

/** Read a JSONL evidence file defensively; a missing file yields `[]`. */
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Run a table of self-test cases. Each case returns a `checks` array (or a
 * plain verdict string) and the table asserts the judgement the scenario must
 * produce. `--offline` succeeds only when every bundled case lands where
 * expected — it never turns into a claim about the real system.
 */
export function runSelfTest(cases) {
  let ok = true;
  const rows = [];
  for (const item of cases) {
    let actual;
    try {
      const produced = item.run();
      actual = typeof produced === "string" ? produced : decide(produced).status;
    } catch (error) {
      actual = `error:${error?.name ?? "Error"}`;
    }
    const pass = actual === item.expect;
    if (!pass) ok = false;
    rows.push({ name: item.name, expect: item.expect, actual, pass });
  }
  return { ok, rows };
}
