import type { components } from "../../shared/agentera-cloud-api.generated";

export type OfficialAgentDeliveryVerificationStatus =
  components["schemas"]["OfficialAgentDeliveryVerificationStatus"];
export type OfficialAgentDeliveryVerificationErrorCode =
  components["schemas"]["OfficialAgentDeliveryVerificationErrorCode"];

export interface OfficialAgentDeliveryVerificationInput {
  definitionId: string;
  versionId: string;
  releaseRevisionId: string;
  contentDigest: string;
  verificationStatus: OfficialAgentDeliveryVerificationStatus;
  runtimeVersion: string;
  desktopVersion: string;
  occurredAt: string;
  requestId: string;
  errorCode?: OfficialAgentDeliveryVerificationErrorCode;
}

export interface OfficialAgentDeliveryVerificationWire {
  definition_id: string;
  version_id: string;
  release_revision_id: string;
  content_digest: string;
  verification_status: OfficialAgentDeliveryVerificationStatus;
  runtime_version: string;
  desktop_version: string;
  occurred_at: string;
  request_id: string;
  error_code?: OfficialAgentDeliveryVerificationErrorCode;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN =
  /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ERROR_CODES = new Set<OfficialAgentDeliveryVerificationErrorCode>([
  "catalog_unavailable",
  "invalid_response",
  "signature_verification_failed",
  "runtime_incompatible",
  "content_digest_mismatch",
  "installation_failed",
  "activation_failed",
  "cloud_unavailable",
]);
const STATUSES = new Set<OfficialAgentDeliveryVerificationStatus>([
  "catalog_visible",
  "signature_verified",
  "compatible",
  "installed",
  "activated",
  "failed",
]);

function requireUUID(value: string, field: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value) || value !== value.toLowerCase()) {
    throw new Error(`invalid ${field}`);
  }
}

function requireVersion(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length < 5 ||
    value.length > 128 ||
    !VERSION_PATTERN.test(value)
  ) {
    throw new Error(`invalid ${field}`);
  }
}

export function serializeOfficialAgentDeliveryVerification(
  input: OfficialAgentDeliveryVerificationInput,
): OfficialAgentDeliveryVerificationWire {
  requireUUID(input.definitionId, "definition_id");
  requireUUID(input.versionId, "version_id");
  requireUUID(input.releaseRevisionId, "release_revision_id");
  requireUUID(input.requestId, "request_id");
  if (!DIGEST_PATTERN.test(input.contentDigest)) {
    throw new Error("invalid content_digest");
  }
  if (!STATUSES.has(input.verificationStatus)) {
    throw new Error("invalid verification_status");
  }
  requireVersion(input.runtimeVersion, "runtime_version");
  requireVersion(input.desktopVersion, "desktop_version");
  if (
    typeof input.occurredAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(input.occurredAt) ||
    !Number.isFinite(new Date(input.occurredAt).getTime())
  ) {
    throw new Error("invalid occurred_at");
  }
  if (input.verificationStatus === "failed") {
    if (!input.errorCode || !ERROR_CODES.has(input.errorCode)) {
      throw new Error("invalid error_code");
    }
  } else if (input.errorCode !== undefined) {
    throw new Error("invalid error_code");
  }
  return {
    definition_id: input.definitionId,
    version_id: input.versionId,
    release_revision_id: input.releaseRevisionId,
    content_digest: input.contentDigest,
    verification_status: input.verificationStatus,
    runtime_version: input.runtimeVersion,
    desktop_version: input.desktopVersion,
    occurred_at: input.occurredAt,
    request_id: input.requestId,
    ...(input.errorCode === undefined ? {} : { error_code: input.errorCode }),
  };
}
