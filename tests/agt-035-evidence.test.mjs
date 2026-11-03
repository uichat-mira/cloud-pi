import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSuccessfulCollaborationEvidence,
  matchesPrivateMessageChallenge,
  sanitizeDeliveryEvidence,
} from "../scripts/agt-035/evidence-contract.mjs";

const CHALLENGE = "a".repeat(32);
const BOT = "ou_bot00000001";
const SENDER = "ou_sender000001";
const RUN_ID = "r-20261103T144533-45fd00";
const EXPECTED_TARGETS = [
  { type: "chat_id", maskedId: "oc_09e…5daf" },
  { type: "open_id", maskedId: "ou_f7a…81a5" },
];

function event(overrides = {}) {
  return {
    chatType: "p2p",
    senderType: "user",
    senderOpenId: SENDER,
    text: CHALLENGE,
    ...overrides,
  };
}

function validEvidence(researchStatus = "completed_with_errors") {
  const deliveryKind = researchStatus === "completed" ? "report" : "report_partial";
  const targets = EXPECTED_TARGETS.map((destination) => ({
    destination,
    status: "sent",
    attempts: 1,
    deliveryKind,
  }));
  return {
    statusCode: 200,
    statusBody: { data: { capabilities: { deliveryStatus: true } } },
    deliveryStatusCode: 200,
    deliveryBody: {
      data: {
        delivery: {
          runId: RUN_ID,
          researchStatus,
          deliveryStatus: "sent",
          counts: { total: 2, sent: 2, failed: 0, pending: 0 },
          targets,
        },
      },
    },
    expectedTargets: EXPECTED_TARGETS,
    sendCallsBefore: 4,
    sendCallsAfter: 4,
    runId: RUN_ID,
  };
}

test("one-time challenge accepts only the exact p2p user event from a real open_id", () => {
  assert.equal(matchesPrivateMessageChallenge(event(), CHALLENGE, BOT), true);
  assert.equal(matchesPrivateMessageChallenge(event({ text: "hello" }), CHALLENGE, BOT), false);
  assert.equal(matchesPrivateMessageChallenge(event({ chatType: "group" }), CHALLENGE, BOT), false);
  assert.equal(matchesPrivateMessageChallenge(event({ senderType: "app" }), CHALLENGE, BOT), false);
  assert.equal(matchesPrivateMessageChallenge(event({ senderOpenId: "oc_not_a_person" }), CHALLENGE, BOT), false);
  assert.equal(matchesPrivateMessageChallenge(event({ senderOpenId: BOT }), CHALLENGE, BOT), false);
  assert.equal(matchesPrivateMessageChallenge(event(), "not-a-random-challenge", BOT), false);
});

test("a clean completed report is a successful delivery", () => {
  assert.equal(isSuccessfulCollaborationEvidence(validEvidence("completed")), true);
});

test("a completed_with_errors report is successful only as report_partial", () => {
  assert.equal(isSuccessfulCollaborationEvidence(validEvidence("completed_with_errors")), true);
});

test("a sent timeout/status notice is not a successful report delivery", () => {
  const input = validEvidence("completed_with_errors");
  input.deliveryBody.data.delivery.researchStatus = "timeout";
  input.deliveryBody.data.delivery.targets.forEach((target) => {
    target.deliveryKind = "status";
  });
  assert.equal(isSuccessfulCollaborationEvidence(input), false);
});

test("success requires both API surfaces and the exact run id", () => {
  const missingCapability = validEvidence();
  missingCapability.statusBody.data.capabilities.deliveryStatus = false;
  assert.equal(isSuccessfulCollaborationEvidence(missingCapability), false);

  const wrongRun = validEvidence();
  wrongRun.deliveryBody.data.delivery.runId = "r-another-run";
  assert.equal(isSuccessfulCollaborationEvidence(wrongRun), false);

  const missingApi = validEvidence();
  missingApi.deliveryStatusCode = 404;
  assert.equal(isSuccessfulCollaborationEvidence(missingApi), false);
});

test("success requires every exact target to have a sent report receipt", () => {
  const wrongTarget = validEvidence();
  wrongTarget.deliveryBody.data.delivery.targets[0].destination = {
    type: "chat_id",
    maskedId: "oc_some-other",
  };
  assert.equal(isSuccessfulCollaborationEvidence(wrongTarget), false);

  const failedTarget = validEvidence();
  failedTarget.deliveryBody.data.delivery.targets[1].status = "failed";
  assert.equal(isSuccessfulCollaborationEvidence(failedTarget), false);

  const wrongKind = validEvidence();
  wrongKind.deliveryBody.data.delivery.targets[1].deliveryKind = "status";
  assert.equal(isSuccessfulCollaborationEvidence(wrongKind), false);
});

test("success requires exact aggregate counts and an idempotent replay", () => {
  const badCounts = validEvidence();
  badCounts.deliveryBody.data.delivery.counts.pending = 1;
  assert.equal(isSuccessfulCollaborationEvidence(badCounts), false);

  const replaySentAgain = validEvidence();
  replaySentAgain.sendCallsAfter += 1;
  assert.equal(isSuccessfulCollaborationEvidence(replaySentAgain), false);
});

test("evidence projection omits raw ids and provider error text", () => {
  const safe = sanitizeDeliveryEvidence({
    runId: RUN_ID,
    messageId: "om_raw_message",
    counts: { total: 1, sent: 1, failed: 0, pending: 0 },
    targets: [{
      destination: { type: "chat_id", id: "oc_raw_destination", maskedId: "oc_masked" },
      status: "sent",
      attempts: 1,
      deliveryKind: "report_partial",
      messageId: "om_raw_message",
      messageIds: ["om_segment_1", "om_segment_2"],
      segmentsSent: [{ messageId: "om_segment_1" }],
      lastError: { code: "x", feishuCode: 1, message: "provider detail" },
    }],
  });
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes("om_raw_message"), false);
  assert.equal(serialized.includes("om_segment"), false);
  assert.equal(serialized.includes("oc_raw_destination"), false);
  assert.equal(serialized.includes("provider detail"), false);
  assert.equal(safe.targets[0].destination.maskedId, "oc_masked");
});
