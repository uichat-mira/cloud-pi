const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/;
const CHALLENGE_PATTERN = /^[a-f0-9]{32}$/;

const REPORT_KIND_BY_STATUS = Object.freeze({
  completed: "report",
  completed_with_errors: "report_partial",
});

/**
 * Bind a private-chat sender to a one-time value shown only in the operator's
 * local terminal. An arbitrary message during the observation window is not
 * sufficient evidence that the sender is the intended recipient.
 */
export function matchesPrivateMessageChallenge(event, challenge, botOpenId) {
  if (typeof challenge !== "string" || !CHALLENGE_PATTERN.test(challenge)) return false;
  if (event?.chatType !== "p2p" || event?.senderType !== "user") return false;

  const senderOpenId = event?.senderOpenId;
  if (typeof senderOpenId !== "string" || !OPEN_ID_PATTERN.test(senderOpenId)) return false;
  if (senderOpenId === botOpenId) return false;

  return typeof event?.text === "string" && event.text.trim() === challenge;
}

/**
 * Project a delivery summary into repository-safe evidence. Feishu message ids,
 * raw destination ids, segment receipts and provider error messages are omitted.
 */
export function sanitizeDeliveryEvidence(delivery) {
  if (!delivery || typeof delivery !== "object") return null;

  const counts = delivery.counts && typeof delivery.counts === "object"
    ? {
        total: delivery.counts.total ?? null,
        sent: delivery.counts.sent ?? null,
        failed: delivery.counts.failed ?? null,
        pending: delivery.counts.pending ?? null,
      }
    : null;

  const targets = Array.isArray(delivery.targets)
    ? delivery.targets.map((target) => ({
        destination: {
          type: target?.destination?.type ?? null,
          maskedId: target?.destination?.maskedId ?? null,
        },
        status: target?.status ?? null,
        attempts: target?.attempts ?? null,
        deliveryKind: target?.deliveryKind ?? null,
        sentAt: target?.sentAt ?? null,
        lastError: target?.lastError
          ? {
              code: target.lastError.code ?? null,
              feishuCode: target.lastError.feishuCode ?? null,
            }
          : null,
      }))
    : [];

  return {
    runId: delivery.runId ?? null,
    researchStatus: delivery.researchStatus ?? null,
    triggerStatus: delivery.triggerStatus ?? null,
    deliveryStatus: delivery.deliveryStatus ?? null,
    counts,
    targets,
  };
}

/**
 * A collaboration evidence run is successful only when a real report (clean or
 * partial) was accepted by every exact resolved target and the API readback
 * agrees. A timeout/status notice is not a report-delivery success.
 */
export function isSuccessfulCollaborationEvidence({
  statusCode,
  statusBody,
  deliveryStatusCode,
  deliveryBody,
  expectedTargets,
  sendCallsBefore,
  sendCallsAfter,
  runId,
} = {}) {
  const delivery = deliveryBody?.data?.delivery;
  if (statusCode !== 200 || statusBody?.data?.capabilities?.deliveryStatus !== true) return false;
  if (deliveryStatusCode !== 200 || !delivery || delivery.runId !== runId) return false;
  if (sendCallsBefore !== sendCallsAfter) return false;
  if (!Array.isArray(expectedTargets) || expectedTargets.length === 0) return false;
  if (!Array.isArray(delivery.targets) || delivery.targets.length !== expectedTargets.length) return false;

  const expectedKind = REPORT_KIND_BY_STATUS[delivery.researchStatus];
  if (!expectedKind || delivery.deliveryStatus !== "sent") return false;

  const destinationKey = (destination) => {
    if (
      typeof destination?.type !== "string" ||
      typeof destination?.maskedId !== "string" ||
      !destination.maskedId
    ) return null;
    return destination.type + ":" + destination.maskedId;
  };

  const expectedKeys = expectedTargets.map(destinationKey);
  const actualKeys = delivery.targets.map((target) => destinationKey(target?.destination));
  if (expectedKeys.some((key) => key === null) || actualKeys.some((key) => key === null)) return false;

  const expectedSet = new Set(expectedKeys);
  const actualSet = new Set(actualKeys);
  if (expectedSet.size !== expectedKeys.length || actualSet.size !== actualKeys.length) return false;
  if (expectedSet.size !== actualSet.size || [...expectedSet].some((key) => !actualSet.has(key))) return false;

  const counts = delivery.counts;
  if (
    counts?.total !== expectedTargets.length ||
    counts?.sent !== expectedTargets.length ||
    counts?.failed !== 0 ||
    counts?.pending !== 0
  ) return false;

  return delivery.targets.every((target) =>
    target.status === "sent" &&
    target.deliveryKind === expectedKind &&
    Number.isSafeInteger(target.attempts) &&
    target.attempts > 0
  );
}
