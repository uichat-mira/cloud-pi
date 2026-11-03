/**
 * Pure verdicts for the C3 full-suite gate. Kept in `lib/` so the judgement can
 * be unit-tested (see `self-test.mjs`) without spawning the whole suite.
 *
 * History (t11 G13): this gate used to assert two hand-edited constants — a
 * baseline total of 555 tests and exactly 2 expected failures — captured from
 * `dev@8efc250`. Both Windows defects were fixed by t7, so `dev` runs **642
 * tests with 0 failures**; the constants then rejected a *healthy* suite. That
 * is the failure mode of absolute baselines: they encode history, not health.
 *
 * Current rule (no absolute numbers anywhere — every count is read from the TAP
 * summary the caller passes in):
 *   1. the summary must exist and report a positive test count;
 *   2. `fail` must be 0 — unless an explicit, non-empty known-failure list is
 *      supplied *and* every failing TAP line matches one of its patterns;
 *   3. any failure outside that list fails the gate, even if its title looks
 *      like a known one (the old name-only check could be fooled this way).
 *
 * `KNOWN_FAILURES` is empty on purpose: the defects it used to hold are fixed.
 * Relaxing it means adding a pattern **and** recording why in the commit message
 * and in docs/evidence/wecom-v1/README.md §7 — never through an env var, which
 * would turn the gate into a silent relaxation switch.
 */
import { check } from "./harness.mjs";

export const KNOWN_FAILURES = Object.freeze([]);

export function fullSuiteVerdict({ tests, fail, failing } = {}, options = {}) {
  const known = options.known ?? KNOWN_FAILURES;
  const failingNames = Array.isArray(failing) ? failing : [];

  if (!Number.isFinite(tests) || tests <= 0) {
    return check("C3", "fail", "full suite produced no positive TAP test count");
  }
  if (!Number.isFinite(fail) || fail < 0) {
    return check("C3", "fail", "full suite produced no TAP failure count");
  }
  if (fail > tests) {
    return check("C3", "fail", `fail=${fail} > tests=${tests} (inconsistent TAP summary)`);
  }
  if (fail === 0) {
    return check("C3", "pass", `tests=${tests} fail=0 (counts read from TAP, no absolute baseline)`);
  }
  if (known.length === 0) {
    return check(
      "C3",
      "fail",
      `fail=${fail} but no known failure is declared; failing: ${failingNames.slice(0, 2).join(" | ")}`,
    );
  }
  const unknown = failingNames.filter((name) => !known.some((pattern) => pattern.test(name)));
  if (unknown.length > 0) {
    return check("C3", "fail", `failing set grew by ${unknown.length}: ${unknown.slice(0, 2).join(" | ")}`);
  }
  return check("C3", "pass", `tests=${tests} fail=${fail} (all failures match the declared known list)`);
}
