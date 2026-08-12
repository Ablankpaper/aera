// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  serializeOfficialAgentDeliveryVerification,
  type OfficialAgentDeliveryVerificationInput,
} from "./verification-receipt";

const BASE: OfficialAgentDeliveryVerificationInput = {
  definitionId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  releaseRevisionId: "33333333-3333-4333-8333-333333333333",
  contentDigest: "ab".repeat(32),
  verificationStatus: "activated",
  runtimeVersion: "v0.18.2-agentera.1",
  desktopVersion: "v0.24.0",
  occurredAt: "2026-08-12T10:00:00.000Z",
  requestId: "44444444-4444-4444-8444-444444444444",
};

describe("official Agent delivery verification receipt", () => {
  it("serializes only the approved metadata fields", () => {
    const receipt = serializeOfficialAgentDeliveryVerification(BASE);

    expect(receipt).toEqual({
      definition_id: BASE.definitionId,
      version_id: BASE.versionId,
      release_revision_id: BASE.releaseRevisionId,
      content_digest: BASE.contentDigest,
      verification_status: BASE.verificationStatus,
      runtime_version: BASE.runtimeVersion,
      desktop_version: BASE.desktopVersion,
      occurred_at: BASE.occurredAt,
      request_id: BASE.requestId,
    });
    expect(receipt).not.toHaveProperty("prompt");
    expect(receipt).not.toHaveProperty("bundle");
    expect(receipt).not.toHaveProperty("local_path");
    expect(receipt).not.toHaveProperty("token");
    expect(receipt).not.toHaveProperty("logs");
  });

  it("includes only a stable redacted error code for failed verification", () => {
    const receipt = serializeOfficialAgentDeliveryVerification({
      ...BASE,
      verificationStatus: "failed",
      errorCode: "signature_verification_failed",
    });

    expect(receipt.error_code).toBe("signature_verification_failed");
    expect(() =>
      serializeOfficialAgentDeliveryVerification({
        ...BASE,
        verificationStatus: "failed",
        errorCode: "raw: /Users/alice/private/prompt.txt" as never,
      }),
    ).toThrow("invalid");
  });
});
