/**
 * Prints one computed instant so a parent test can prove that the scheduler's
 * time-zone math does not depend on the child process TZ environment.
 *
 *   node tests/helpers/next-run-child.mjs <cron> <timezone> <after ISO>
 */
import { nextCronOccurrence } from "../../src/scheduler/schedule.mjs";

const [cron, timezone, after] = process.argv.slice(2);
const next = nextCronOccurrence(cron, timezone, new Date(after));
if (!next) {
  console.error("no next occurrence");
  process.exitCode = 1;
} else {
  process.stdout.write(`${next.toISOString()}\n`);
}
