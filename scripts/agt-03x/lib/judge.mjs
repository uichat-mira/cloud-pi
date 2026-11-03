/**
 * Pure verdicts for the C3 full-suite gate. Kept in `lib/` so the judgement can
 * be unit-tested (see `self-test.mjs`) without spawning a 555-test suite: a
 * gate that only looks at failure *names* can silently accept a failure whose
 * title happens to contain a known substring, so the count is asserted here.
 */
import { check } from "./harness.mjs";

/** Baseline `dev` @ 8efc250: 555 tests, 2 known failures (both Windows defects). */
export const BASELINE_TOTAL = 555;

/**
 * The two Windows-only defects recorded in baseline §4 (cleared by t7). Node's
 * TAP reporter prints the enclosing `describe` name as its own `not ok` line, so
 * three patterns cover the two real failures.
 */
export const KNOWN_FAILURES = Object.freeze([
  /resolveRunsRoot: explicit > env > default/,
  /adapter: system prompt and cwd isolation/i,
  /research policy reaches the model-visible system prompt/i,
]);

/** Number of real failing tests expected on the baseline. */
export const EXPECTED_FAILURES = 2;

export function fullSuiteVerdict({ tests, fail, failing }, options = {}) {
  const baselineTotal = options.baselineTotal ?? BASELINE_TOTAL;
  const expectedFail = options.expectedFail ?? EXPECTED_FAILURES;
  const known = options.known ?? KNOWN_FAILURES;

  if (!Number.isFinite(tests)) return check("C3", "fail", "full suite produced no TAP summary");
  if (!Number.isFinite(fail)) return check("C3", "fail", "full suite produced no TAP failure count");
  if (tests < baselineTotal) return check("C3", "fail", `tests=${tests} < baseline ${baselineTotal}`);
  if (fail !== expectedFail) {
    return check(
      "C3",
      "fail",
      `fail=${fail} != expected ${expectedFail} (baseline drifted: a known defect was fixed or the failing set changed)`,
    );
  }
  const unknown = failing.filter((name) => !known.some((pattern) => pattern.test(name)));
  if (unknown.length > 0) {
    return check("C3", "fail", `failing set grew by ${unknown.length}: ${unknown.slice(0, 2).join(" | ")}`);
  }
  return check("C3", "pass", `tests=${tests} fail=${fail} (${failing.length} known TAP lines)`);
}
