import { expect, test } from "playwright/test";

import {
  createOfficialQualityE2EHarness,
  type OfficialQualityE2EHarness,
} from "./support/agentera-official-quality-harness";

const PUBLIC_EVENT_FIELDS = [
  "binding_proof",
  "consent_version",
  "crash_code",
  "definition_id",
  "desktop_version",
  "device_signature",
  "event_day",
  "event_id",
  "feedback_rating",
  "feedback_reason_codes",
  "kind",
  "latency_bucket",
  "platform_id",
  "protocol_version",
  "release_id",
  "release_revision_id",
  "result",
  "runtime_version",
  "total_token_bucket",
  "version_id",
] as const;

let harness: OfficialQualityE2EHarness;

test.beforeEach(() => {
  harness = createOfficialQualityE2EHarness();
});

test.afterEach(() => {
  harness.close();
});

test("default-off consent emits no quality request or local outbox row", async () => {
  const result = harness.completeSuccessfulTurn(harness.v1Binding, {
    latencyMilliseconds: 1_250,
    totalTokens: 700,
  });

  expect(result.chatCompleted).toBe(true);
  expect(result.feedbackEligibility).toBeNull();
  await harness.flush();
  expect(harness.cloud.eventBodies).toEqual([]);
  expect(harness.outboxCount()).toBe(0);
});

test("passive consent uploads only one minimized terminal success envelope", async () => {
  await harness.setPassiveConsent(true);
  const result = harness.completeSuccessfulTurn(harness.v1Binding, {
    latencyMilliseconds: 6_000,
    totalTokens: 4_500,
  });

  expect(result.chatCompleted).toBe(true);
  await harness.flush();
  expect(harness.cloud.eventBodies).toHaveLength(1);
  const event = harness.cloud.eventBodies[0];
  expect(Object.keys(event).sort()).toEqual([...PUBLIC_EVENT_FIELDS].sort());
  expect(event).toMatchObject({
    kind: "metric",
    result: "success",
    latency_bucket: "5s_15s",
    total_token_bucket: "4k_16k",
    version_id: harness.v1Binding.agentVersionId,
    release_revision_id: harness.v1Binding.officialReleaseRevisionId,
    binding_proof: harness.v1Binding.id,
  });
  expect(JSON.stringify(event)).not.toMatch(
    /prompt|response|reasoning|raw_error|stack|memory|session|conversation|profile|installation|attachment/iu,
  );
  expect(harness.outboxCount()).toBe(0);
});

test("explicit feedback is independently off, then sends only fixed rating and reason codes", async () => {
  const disabled = harness.completeSuccessfulTurn(harness.v1Binding);
  expect(disabled.feedbackEligibility).toBeNull();
  await expect(
    harness.submitFeedback({
      eventId: harness.unusedEventId,
      rating: "not_helpful",
      reasonCodes: ["incorrect"],
    }),
  ).rejects.toThrow(/eligible/i);

  await harness.setExplicitFeedbackConsent(true);
  const enabled = harness.completeSuccessfulTurn(harness.v1Binding);
  expect(enabled.feedbackEligibility).not.toBeNull();
  await harness.submitFeedback({
    eventId: enabled.feedbackEligibility!.eventId,
    rating: "not_helpful",
    reasonCodes: ["incorrect", "tool_failed"],
  });
  await harness.flush();

  expect(harness.cloud.eventBodies).toHaveLength(1);
  expect(harness.cloud.eventBodies[0]).toMatchObject({
    kind: "explicit_feedback",
    feedback_rating: "not_helpful",
    feedback_reason_codes: ["incorrect", "tool_failed"],
  });
  expect(JSON.stringify(harness.cloud.eventBodies[0])).not.toContain("note");
});

test("quality network failure never changes chat completion and remains retryable", async () => {
  await harness.setPassiveConsent(true);
  harness.cloud.failEventUploads = true;

  expect(() =>
    harness.completeSuccessfulTurn(harness.v1Binding, {
      latencyMilliseconds: 900,
      totalTokens: 15,
    }),
  ).not.toThrow();
  await expect(harness.flush()).resolves.toBeUndefined();
  expect(harness.outboxCount()).toBe(1);
  expect(harness.cloud.eventAttempts).toBe(1);
});

test("new v2 binding uses v2 provenance while an existing v1 binding stays fixed", async () => {
  await harness.setPassiveConsent(true);
  const originalV1 = structuredClone(harness.v1Binding);

  harness.completeSuccessfulTurn(harness.v1Binding);
  await harness.flush();
  harness.advancePastRetryWindow();
  harness.completeSuccessfulTurn(harness.v2Binding);
  await harness.flush();
  harness.advancePastRetryWindow();
  harness.completeSuccessfulTurn(harness.v1Binding);
  await harness.flush();

  expect(harness.v1Binding).toEqual(originalV1);
  expect(
    harness.cloud.eventBodies.map((event) => ({
      bindingProof: event.binding_proof,
      releaseRevisionId: event.release_revision_id,
      versionId: event.version_id,
    })),
  ).toEqual([
    {
      bindingProof: harness.v1Binding.id,
      releaseRevisionId: harness.v1Binding.officialReleaseRevisionId,
      versionId: harness.v1Binding.agentVersionId,
    },
    {
      bindingProof: harness.v2Binding.id,
      releaseRevisionId: harness.v2Binding.officialReleaseRevisionId,
      versionId: harness.v2Binding.agentVersionId,
    },
    {
      bindingProof: harness.v1Binding.id,
      releaseRevisionId: harness.v1Binding.officialReleaseRevisionId,
      versionId: harness.v1Binding.agentVersionId,
    },
  ]);
});
