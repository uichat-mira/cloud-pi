/**
 * AGT-033 failure-isolation re-probe after fixing SDK-thrown business errors.
 *
 * The main live run (poc/evidence/agt-033-live-delivery.jsonl) proved real
 * personal/group sends and idempotent replay. Its unreachable-destination probe
 * was retried 3 times because the SDK throws AxiosError for HTTP 400 business
 * rejections; the transport first classified every thrown error as a network
 * error. This script re-probes only the failure path after that fix:
 *
 *   - one trusted but unreachable `open_id`;
 *   - expected: one API attempt, terminal failure, code 99992351, no message id;
 *   - no message is sent to any real person or group.
 *
 * It appends one evidence line to the live JSONL. Never prints or stores raw ids
 * or credentials.
 *
 *   node --env-file-if-exists=.env scripts/agt-033/live-failure-probe.mjs
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeliveryCoordinator } from "../../src/delivery/index.mjs";
import { loadFeishuConfig, maskId } from "../../src/channels/feishu/config.mjs";
import { createFeishuTransport } from "../../src/channels/feishu/transport.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath =
  outIndex >= 0 ? args[outIndex + 1] : join(repoRoot, "poc", "evidence", "agt-033-live-delivery.jsonl");
const UNREACHABLE_OPEN_ID = `ou_${"0".repeat(32)}`;
const codeCommit = process.env.AGT_033_CODE_COMMIT ?? null;
const stateRoot = join(repoRoot, ".work", "agt-033", `failure-probe-${Date.now()}`);

function timestampRunId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("Z", "");
  const hex = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `r-${stamp}-${hex}`;
}

async function appendLine(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  await mkdir(dirname(outPath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(outPath, "utf8");
  } catch {
    existing = "";
  }
  await writeFile(outPath, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${line}`);
}

const config = loadFeishuConfig(process.env);
const transport = createFeishuTransport({ config, log: () => {}, onEvent: async () => {} });
let attempts = 0;
const messageIds = [];
const sendMessage = async (request) => {
  attempts += 1;
  const response = await transport.send(request);
  messageIds.push(response.messageId);
  return response;
};

const coordinator = createDeliveryCoordinator({
  stateDir: join(stateRoot, "delivery"),
  env: {},
  now: () => new Date(),
  sendMessage,
  researchRunsDir: join(stateRoot, "runs"),
  limits: { maxAttempts: 3, retryDelayMs: 0 },
});
const runId = timestampRunId();
const summary = await coordinator.deliverRun({
  runId,
  researchStatus: "failed",
  triggerStatus: "failed",
  schedule: {
    scheduleId: "live-failure-probe",
    name: "AGT-033 failure isolation probe",
    deliveryTargets: [{ type: "open_id", id: UNREACHABLE_OPEN_ID, label: "不可达测试目标" }],
  },
});
const target = summary.targets[0];
const verified =
  target?.status === "failed" &&
  target?.attempts === 1 &&
  attempts === 1 &&
  messageIds.length === 0 &&
  target?.lastError?.feishuCode === 99992351 &&
  target?.lastError?.retryable === false;
const entry = {
  evidence: "agt-033-live-delivery",
  scenario: "failure_isolation_reprobe_after_sdk_business_error_fix",
  generatedAt: new Date().toISOString(),
  codeCommit,
  injectedDestination: { type: "open_id", maskedId: maskId(UNREACHABLE_OPEN_ID) },
  status: target?.status ?? null,
  attempts: target?.attempts ?? null,
  sendCalls: attempts,
  createdMessages: messageIds.length,
  errorCode: target?.lastError?.code ?? null,
  feishuCode: target?.lastError?.feishuCode ?? null,
  retryable: target?.lastError?.retryable ?? null,
  note: "main live personal/group sends and idempotency evidence were produced before this classification fix; this probe re-checks only the failure path and sends no real message",
  verified,
};
await appendLine(entry);
console.log(
  `failure probe: status=${entry.status} attempts=${entry.attempts} feishuCode=${entry.feishuCode} retryable=${entry.retryable} createdMessages=${entry.createdMessages}`,
);
console.log(`appended to ${outPath}`);
assert.equal(verified, true, `failure classification re-probe failed: ${JSON.stringify(entry)}`);
assert.ok(!(target?.lastError?.message ?? "").includes(UNREACHABLE_OPEN_ID), "error message must not persist the raw id");
