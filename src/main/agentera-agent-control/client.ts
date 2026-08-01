import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify as verifySignature,
} from "node:crypto";
import type { components } from "../../shared/agentera-cloud-api.generated";
import type {
  AgenteraAgentControlContext,
  ExperienceCandidateBundleV1,
  OfficialAgentSummary,
  OfficialManagedUpdate,
} from "../../shared/agentera-agent-control";
import {
  agenteraCloudUrl,
  parseAgenteraCloudOrigin,
} from "../agentera-auth/config";
import type { InstallationIdentity } from "../agentera-auth/store";
import { canonicalizeExperienceCandidate } from "./experience-candidate-contract";
import type { OfficialAgentChannel } from "./official-channel";

const DEFAULT_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const KEY_RESPONSE_LIMIT = 256 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type AgentDefinition = components["schemas"]["AgentDefinition"];
export type AgentVersion = components["schemas"]["AgentVersion"];
export type AgentPolicySnapshot = components["schemas"]["AgentPolicySnapshot"];
export type AgentInstallation = components["schemas"]["AgentInstallation"];
export type AgentPublication = components["schemas"]["AgentPublication"];
export type AgentInstallationCreation =
  components["schemas"]["AgentInstallationCreation"];
export type AgentVersionRevocation =
  components["schemas"]["AgentVersionRevocation"];
export type RuntimeBindingRecord =
  components["schemas"]["RuntimeBindingRecord"];
export type AgentSigningKeySet = components["schemas"]["SigningKeySet"];
export type PublishInitialAgentRequest =
  components["schemas"]["PublishInitialAgentRequest"];
export type PublishNextAgentVersionRequest =
  components["schemas"]["PublishNextAgentVersionRequest"];
export type RevokeAgentVersionRequest =
  components["schemas"]["RevokeAgentVersionRequest"];
export type CreateAgentInstallationRequest =
  components["schemas"]["CreateAgentInstallationRequest"];
export type CreateRuntimeBindingRecordRequest =
  components["schemas"]["CreateRuntimeBindingRecordRequest"];
export type CloudExperienceCandidateBundle =
  components["schemas"]["ExperienceCandidateBundle"];
export type CloudExperienceCandidateSummary =
  components["schemas"]["ExperienceCandidateSummary"];
export type CloudExperienceCandidateDetail =
  components["schemas"]["ExperienceCandidateDetail"];
export type CloudExperienceCandidateReview =
  components["schemas"]["ExperienceCandidateReview"];
export type CloudExperienceCandidateFinding =
  components["schemas"]["ExperienceCandidateFinding"];
export type SubmitExperienceCandidateRequest =
  components["schemas"]["SubmitExperienceCandidateRequest"];
export type ReviewExperienceCandidateRequest =
  components["schemas"]["ReviewExperienceCandidateRequest"];
export type SubmitOrganizationAgentRequest =
  components["schemas"]["SubmitOrganizationAgentRequest"];
export type ReviewOrganizationAgentRequest =
  components["schemas"]["ReviewOrganizationAgentRequest"];
export type OrganizationAgentReviewRecord =
  components["schemas"]["OrganizationAgentReview"];
export type OrganizationAgentSubmissionRecord =
  components["schemas"]["OrganizationAgentSubmission"];
export type OrganizationAgentSubmissionDetailRecord =
  components["schemas"]["OrganizationAgentSubmissionDetail"];
type WireOfficialAgentSummary = components["schemas"]["OfficialAgentSummary"];
type WireOfficialAgentDetail = components["schemas"]["OfficialAgentDetail"];
type WireOfficialManagedUpdateResponse =
  components["schemas"]["OfficialManagedUpdateResponse"];

type StableErrorCode =
  | components["schemas"]["ErrorCode"]
  | components["schemas"]["ExperienceCandidateErrorCode"]
  | components["schemas"]["OrganizationAgentErrorCode"];

const STABLE_ERROR_CODES: ReadonlySet<string> = new Set<StableErrorCode>([
  "invalid_request",
  "verification_required",
  "identity_conflict",
  "invalid_credentials",
  "device_limit_reached",
  "authorization_expired",
  "authorization_replayed",
  "session_revoked",
  "account_pending_deletion",
  "account_disabled",
  "last_identity",
  "deletion_window_expired",
  "account_not_found",
  "device_not_found",
  "self_revoke_replayed",
  "invalid_agent_content",
  "runtime_incompatible",
  "invalid_device_proof",
  "not_found",
  "version_conflict",
  "idempotency_conflict",
  "definition_archived",
  "version_revoked",
  "activation_conflict",
  "installation_archived",
  "invitation_limit_reached",
  "invitation_unavailable",
  "member_limit_reached",
  "membership_conflict",
  "service_unavailable",
  "workspace_archived",
  "workspace_conflict",
  "workspace_forbidden",
  "workspace_limit_reached",
  "workspace_not_found",
  "workspace_owner_unavailable",
  "invalid_experience_candidate",
  "candidate_dlp_blocked",
  "candidate_already_reviewed",
  "organization_agent_not_found",
  "organization_agent_forbidden",
  "organization_archived",
  "organization_submission_conflict",
  "organization_submission_superseded",
  "organization_publication_policy_blocked",
  "organization_publication_dlp_blocked",
  "official_agent_not_eligible",
  "official_release_paused",
  "official_release_revision_conflict",
  "official_client_version_unsupported",
  "official_installation_policy_blocked",
  "official_managed_update_conflict",
  "cloud_unavailable",
  "rate_limited",
]);

export interface AgenteraAgentControlClientOptions {
  origin: string;
  getAccessToken: () => string | null;
  getInstallationIdentity: () => InstallationIdentity | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  officialAgentChannel?: OfficialAgentChannel;
  desktopVersion?: string;
  getAgentContext?: () => AgenteraAgentControlContext;
}

export class AgenteraAgentControlClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly findings: readonly CloudExperienceCandidateFinding[];

  constructor(
    status: number,
    code: string,
    findings: readonly CloudExperienceCandidateFinding[] = [],
  ) {
    super(`Aera Agent control request failed: ${code}.`);
    this.name = "AgenteraAgentControlClientError";
    this.status = status;
    this.code = code;
    this.findings = findings.map((finding) => ({
      code: finding.code,
      path: finding.path,
      ...(finding.line === undefined ? {} : { line: finding.line }),
    }));
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
  authenticated?: boolean;
  responseLimit?: number;
  official?: boolean;
  expectedStatus: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    keys.every((field) => allowed.has(field))
  );
}

function isUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isCanonicalUUID(value: unknown): value is string {
  return isUUID(value) && value === value.toLowerCase();
}

function isDesktopVersion(value: unknown): value is string {
  return (
    isBoundedString(value, 5, 128) &&
    /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      value,
    )
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    Number.isFinite(new Date(value).getTime())
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    isTimestamp(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  );
}

function isBoundedString(
  value: unknown,
  minimum = 1,
  maximum = 4096,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 512 &&
    value.every((item) => isBoundedString(item, 1, 512))
  );
}

function isExperienceCandidatePath(value: unknown): value is string {
  if (
    !isBoundedString(value, 1, 512) ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("://") ||
    (value.length >= 2 && value[1] === ":") ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.startsWith("."),
  );
}

function isExperienceCandidateBundle(
  value: unknown,
): value is CloudExperienceCandidateBundle {
  if (
    !hasExactFields(value, ["assets", "schema_version", "skill_name"]) ||
    value.schema_version !== 1 ||
    !isBoundedString(value.skill_name, 1, 100) ||
    !/^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/.test(value.skill_name) ||
    !Array.isArray(value.assets) ||
    value.assets.length < 1 ||
    value.assets.length > 32
  ) {
    return false;
  }
  let totalBytes = 0;
  const assets: ExperienceCandidateBundleV1["assets"] = [];
  for (const asset of value.assets) {
    if (
      !hasExactFields(asset, ["content", "media_type", "path"]) ||
      !isExperienceCandidatePath(asset.path) ||
      (asset.media_type !== "text/markdown" &&
        asset.media_type !== "text/plain") ||
      typeof asset.content !== "string"
    ) {
      return false;
    }
    const bytes = Buffer.byteLength(asset.content, "utf8");
    if (bytes > 262_144) return false;
    totalBytes += bytes;
    if (totalBytes > 1024 * 1024) return false;
    assets.push({
      path: asset.path,
      mediaType: asset.media_type,
      content: asset.content,
    });
  }
  const candidate: ExperienceCandidateBundleV1 = {
    schemaVersion: 1,
    skillName: value.skill_name,
    assets,
  };
  try {
    const canonical = canonicalizeExperienceCandidate(candidate);
    return JSON.stringify(canonical.bundle) === JSON.stringify(candidate);
  } catch {
    return false;
  }
}

function isExperienceCandidateReview(
  value: unknown,
): value is CloudExperienceCandidateReview {
  if (
    !hasExactFields(
      value,
      ["decision", "id", "reviewed_at", "reviewed_by_user_id"],
      ["reason_code", "safe_note"],
    ) ||
    !isUUID(value.id) ||
    (value.reviewed_by_user_id !== null &&
      !isUUID(value.reviewed_by_user_id)) ||
    (value.decision !== "APPROVED" && value.decision !== "REJECTED") ||
    !isTimestamp(value.reviewed_at)
  ) {
    return false;
  }
  if (value.decision === "APPROVED") {
    return value.reason_code === undefined && value.safe_note === undefined;
  }
  return (
    typeof value.reason_code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(value.reason_code) &&
    (value.safe_note === undefined ||
      (isBoundedString(value.safe_note, 1, 240) &&
        !/[\r\n\0]/.test(value.safe_note)))
  );
}

function isExperienceCandidateCore(value: unknown): boolean {
  return (
    isObject(value) &&
    isUUID(value.id) &&
    isUUID(value.workspace_id) &&
    isUUID(value.agent_definition_id) &&
    isUUID(value.source_agent_version_id) &&
    (value.submitted_by_user_id === null ||
      isUUID(value.submitted_by_user_id)) &&
    isBoundedString(value.skill_name, 1, 100) &&
    /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/.test(value.skill_name) &&
    value.dlp_contract_version === "experience-candidate-dlp-v1" &&
    isDigest(value.content_digest) &&
    isTimestamp(value.created_at) &&
    (value.review === undefined || isExperienceCandidateReview(value.review))
  );
}

function isExperienceCandidateSummary(
  value: unknown,
): value is CloudExperienceCandidateSummary {
  return (
    hasExactFields(
      value,
      [
        "agent_definition_id",
        "content_digest",
        "created_at",
        "dlp_contract_version",
        "id",
        "skill_name",
        "source_agent_version_id",
        "submitted_by_user_id",
        "workspace_id",
      ],
      ["review"],
    ) && isExperienceCandidateCore(value)
  );
}

function isExperienceCandidateDetail(
  value: unknown,
): value is CloudExperienceCandidateDetail {
  return (
    hasExactFields(
      value,
      [
        "agent_definition_id",
        "bundle",
        "content_digest",
        "created_at",
        "dlp_contract_version",
        "id",
        "skill_name",
        "source_agent_version_id",
        "submitted_by_user_id",
        "workspace_id",
      ],
      ["review"],
    ) &&
    isExperienceCandidateCore(value) &&
    isExperienceCandidateBundle(value.bundle) &&
    value.bundle.skill_name === value.skill_name
  );
}

function isExperienceCandidateFinding(
  value: unknown,
): value is CloudExperienceCandidateFinding {
  return (
    hasExactFields(value, ["code", "path"], ["line"]) &&
    typeof value.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(value.code) &&
    isExperienceCandidatePath(value.path) &&
    (value.line === undefined ||
      (Number.isSafeInteger(value.line) && Number(value.line) >= 1))
  );
}

function isSubmitExperienceCandidateRequest(
  value: unknown,
): value is SubmitExperienceCandidateRequest {
  return (
    hasExactFields(value, ["bundle", "content_digest", "source_version_id"]) &&
    isUUID(value.source_version_id) &&
    isDigest(value.content_digest) &&
    isExperienceCandidateBundle(value.bundle)
  );
}

function isReviewExperienceCandidateRequest(
  value: unknown,
): value is ReviewExperienceCandidateRequest {
  if (
    !hasExactFields(value, ["decision"], ["reason_code", "safe_note"]) ||
    (value.decision !== "APPROVED" && value.decision !== "REJECTED")
  ) {
    return false;
  }
  if (value.decision === "APPROVED") {
    return value.reason_code === undefined && value.safe_note === undefined;
  }
  return (
    typeof value.reason_code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(value.reason_code) &&
    (value.safe_note === undefined ||
      (isBoundedString(value.safe_note, 1, 240) &&
        !/[\r\n\0]/.test(value.safe_note)))
  );
}

function detachExperienceCandidateReview(
  value: CloudExperienceCandidateReview,
): CloudExperienceCandidateReview {
  return {
    id: value.id,
    reviewed_by_user_id: value.reviewed_by_user_id,
    decision: value.decision,
    ...(value.reason_code === undefined
      ? {}
      : { reason_code: value.reason_code }),
    ...(value.safe_note === undefined ? {} : { safe_note: value.safe_note }),
    reviewed_at: value.reviewed_at,
  };
}

function detachExperienceCandidateSummary(
  value: CloudExperienceCandidateSummary,
): CloudExperienceCandidateSummary {
  return {
    id: value.id,
    workspace_id: value.workspace_id,
    agent_definition_id: value.agent_definition_id,
    source_agent_version_id: value.source_agent_version_id,
    submitted_by_user_id: value.submitted_by_user_id,
    skill_name: value.skill_name,
    dlp_contract_version: value.dlp_contract_version,
    content_digest: value.content_digest,
    created_at: value.created_at,
    ...(value.review === undefined
      ? {}
      : { review: detachExperienceCandidateReview(value.review) }),
  };
}

function detachExperienceCandidateDetail(
  value: CloudExperienceCandidateDetail,
): CloudExperienceCandidateDetail {
  return {
    ...detachExperienceCandidateSummary(value),
    bundle: {
      schema_version: value.bundle.schema_version,
      skill_name: value.bundle.skill_name,
      assets: value.bundle.assets.map((asset) => ({
        path: asset.path,
        media_type: asset.media_type,
        content: asset.content,
      })),
    },
  };
}

function isRuntimeCompatibility(value: unknown): boolean {
  return (
    hasExactFields(value, ["minimum_version"], ["maximum_version_exclusive"]) &&
    isBoundedString(value.minimum_version, 1, 64) &&
    (value.maximum_version_exclusive === undefined ||
      value.maximum_version_exclusive === null ||
      isBoundedString(value.maximum_version_exclusive, 1, 64))
  );
}

function isModelConstraints(value: unknown): boolean {
  return (
    hasExactFields(value, ["allowed_models", "allowed_providers"]) &&
    isStringArray(value.allowed_models) &&
    value.allowed_models.length > 0 &&
    isStringArray(value.allowed_providers) &&
    value.allowed_providers.length > 0
  );
}

function isModelPolicy(value: unknown): boolean {
  if (
    !hasExactFields(value, ["allowed_models", "allowed_providers", "mode"]) ||
    !isStringArray(value.allowed_models) ||
    !isStringArray(value.allowed_providers)
  ) {
    return false;
  }
  switch (value.mode) {
    case "user_select":
      return (
        value.allowed_models.length === 0 &&
        value.allowed_providers.length === 0
      );
    case "allowlist":
      return (
        value.allowed_models.length > 0 && value.allowed_providers.length > 0
      );
    case "fixed":
      return (
        value.allowed_models.length === 1 &&
        value.allowed_providers.length === 1
      );
    default:
      return false;
  }
}

function isToolPolicy(value: unknown): boolean {
  return (
    hasExactFields(value, ["allowed", "denied"]) &&
    isStringArray(value.allowed) &&
    isStringArray(value.denied)
  );
}

function isManifest(value: unknown): boolean {
  if (!isObject(value)) return false;
  const modelField =
    value.schema_version === 1
      ? "model_constraints"
      : value.schema_version === 2
        ? "model_policy"
        : null;
  if (
    modelField === null ||
    !hasExactFields(value, [
      "assets",
      "dependencies",
      "identity",
      modelField,
      "runtime_compatibility",
      "schema_version",
      "tools",
    ]) ||
    !hasExactFields(value.identity, ["system_prompt"]) ||
    !isBoundedString(value.identity.system_prompt, 1, 262_144) ||
    (value.schema_version === 1
      ? !isModelConstraints(value.model_constraints)
      : !isModelPolicy(value.model_policy)) ||
    !isRuntimeCompatibility(value.runtime_compatibility) ||
    !isToolPolicy(value.tools) ||
    !Array.isArray(value.assets) ||
    value.assets.length > 128 ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 128
  ) {
    return false;
  }
  if (
    !value.assets.every(
      (asset) =>
        hasExactFields(asset, ["kind", "media_type", "path", "sha256"]) &&
        (asset.kind === "skill" ||
          asset.kind === "sop" ||
          asset.kind === "knowledge") &&
        (asset.media_type === "text/markdown" ||
          asset.media_type === "text/plain") &&
        isBoundedString(asset.path, 1, 512) &&
        isDigest(asset.sha256),
    )
  ) {
    return false;
  }
  return value.dependencies.every(
    (dependency) =>
      hasExactFields(dependency, ["agent_definition_id", "agent_version_id"]) &&
      isUUID(dependency.agent_definition_id) &&
      isUUID(dependency.agent_version_id),
  );
}

function isBundle(value: unknown): boolean {
  return (
    hasExactFields(value, ["assets"]) &&
    Array.isArray(value.assets) &&
    value.assets.length <= 128 &&
    value.assets.every(
      (asset) =>
        hasExactFields(asset, ["content", "path"]) &&
        typeof asset.content === "string" &&
        Buffer.byteLength(asset.content, "utf8") <= 262_144 &&
        isBoundedString(asset.path, 1, 512),
    )
  );
}

function isDefinition(value: unknown): value is AgentDefinition {
  if (
    !hasExactFields(
      value,
      ["created_at", "display_name", "id", "status", "updated_at"],
      ["icon_data", "icon_media_type", "latest_version_id"],
    ) ||
    !isUUID(value.id) ||
    !isBoundedString(value.display_name, 1, 100) ||
    (value.status !== "active" && value.status !== "archived") ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at) ||
    (value.latest_version_id !== undefined && !isUUID(value.latest_version_id))
  ) {
    return false;
  }
  const hasIconType = value.icon_media_type !== undefined;
  const hasIconData = value.icon_data !== undefined;
  return (
    hasIconType === hasIconData &&
    (!hasIconType ||
      ((value.icon_media_type === "image/png" ||
        value.icon_media_type === "image/webp") &&
        isBoundedString(value.icon_data, 1, 699_051) &&
        /^[A-Za-z0-9_-]+$/.test(value.icon_data)))
  );
}

function isVersion(value: unknown): value is AgentVersion {
  return (
    hasExactFields(
      value,
      [
        "bundle",
        "content_digest",
        "definition_id",
        "id",
        "manifest",
        "published_at",
        "runtime_minimum_version",
        "signature",
        "signing_key_id",
        "version_number",
      ],
      ["runtime_maximum_version_exclusive"],
    ) &&
    isUUID(value.id) &&
    isUUID(value.definition_id) &&
    Number.isSafeInteger(value.version_number) &&
    Number(value.version_number) > 0 &&
    isManifest(value.manifest) &&
    isBundle(value.bundle) &&
    isDigest(value.content_digest) &&
    isBoundedString(value.signing_key_id, 1, 128) &&
    typeof value.signature === "string" &&
    BASE64URL_SIGNATURE_PATTERN.test(value.signature) &&
    isBoundedString(value.runtime_minimum_version, 1, 64) &&
    (value.runtime_maximum_version_exclusive === undefined ||
      isBoundedString(value.runtime_maximum_version_exclusive, 1, 64)) &&
    isTimestamp(value.published_at)
  );
}

function isOfficialAgentSummary(
  value: unknown,
): value is WireOfficialAgentSummary {
  if (
    !hasExactFields(
      value,
      [
        "channel",
        "definition_id",
        "display_name",
        "installation_state",
        "official",
        "release_id",
        "release_revision_id",
        "runtime_minimum_version",
        "update_state",
        "version_id",
        "version_number",
      ],
      ["icon_data", "icon_media_type", "runtime_maximum_version_exclusive"],
    ) ||
    !isCanonicalUUID(value.definition_id) ||
    !isBoundedString(value.display_name, 1, 80) ||
    value.official !== true ||
    !isCanonicalUUID(value.version_id) ||
    !Number.isSafeInteger(value.version_number) ||
    Number(value.version_number) < 1 ||
    !isCanonicalUUID(value.release_id) ||
    !isCanonicalUUID(value.release_revision_id) ||
    (value.channel !== "internal" && value.channel !== "stable") ||
    !isBoundedString(value.runtime_minimum_version, 1, 128) ||
    (value.runtime_maximum_version_exclusive !== undefined &&
      !isBoundedString(value.runtime_maximum_version_exclusive, 1, 128)) ||
    (value.installation_state !== "not_installed" &&
      value.installation_state !== "installed") ||
    (value.update_state !== "current" &&
      value.update_state !== "update_available")
  ) {
    return false;
  }
  const hasIconType = value.icon_media_type !== undefined;
  const hasIconData = value.icon_data !== undefined;
  return (
    hasIconType === hasIconData &&
    (!hasIconType ||
      ((value.icon_media_type === "image/png" ||
        value.icon_media_type === "image/webp") &&
        isBoundedString(value.icon_data, 1, 699_051) &&
        /^[A-Za-z0-9_-]+$/.test(value.icon_data) &&
        Buffer.from(value.icon_data, "base64url").toString("base64url") ===
          value.icon_data))
  );
}

function detachOfficialAgentSummary(
  value: WireOfficialAgentSummary,
): OfficialAgentSummary {
  return {
    definitionId: value.definition_id,
    displayName: value.display_name,
    iconMediaType: value.icon_media_type ?? null,
    iconDataBase64Url: value.icon_data ?? null,
    versionId: value.version_id,
    versionNumber: value.version_number,
    releaseId: value.release_id,
    releaseRevisionId: value.release_revision_id,
    channel: value.channel,
    runtimeMinimumVersion: value.runtime_minimum_version,
    runtimeMaximumVersionExclusive:
      value.runtime_maximum_version_exclusive ?? null,
    installationState: value.installation_state,
    updateState: value.update_state,
  };
}

function isOfficialAgentDetail(
  value: unknown,
): value is WireOfficialAgentDetail {
  return (
    hasExactFields(value, ["agent", "version"]) &&
    isOfficialAgentSummary(value.agent) &&
    isVersion(value.version) &&
    isCanonicalUUID(value.version.id) &&
    isCanonicalUUID(value.version.definition_id) &&
    value.agent.definition_id === value.version.definition_id &&
    value.agent.version_id === value.version.id &&
    value.agent.version_number === value.version.version_number &&
    value.agent.runtime_minimum_version ===
      value.version.runtime_minimum_version &&
    (value.agent.runtime_maximum_version_exclusive ?? null) ===
      (value.version.runtime_maximum_version_exclusive ?? null)
  );
}

function isOfficialManagedUpdateResponse(
  value: unknown,
): value is WireOfficialManagedUpdateResponse {
  if (!isObject(value)) return false;
  if (value.update_available === false) {
    return hasExactFields(value, ["update_available"]);
  }
  return (
    value.update_available === true &&
    hasExactFields(
      value,
      [
        "expected_selected_release_revision_id",
        "installation_id",
        "runtime_minimum_version",
        "target_release_revision_id",
        "target_version_id",
        "update_available",
      ],
      ["runtime_maximum_version_exclusive"],
    ) &&
    isCanonicalUUID(value.installation_id) &&
    isCanonicalUUID(value.expected_selected_release_revision_id) &&
    isCanonicalUUID(value.target_release_revision_id) &&
    isCanonicalUUID(value.target_version_id) &&
    isBoundedString(value.runtime_minimum_version, 1, 128) &&
    (value.runtime_maximum_version_exclusive === undefined ||
      isBoundedString(value.runtime_maximum_version_exclusive, 1, 128))
  );
}

function isOfficialPolicyContext(value: unknown): boolean {
  return (
    hasExactFields(value, [
      "device_installation_id",
      "installation_id",
      "platform_id",
      "product_context_id",
      "product_scope",
      "release_id",
      "release_revision_id",
      "user_id",
    ]) &&
    isCanonicalUUID(value.device_installation_id) &&
    isCanonicalUUID(value.installation_id) &&
    isCanonicalUUID(value.platform_id) &&
    isCanonicalUUID(value.product_context_id) &&
    (value.product_scope === "USER" ||
      value.product_scope === "WORKSPACE" ||
      value.product_scope === "ORGANIZATION") &&
    isCanonicalUUID(value.release_id) &&
    isCanonicalUUID(value.release_revision_id) &&
    isCanonicalUUID(value.user_id)
  );
}

function isPolicyDocument(value: unknown): boolean {
  if (!isObject(value)) return false;
  const modelField =
    value.schema_version === 1
      ? "model_constraints"
      : value.schema_version === 2
        ? "model_policy"
        : null;
  return (
    modelField !== null &&
    hasExactFields(
      value,
      [
        "agent_definition_id",
        "agent_version_id",
        "deny_rules",
        modelField,
        "publication_allowed",
        "runtime_compatibility",
        "schema_version",
        "tools",
        "version_digest",
      ],
      ["official_context"],
    ) &&
    isUUID(value.agent_definition_id) &&
    isUUID(value.agent_version_id) &&
    isDigest(value.version_digest) &&
    (value.schema_version === 1
      ? isModelConstraints(value.model_constraints)
      : isModelPolicy(value.model_policy)) &&
    isToolPolicy(value.tools) &&
    isRuntimeCompatibility(value.runtime_compatibility) &&
    value.publication_allowed === false &&
    isStringArray(value.deny_rules) &&
    (value.official_context === undefined ||
      isOfficialPolicyContext(value.official_context))
  );
}

function isPolicy(value: unknown): value is AgentPolicySnapshot {
  return (
    hasExactFields(value, [
      "agent_version_id",
      "content_digest",
      "created_at",
      "document",
      "id",
      "installation_id",
      "issuer",
      "policy_version",
      "signature",
      "signing_key_id",
    ]) &&
    isUUID(value.id) &&
    isUUID(value.installation_id) &&
    isUUID(value.agent_version_id) &&
    Number.isSafeInteger(value.policy_version) &&
    Number(value.policy_version) > 0 &&
    isPolicyDocument(value.document) &&
    isDigest(value.content_digest) &&
    isBoundedString(value.issuer, 1, 2048) &&
    isBoundedString(value.signing_key_id, 1, 128) &&
    typeof value.signature === "string" &&
    BASE64URL_SIGNATURE_PATTERN.test(value.signature) &&
    isTimestamp(value.created_at)
  );
}

function isInstallation(value: unknown): value is AgentInstallation {
  return (
    hasExactFields(
      value,
      [
        "created_at",
        "definition_id",
        "id",
        "selected_version_id",
        "status",
        "update_policy",
        "updated_at",
      ],
      [
        "activated_at",
        "archived_at",
        "official_release_id",
        "policy_snapshot_id",
        "runtime_profile_id",
        "selected_release_revision_id",
      ],
    ) &&
    isUUID(value.id) &&
    isUUID(value.definition_id) &&
    isUUID(value.selected_version_id) &&
    (value.runtime_profile_id === undefined ||
      isUUID(value.runtime_profile_id)) &&
    (value.policy_snapshot_id === undefined ||
      isUUID(value.policy_snapshot_id)) &&
    (value.official_release_id === undefined ||
      isCanonicalUUID(value.official_release_id)) &&
    (value.selected_release_revision_id === undefined ||
      isCanonicalUUID(value.selected_release_revision_id)) &&
    ((value.update_policy === "manual" &&
      value.official_release_id === undefined &&
      value.selected_release_revision_id === undefined) ||
      (value.update_policy === "managed" &&
        value.official_release_id !== undefined &&
        value.selected_release_revision_id !== undefined)) &&
    (value.status === "pending" ||
      value.status === "active" ||
      value.status === "archived") &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at) &&
    (value.activated_at === undefined || isTimestamp(value.activated_at)) &&
    (value.archived_at === undefined || isTimestamp(value.archived_at))
  );
}

function isPublication(value: unknown): value is AgentPublication {
  return (
    hasExactFields(value, ["definition", "replayed", "version"]) &&
    isDefinition(value.definition) &&
    isVersion(value.version) &&
    typeof value.replayed === "boolean"
  );
}

function isOrganizationDefinition(value: unknown): value is AgentDefinition {
  return (
    isDefinition(value) &&
    isCanonicalUUID(value.id) &&
    (value.latest_version_id === undefined ||
      isCanonicalUUID(value.latest_version_id))
  );
}

function isOrganizationVersion(value: unknown): value is AgentVersion {
  return (
    isVersion(value) &&
    isCanonicalUUID(value.id) &&
    isCanonicalUUID(value.definition_id) &&
    isCanonicalTimestamp(value.published_at)
  );
}

function isOrganizationReview(
  value: unknown,
): value is OrganizationAgentReviewRecord {
  return (
    hasExactFields(value, [
      "decision",
      "id",
      "organization_policy_snapshot_id",
      "organization_policy_version",
      "reason_code",
      "reviewed_at",
      "reviewed_content_digest",
      "reviewer_user_id",
      "safe_note",
    ]) &&
    isCanonicalUUID(value.id) &&
    isCanonicalUUID(value.reviewer_user_id) &&
    (value.decision === "approve" || value.decision === "reject") &&
    (value.reason_code === null ||
      (typeof value.reason_code === "string" &&
        /^[a-z][a-z0-9_]{0,63}$/.test(value.reason_code))) &&
    (value.safe_note === null ||
      (isBoundedString(value.safe_note, 1, 500) &&
        !/[\r\n\0]/.test(value.safe_note))) &&
    isCanonicalUUID(value.organization_policy_snapshot_id) &&
    Number.isSafeInteger(value.organization_policy_version) &&
    Number(value.organization_policy_version) > 0 &&
    isDigest(value.reviewed_content_digest) &&
    isCanonicalTimestamp(value.reviewed_at) &&
    (value.decision === "approve"
      ? value.reason_code === null && value.safe_note === null
      : value.reason_code !== null)
  );
}

function isOrganizationSubmissionCore(value: unknown): boolean {
  if (
    !isObject(value) ||
    !isCanonicalUUID(value.id) ||
    !isCanonicalUUID(value.organization_id) ||
    (value.kind !== "initial" && value.kind !== "next") ||
    !isCanonicalUUID(value.definition_id) ||
    (value.base_version_id !== null &&
      !isCanonicalUUID(value.base_version_id)) ||
    !isCanonicalUUID(value.submitted_by_user_id) ||
    !isDigest(value.content_digest) ||
    (value.status !== "pending" &&
      value.status !== "approved" &&
      value.status !== "rejected" &&
      value.status !== "withdrawn" &&
      value.status !== "superseded") ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !isCanonicalTimestamp(value.submitted_at) ||
    (value.terminal_at !== null && !isCanonicalTimestamp(value.terminal_at)) ||
    !isCanonicalTimestamp(value.updated_at) ||
    (value.review !== null && !isOrganizationReview(value.review))
  ) {
    return false;
  }
  if (
    (value.kind === "initial" && value.base_version_id !== null) ||
    (value.kind === "next" && value.base_version_id === null)
  ) {
    return false;
  }
  if (value.status === "pending") {
    return value.terminal_at === null && value.review === null;
  }
  if (value.terminal_at === null) return false;
  if (value.status === "approved" || value.status === "rejected") {
    return (
      value.review !== null &&
      value.review.reviewed_content_digest === value.content_digest &&
      ((value.status === "approved" && value.review.decision === "approve") ||
        (value.status === "rejected" && value.review.decision === "reject"))
    );
  }
  return value.review === null;
}

function isOrganizationSubmission(
  value: unknown,
): value is OrganizationAgentSubmissionRecord {
  return (
    hasExactFields(value, [
      "base_version_id",
      "content_digest",
      "definition_id",
      "id",
      "kind",
      "organization_id",
      "review",
      "revision",
      "status",
      "submitted_at",
      "submitted_by_user_id",
      "terminal_at",
      "updated_at",
    ]) && isOrganizationSubmissionCore(value)
  );
}

function isOrganizationSubmissionDetail(
  value: unknown,
): value is OrganizationAgentSubmissionDetailRecord {
  if (
    !hasExactFields(
      value,
      [
        "base_version_id",
        "bundle",
        "bundle_digest",
        "content_digest",
        "definition_id",
        "id",
        "kind",
        "manifest",
        "manifest_digest",
        "organization_id",
        "review",
        "revision",
        "status",
        "submitted_at",
        "submitted_by_user_id",
        "terminal_at",
        "updated_at",
      ],
      ["display_name", "icon_data", "icon_media_type"],
    ) ||
    !isOrganizationSubmissionCore(value) ||
    !isManifest(value.manifest) ||
    !isBundle(value.bundle) ||
    !isDigest(value.manifest_digest) ||
    !isDigest(value.bundle_digest) ||
    (value.display_name !== undefined &&
      !isBoundedString(value.display_name, 1, 100))
  ) {
    return false;
  }
  const hasIconType = value.icon_media_type !== undefined;
  const hasIconData = value.icon_data !== undefined;
  return (
    hasIconType === hasIconData &&
    (!hasIconType ||
      ((value.icon_media_type === "image/png" ||
        value.icon_media_type === "image/webp") &&
        isBoundedString(value.icon_data, 1, 699_051) &&
        /^[A-Za-z0-9_-]+$/.test(value.icon_data)))
  );
}

function isSubmitOrganizationAgentRequest(
  value: unknown,
): value is SubmitOrganizationAgentRequest {
  if (!isObject(value)) return false;
  if (value.kind === "initial") {
    if (
      !hasExactFields(
        value,
        ["bundle", "display_name", "kind", "manifest"],
        ["icon_data", "icon_media_type"],
      ) ||
      !isBoundedString(value.display_name, 1, 100) ||
      !isManifest(value.manifest) ||
      !isBundle(value.bundle)
    ) {
      return false;
    }
    const hasIconType = value.icon_media_type !== undefined;
    const hasIconData = value.icon_data !== undefined;
    return (
      hasIconType === hasIconData &&
      (!hasIconType ||
        ((value.icon_media_type === "image/png" ||
          value.icon_media_type === "image/webp") &&
          isBoundedString(value.icon_data, 1, 699_051) &&
          /^[A-Za-z0-9_-]+$/.test(value.icon_data)))
    );
  }
  return (
    value.kind === "next" &&
    hasExactFields(value, [
      "base_version_id",
      "bundle",
      "definition_id",
      "kind",
      "manifest",
    ]) &&
    isCanonicalUUID(value.definition_id) &&
    isCanonicalUUID(value.base_version_id) &&
    isManifest(value.manifest) &&
    isBundle(value.bundle)
  );
}

function isReviewOrganizationAgentRequest(
  value: unknown,
): value is ReviewOrganizationAgentRequest {
  if (
    !hasExactFields(
      value,
      ["decision", "expected_revision"],
      ["reason_code", "safe_note"],
    ) ||
    !Number.isSafeInteger(value.expected_revision) ||
    Number(value.expected_revision) < 1
  ) {
    return false;
  }
  if (value.decision === "approve") {
    return value.reason_code === undefined && value.safe_note === undefined;
  }
  return (
    value.decision === "reject" &&
    typeof value.reason_code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(value.reason_code) &&
    (value.safe_note === undefined ||
      (isBoundedString(value.safe_note, 1, 500) &&
        !/[\r\n\0]/.test(value.safe_note)))
  );
}

function detachOrganizationReview(
  value: OrganizationAgentReviewRecord,
): OrganizationAgentReviewRecord {
  return {
    id: value.id,
    reviewer_user_id: value.reviewer_user_id,
    decision: value.decision,
    reason_code: value.reason_code,
    safe_note: value.safe_note,
    organization_policy_snapshot_id: value.organization_policy_snapshot_id,
    organization_policy_version: value.organization_policy_version,
    reviewed_content_digest: value.reviewed_content_digest,
    reviewed_at: value.reviewed_at,
  };
}

function detachOrganizationSubmission(
  value: OrganizationAgentSubmissionRecord,
): OrganizationAgentSubmissionRecord {
  return {
    id: value.id,
    organization_id: value.organization_id,
    kind: value.kind,
    definition_id: value.definition_id,
    base_version_id: value.base_version_id,
    submitted_by_user_id: value.submitted_by_user_id,
    content_digest: value.content_digest,
    status: value.status,
    revision: value.revision,
    submitted_at: value.submitted_at,
    terminal_at: value.terminal_at,
    updated_at: value.updated_at,
    review:
      value.review === null ? null : detachOrganizationReview(value.review),
  };
}

function detachOrganizationSubmissionDetail(
  value: OrganizationAgentSubmissionDetailRecord,
): OrganizationAgentSubmissionDetailRecord {
  return {
    ...detachOrganizationSubmission(value),
    ...(value.display_name === undefined
      ? {}
      : { display_name: value.display_name }),
    ...(value.icon_media_type === undefined
      ? {}
      : {
          icon_media_type: value.icon_media_type,
          icon_data: value.icon_data as string,
        }),
    manifest: value.manifest,
    bundle: value.bundle,
    manifest_digest: value.manifest_digest,
    bundle_digest: value.bundle_digest,
  };
}

function isInstallationCreation(
  value: unknown,
): value is AgentInstallationCreation {
  return (
    hasExactFields(value, ["installation", "policy_snapshot", "replayed"]) &&
    isInstallation(value.installation) &&
    isPolicy(value.policy_snapshot) &&
    typeof value.replayed === "boolean"
  );
}

function isCreateInstallationRequest(
  value: unknown,
): value is CreateAgentInstallationRequest {
  if (!isObject(value)) return false;
  if (Object.hasOwn(value, "official_release_revision_id")) {
    return (
      hasExactFields(value, [
        "definition_id",
        "official_release_revision_id",
      ]) &&
      isCanonicalUUID(value.definition_id) &&
      isCanonicalUUID(value.official_release_revision_id)
    );
  }
  if (
    !hasExactFields(
      value,
      ["definition_id", "version_id"],
      ["organization_id", "workspace_id"],
    ) ||
    !isUUID(value.definition_id) ||
    !isUUID(value.version_id) ||
    (value.workspace_id !== undefined && !isUUID(value.workspace_id)) ||
    (value.organization_id !== undefined && !isUUID(value.organization_id))
  ) {
    return false;
  }
  return !(
    value.workspace_id !== undefined && value.organization_id !== undefined
  );
}

function isRevocation(value: unknown): value is AgentVersionRevocation {
  return (
    hasExactFields(
      value,
      [
        "created_at",
        "id",
        "policy_snapshot_id",
        "reason_code",
        "replayed",
        "version_id",
      ],
      ["superseding_version_id"],
    ) &&
    isUUID(value.id) &&
    isUUID(value.version_id) &&
    isUUID(value.policy_snapshot_id) &&
    isBoundedString(value.reason_code, 1, 64) &&
    (value.superseding_version_id === undefined ||
      isUUID(value.superseding_version_id)) &&
    isTimestamp(value.created_at) &&
    typeof value.replayed === "boolean"
  );
}

function isRuntimeBinding(value: unknown): value is RuntimeBindingRecord {
  return (
    hasExactFields(
      value,
      [
        "agent_installation_id",
        "agent_version_id",
        "created_at",
        "id",
        "policy_snapshot_id",
        "runtime_profile_id",
        "runtime_version",
        "tool_permission_digest",
      ],
      ["official_release_revision_id"],
    ) &&
    isUUID(value.id) &&
    isUUID(value.agent_installation_id) &&
    isUUID(value.agent_version_id) &&
    isUUID(value.runtime_profile_id) &&
    isUUID(value.policy_snapshot_id) &&
    (value.official_release_revision_id === undefined ||
      isCanonicalUUID(value.official_release_revision_id)) &&
    isBoundedString(value.runtime_version, 1, 64) &&
    isDigest(value.tool_permission_digest) &&
    isTimestamp(value.created_at)
  );
}

function isSigningKeySet(value: unknown): value is AgentSigningKeySet {
  return (
    hasExactFields(value, ["keys"]) &&
    Array.isArray(value.keys) &&
    value.keys.length > 0 &&
    value.keys.length <= 128 &&
    value.keys.every(
      (key) =>
        hasExactFields(key, [
          "alg",
          "crv",
          "kid",
          "kty",
          "purpose",
          "use",
          "x",
        ]) &&
        key.alg === "EdDSA" &&
        key.crv === "Ed25519" &&
        key.kty === "OKP" &&
        key.use === "sig" &&
        (key.purpose === "access" ||
          key.purpose === "offline_entitlement" ||
          key.purpose === "agent_version" ||
          key.purpose === "agent_policy" ||
          key.purpose === "organization_policy") &&
        isBoundedString(key.kid, 1, 128) &&
        typeof key.x === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(key.x) &&
        Buffer.from(key.x, "base64url").toString("base64url") === key.x,
    )
  );
}

function requireUUID(value: string): void {
  if (!isUUID(value)) {
    throw new AgenteraAgentControlClientError(0, "invalid_request");
  }
}

function requireCanonicalUUID(value: string): void {
  if (!isCanonicalUUID(value)) {
    throw new AgenteraAgentControlClientError(0, "invalid_request");
  }
}

function requireIdempotencyKey(value: string): void {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 256 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new AgenteraAgentControlClientError(0, "invalid_request");
  }
}

function safeServerError(raw: string): {
  code: string;
  findings: CloudExperienceCandidateFinding[];
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const exactErrorEnvelope = hasExactFields(parsed, ["error"]);
    const exactSupersededEnvelope =
      hasExactFields(parsed, ["error", "submission"]) &&
      isObject(parsed.error) &&
      parsed.error.code === "organization_submission_superseded" &&
      isOrganizationSubmission(parsed.submission) &&
      parsed.submission.status === "superseded";
    if (
      (exactErrorEnvelope || exactSupersededEnvelope) &&
      isObject(parsed.error) &&
      typeof parsed.error.code === "string" &&
      STABLE_ERROR_CODES.has(parsed.error.code)
    ) {
      if (
        parsed.error.code !== "candidate_dlp_blocked" &&
        parsed.error.code !== "organization_publication_dlp_blocked"
      ) {
        return { code: parsed.error.code, findings: [] };
      }
      if (
        parsed.error.findings !== undefined &&
        (!Array.isArray(parsed.error.findings) ||
          parsed.error.findings.length > 128 ||
          !parsed.error.findings.every(isExperienceCandidateFinding))
      ) {
        return { code: "request_failed", findings: [] };
      }
      const findings = (parsed.error.findings ?? [])
        .map((finding) => ({
          code: finding.code,
          path: finding.path,
          ...(finding.line === undefined ? {} : { line: finding.line }),
        }))
        .sort((left, right) => {
          const code = left.code.localeCompare(right.code);
          if (code !== 0) return code;
          const path = left.path.localeCompare(right.path);
          if (path !== 0) return path;
          return (left.line ?? 0) - (right.line ?? 0);
        });
      return { code: parsed.error.code, findings };
    }
  } catch {
    // A bounded generic error avoids exposing response bodies or parser detail.
  }
  return { code: "request_failed", findings: [] };
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes)
  ) {
    throw new AgenteraAgentControlClientError(0, "response_too_large");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new AgenteraAgentControlClientError(0, "response_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AgenteraAgentControlClientError(0, "invalid_response");
  }
}

function signActivation(
  identity: InstallationIdentity,
  payload: Buffer,
): string {
  let privateKey;
  let publicKey;
  try {
    const privateBytes = Buffer.from(identity.devicePrivateKey, "base64");
    const publicBytes = Buffer.from(identity.devicePublicKey, "base64url");
    if (
      privateBytes.length === 0 ||
      privateBytes.toString("base64") !== identity.devicePrivateKey ||
      publicBytes.length !== 32 ||
      publicBytes.toString("base64url") !== identity.devicePublicKey
    ) {
      throw new Error("non-canonical device identity");
    }
    privateKey = createPrivateKey({
      key: privateBytes,
      format: "der",
      type: "pkcs8",
    });
    publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, publicBytes]),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new AgenteraAgentControlClientError(0, "invalid_device_identity");
  }
  const signature = sign(null, payload, privateKey);
  if (!verifySignature(null, payload, publicKey, signature)) {
    throw new AgenteraAgentControlClientError(0, "invalid_device_identity");
  }
  return signature.toString("base64url");
}

export class AgenteraAgentControlClient {
  readonly origin: string;
  private readonly getAccessToken: () => string | null;
  private readonly getInstallationIdentity: () => InstallationIdentity | null;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly officialAgentChannel: OfficialAgentChannel | null;
  private readonly desktopVersion: string | null;
  private readonly getAgentContext: (() => AgenteraAgentControlContext) | null;

  constructor(options: AgenteraAgentControlClientOptions) {
    this.origin = parseAgenteraCloudOrigin(options.origin);
    this.getAccessToken = options.getAccessToken;
    this.getInstallationIdentity = options.getInstallationIdentity;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    const hasOfficialConfiguration =
      options.officialAgentChannel !== undefined ||
      options.desktopVersion !== undefined ||
      options.getAgentContext !== undefined;
    const hasCompleteOfficialConfiguration =
      (options.officialAgentChannel === "internal" ||
        options.officialAgentChannel === "stable") &&
      isDesktopVersion(options.desktopVersion) &&
      typeof options.getAgentContext === "function";
    this.officialAgentChannel = hasCompleteOfficialConfiguration
      ? (options.officialAgentChannel as OfficialAgentChannel)
      : null;
    this.desktopVersion = hasCompleteOfficialConfiguration
      ? (options.desktopVersion as string)
      : null;
    this.getAgentContext = hasCompleteOfficialConfiguration
      ? (options.getAgentContext as () => AgenteraAgentControlContext)
      : null;
    if (
      typeof this.getAccessToken !== "function" ||
      typeof this.getInstallationIdentity !== "function" ||
      typeof this.fetcher !== "function" ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000 ||
      (hasOfficialConfiguration && !hasCompleteOfficialConfiguration)
    ) {
      throw new Error("Aera Agent control client configuration is invalid.");
    }
  }

  async listDefinitions(): Promise<AgentDefinition[]> {
    const value = await this.requestJSON(
      "/api/v1/agent-definitions",
      { expectedStatus: 200 },
      (candidate): candidate is { definitions: readonly AgentDefinition[] } =>
        hasExactFields(candidate, ["definitions"]) &&
        Array.isArray(candidate.definitions) &&
        candidate.definitions.every(isDefinition),
    );
    return [...value.definitions];
  }

  async listWorkspaceDefinitions(
    workspaceId: string,
  ): Promise<AgentDefinition[]> {
    requireUUID(workspaceId);
    const value = await this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/agent-definitions`,
      { expectedStatus: 200 },
      (candidate): candidate is { definitions: readonly AgentDefinition[] } =>
        hasExactFields(candidate, ["definitions"]) &&
        Array.isArray(candidate.definitions) &&
        candidate.definitions.every(isDefinition),
    );
    return [...value.definitions];
  }

  async listOrganizationDefinitions(
    organizationId: string,
  ): Promise<AgentDefinition[]> {
    requireCanonicalUUID(organizationId);
    const value = await this.requestJSON(
      `/api/v1/organizations/${organizationId}/agent-definitions`,
      { expectedStatus: 200 },
      (candidate): candidate is { definitions: readonly AgentDefinition[] } =>
        hasExactFields(candidate, ["definitions"]) &&
        Array.isArray(candidate.definitions) &&
        candidate.definitions.every(isOrganizationDefinition),
    );
    return [...value.definitions];
  }

  getDefinition(definitionId: string): Promise<AgentDefinition> {
    requireUUID(definitionId);
    return this.requestJSON(
      `/api/v1/agent-definitions/${definitionId}`,
      { expectedStatus: 200 },
      isDefinition,
    );
  }

  getWorkspaceDefinition(
    workspaceId: string,
    definitionId: string,
  ): Promise<AgentDefinition> {
    requireUUID(workspaceId);
    requireUUID(definitionId);
    return this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/agent-definitions/${definitionId}`,
      { expectedStatus: 200 },
      isDefinition,
    );
  }

  async getOrganizationDefinition(
    organizationId: string,
    definitionId: string,
  ): Promise<AgentDefinition> {
    requireCanonicalUUID(organizationId);
    requireCanonicalUUID(definitionId);
    const value = await this.requestJSON(
      `/api/v1/organizations/${organizationId}/agent-definitions/${definitionId}`,
      { expectedStatus: 200 },
      isOrganizationDefinition,
    );
    if (value.id !== definitionId) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return value;
  }

  async listVersions(definitionId: string): Promise<AgentVersion[]> {
    requireUUID(definitionId);
    const value = await this.requestJSON(
      `/api/v1/agent-definitions/${definitionId}/versions`,
      { expectedStatus: 200 },
      (candidate): candidate is { versions: readonly AgentVersion[] } =>
        hasExactFields(candidate, ["versions"]) &&
        Array.isArray(candidate.versions) &&
        candidate.versions.every(isVersion),
    );
    return [...value.versions];
  }

  async listWorkspaceVersions(
    workspaceId: string,
    definitionId: string,
  ): Promise<AgentVersion[]> {
    requireUUID(workspaceId);
    requireUUID(definitionId);
    const value = await this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/agent-definitions/${definitionId}/versions`,
      { expectedStatus: 200 },
      (candidate): candidate is { versions: readonly AgentVersion[] } =>
        hasExactFields(candidate, ["versions"]) &&
        Array.isArray(candidate.versions) &&
        candidate.versions.every(isVersion),
    );
    return [...value.versions];
  }

  async listOrganizationVersions(
    organizationId: string,
    definitionId: string,
  ): Promise<AgentVersion[]> {
    requireCanonicalUUID(organizationId);
    requireCanonicalUUID(definitionId);
    const value = await this.requestJSON(
      `/api/v1/organizations/${organizationId}/agent-definitions/${definitionId}/versions`,
      { expectedStatus: 200 },
      (candidate): candidate is { versions: readonly AgentVersion[] } =>
        hasExactFields(candidate, ["versions"]) &&
        Array.isArray(candidate.versions) &&
        candidate.versions.every(
          (version) =>
            isOrganizationVersion(version) &&
            version.definition_id === definitionId,
        ),
    );
    return [...value.versions];
  }

  async submitOrganizationAgent(
    organizationId: string,
    body: SubmitOrganizationAgentRequest,
    idempotencyKey: string,
  ): Promise<OrganizationAgentSubmissionDetailRecord> {
    requireCanonicalUUID(organizationId);
    requireIdempotencyKey(idempotencyKey);
    if (!isSubmitOrganizationAgentRequest(body)) {
      throw new AgenteraAgentControlClientError(0, "invalid_request");
    }
    const value = await this.requestJSON(
      `/api/v1/organizations/${organizationId}/agent-publication-submissions`,
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isOrganizationSubmissionDetail,
    );
    if (value.organization_id !== organizationId) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return detachOrganizationSubmissionDetail(value);
  }

  async listOrganizationAgentSubmissions(
    organizationId: string,
  ): Promise<OrganizationAgentSubmissionRecord[]> {
    requireCanonicalUUID(organizationId);
    const value = await this.requestJSON(
      `/api/v1/organizations/${organizationId}/agent-publication-submissions`,
      { expectedStatus: 200 },
      (
        candidate,
      ): candidate is {
        submissions: readonly OrganizationAgentSubmissionRecord[];
      } =>
        hasExactFields(candidate, ["submissions"]) &&
        Array.isArray(candidate.submissions) &&
        candidate.submissions.every(
          (submission) =>
            isOrganizationSubmission(submission) &&
            submission.organization_id === organizationId,
        ),
    );
    return value.submissions.map(detachOrganizationSubmission);
  }

  async getOrganizationAgentSubmission(
    organizationId: string,
    submissionId: string,
  ): Promise<OrganizationAgentSubmissionDetailRecord> {
    requireCanonicalUUID(organizationId);
    requireCanonicalUUID(submissionId);
    const value = await this.requestJSON(
      `/api/v1/organizations/${organizationId}/agent-publication-submissions/${submissionId}`,
      { expectedStatus: 200 },
      isOrganizationSubmissionDetail,
    );
    if (value.organization_id !== organizationId || value.id !== submissionId) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return detachOrganizationSubmissionDetail(value);
  }

  async withdrawOrganizationAgentSubmission(
    organizationId: string,
    submissionId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<OrganizationAgentSubmissionDetailRecord> {
    requireCanonicalUUID(organizationId);
    requireCanonicalUUID(submissionId);
    requireIdempotencyKey(idempotencyKey);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new AgenteraAgentControlClientError(0, "invalid_request");
    }
    const body: components["schemas"]["WithdrawOrganizationAgentRequest"] = {
      expected_revision: expectedRevision,
    };
    const value = await this.requestJSON(
      `/api/v1/organizations/${organizationId}/agent-publication-submissions/${submissionId}/withdraw`,
      { method: "POST", body, idempotencyKey, expectedStatus: 200 },
      isOrganizationSubmissionDetail,
    );
    if (value.organization_id !== organizationId || value.id !== submissionId) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return detachOrganizationSubmissionDetail(value);
  }

  async reviewOrganizationAgentSubmission(
    organizationId: string,
    submissionId: string,
    body: ReviewOrganizationAgentRequest,
    idempotencyKey: string,
  ): Promise<OrganizationAgentSubmissionDetailRecord> {
    requireCanonicalUUID(organizationId);
    requireCanonicalUUID(submissionId);
    requireIdempotencyKey(idempotencyKey);
    if (!isReviewOrganizationAgentRequest(body)) {
      throw new AgenteraAgentControlClientError(0, "invalid_request");
    }
    const value = await this.requestJSON(
      `/api/v1/organizations/${organizationId}/agent-publication-submissions/${submissionId}/reviews`,
      { method: "POST", body, idempotencyKey, expectedStatus: 200 },
      isOrganizationSubmissionDetail,
    );
    if (value.organization_id !== organizationId || value.id !== submissionId) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return detachOrganizationSubmissionDetail(value);
  }

  getVersion(versionId: string): Promise<AgentVersion> {
    requireUUID(versionId);
    return this.requestJSON(
      `/api/v1/agent-versions/${versionId}`,
      { expectedStatus: 200 },
      isVersion,
    );
  }

  getPolicySnapshot(snapshotId: string): Promise<AgentPolicySnapshot> {
    requireUUID(snapshotId);
    return this.requestJSON(
      `/api/v1/policy-snapshots/${snapshotId}`,
      { expectedStatus: 200 },
      isPolicy,
    );
  }

  async listOfficialAgents(): Promise<OfficialAgentSummary[]> {
    const channel = this.requireOfficialConfiguration().channel;
    const value = await this.requestJSON(
      "/api/v1/official-agents",
      { expectedStatus: 200, official: true },
      (
        candidate,
      ): candidate is {
        official_agents: readonly WireOfficialAgentSummary[];
      } =>
        hasExactFields(candidate, ["official_agents"]) &&
        Array.isArray(candidate.official_agents) &&
        candidate.official_agents.length <= 100 &&
        candidate.official_agents.every(isOfficialAgentSummary),
    );
    if (value.official_agents.some((agent) => agent.channel !== channel)) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return value.official_agents.map(detachOfficialAgentSummary);
  }

  getOfficialAgentChannel(): OfficialAgentChannel {
    return this.requireOfficialConfiguration().channel;
  }

  async getOfficialAgent(definitionId: string): Promise<{
    agent: OfficialAgentSummary;
    version: AgentVersion;
  }> {
    requireCanonicalUUID(definitionId);
    const channel = this.requireOfficialConfiguration().channel;
    const value = await this.requestJSON(
      `/api/v1/official-agents/${definitionId}`,
      { expectedStatus: 200, official: true },
      isOfficialAgentDetail,
    );
    if (
      value.agent.definition_id !== definitionId ||
      value.agent.channel !== channel
    ) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return {
      agent: detachOfficialAgentSummary(value.agent),
      version: structuredClone(value.version),
    };
  }

  async getOfficialRelease(
    definitionId: string,
  ): Promise<OfficialAgentSummary> {
    requireCanonicalUUID(definitionId);
    const channel = this.requireOfficialConfiguration().channel;
    const value = await this.requestJSON(
      `/api/v1/official-agents/${definitionId}/release`,
      { expectedStatus: 200, official: true },
      isOfficialAgentSummary,
    );
    if (value.definition_id !== definitionId || value.channel !== channel) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return detachOfficialAgentSummary(value);
  }

  async getManagedUpdate(
    installationId: string,
  ): Promise<OfficialManagedUpdate | null> {
    requireCanonicalUUID(installationId);
    const value = await this.requestJSON(
      `/api/v1/agent-installations/${installationId}/managed-update`,
      { expectedStatus: 200, official: true },
      isOfficialManagedUpdateResponse,
    );
    if (!value.update_available) return null;
    if (value.installation_id !== installationId) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return {
      installationId: value.installation_id,
      expectedSelectedReleaseRevisionId:
        value.expected_selected_release_revision_id,
      targetReleaseRevisionId: value.target_release_revision_id,
      targetVersionId: value.target_version_id,
    };
  }

  async applyManagedUpdate(
    installationId: string,
    expectedSelectedReleaseRevisionId: string,
    targetReleaseRevisionId: string,
    idempotencyKey: string,
  ): Promise<AgentInstallation> {
    requireCanonicalUUID(installationId);
    requireCanonicalUUID(expectedSelectedReleaseRevisionId);
    requireCanonicalUUID(targetReleaseRevisionId);
    requireIdempotencyKey(idempotencyKey);
    const body: components["schemas"]["ApplyManagedOfficialUpdateRequest"] = {
      expected_selected_release_revision_id: expectedSelectedReleaseRevisionId,
      target_release_revision_id: targetReleaseRevisionId,
    };
    const value = await this.requestJSON(
      `/api/v1/agent-installations/${installationId}/apply-managed-update`,
      {
        method: "POST",
        body,
        idempotencyKey,
        expectedStatus: 200,
        official: true,
      },
      isInstallation,
    );
    if (
      value.id !== installationId ||
      value.update_policy !== "managed" ||
      value.selected_release_revision_id !== targetReleaseRevisionId
    ) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return value;
  }

  publishInitial(
    body: PublishInitialAgentRequest,
    idempotencyKey: string,
  ): Promise<AgentPublication> {
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      "/api/v1/agent-definitions",
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isPublication,
    );
  }

  publishWorkspaceInitial(
    workspaceId: string,
    body: PublishInitialAgentRequest,
    idempotencyKey: string,
  ): Promise<AgentPublication> {
    requireUUID(workspaceId);
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/agent-definitions`,
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isPublication,
    );
  }

  publishNext(
    definitionId: string,
    body: PublishNextAgentVersionRequest,
    idempotencyKey: string,
  ): Promise<AgentPublication> {
    requireUUID(definitionId);
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      `/api/v1/agent-definitions/${definitionId}/versions`,
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isPublication,
    );
  }

  publishWorkspaceNext(
    workspaceId: string,
    definitionId: string,
    body: PublishNextAgentVersionRequest,
    idempotencyKey: string,
  ): Promise<AgentPublication> {
    requireUUID(workspaceId);
    requireUUID(definitionId);
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/agent-definitions/${definitionId}/versions`,
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isPublication,
    );
  }

  revokeVersion(
    versionId: string,
    body: RevokeAgentVersionRequest,
    idempotencyKey: string,
  ): Promise<AgentVersionRevocation> {
    requireUUID(versionId);
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      `/api/v1/agent-versions/${versionId}/revocations`,
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isRevocation,
    );
  }

  async createInstallation(
    body: CreateAgentInstallationRequest,
    idempotencyKey: string,
  ): Promise<AgentInstallationCreation> {
    requireIdempotencyKey(idempotencyKey);
    if (!isCreateInstallationRequest(body)) {
      throw new AgenteraAgentControlClientError(0, "invalid_request");
    }
    const official = Object.hasOwn(body, "official_release_revision_id");
    return this.requestJSON(
      "/api/v1/agent-installations",
      {
        method: "POST",
        body,
        idempotencyKey,
        expectedStatus: 201,
        official,
      },
      isInstallationCreation,
    );
  }

  activateInstallation(
    installationId: string,
    runtimeProfileId: string,
    versionDigest: string,
    idempotencyKey: string,
  ): Promise<AgentInstallation> {
    requireUUID(installationId);
    requireUUID(runtimeProfileId);
    requireIdempotencyKey(idempotencyKey);
    if (!DIGEST_PATTERN.test(versionDigest)) {
      throw new AgenteraAgentControlClientError(0, "invalid_request");
    }
    const identity = this.getInstallationIdentity();
    if (!identity) {
      throw new AgenteraAgentControlClientError(0, "invalid_device_identity");
    }
    const timestamp = Math.floor(this.now().getTime() / 1000);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new AgenteraAgentControlClientError(0, "invalid_request");
    }
    const signedPayload = Buffer.from(
      `agentera-agent-installation-activate-v1\0${installationId}\0${runtimeProfileId}\0${versionDigest}\0${timestamp}`,
      "utf8",
    );
    const body: components["schemas"]["ActivateAgentInstallationRequest"] = {
      runtime_profile_id: runtimeProfileId,
      version_digest: versionDigest,
      timestamp,
      device_proof: signActivation(identity, signedPayload),
    };
    return this.requestJSON(
      `/api/v1/agent-installations/${installationId}/activate`,
      { method: "POST", body, idempotencyKey, expectedStatus: 200 },
      isInstallation,
    );
  }

  selectInstallationVersion(
    installationId: string,
    versionId: string,
    idempotencyKey: string,
  ): Promise<AgentInstallation> {
    requireUUID(installationId);
    requireUUID(versionId);
    requireIdempotencyKey(idempotencyKey);
    const body: components["schemas"]["SelectAgentInstallationVersionRequest"] =
      {
        version_id: versionId,
      };
    return this.requestJSON(
      `/api/v1/agent-installations/${installationId}/select-version`,
      { method: "POST", body, idempotencyKey, expectedStatus: 200 },
      isInstallation,
    );
  }

  async archiveInstallation(
    installationId: string,
    idempotencyKey: string,
  ): Promise<AgentInstallation> {
    requireUUID(installationId);
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      `/api/v1/agent-installations/${installationId}/archive`,
      { method: "POST", body: {}, idempotencyKey, expectedStatus: 200 },
      isInstallation,
    );
  }

  recordRuntimeBinding(
    body: CreateRuntimeBindingRecordRequest,
    idempotencyKey: string,
  ): Promise<RuntimeBindingRecord> {
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      "/api/v1/runtime-binding-records",
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isRuntimeBinding,
    );
  }

  async submitExperienceCandidate(
    workspaceId: string,
    definitionId: string,
    body: SubmitExperienceCandidateRequest,
    idempotencyKey: string,
  ): Promise<CloudExperienceCandidateDetail> {
    requireUUID(workspaceId);
    requireUUID(definitionId);
    requireIdempotencyKey(idempotencyKey);
    if (!isSubmitExperienceCandidateRequest(body)) {
      throw new AgenteraAgentControlClientError(0, "invalid_request");
    }
    const value = await this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/agent-definitions/${definitionId}/experience-candidates`,
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isExperienceCandidateDetail,
    );
    return detachExperienceCandidateDetail(value);
  }

  async listOwnExperienceCandidates(
    workspaceId: string,
  ): Promise<CloudExperienceCandidateSummary[]> {
    requireUUID(workspaceId);
    const value = await this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/experience-candidates/mine`,
      { expectedStatus: 200 },
      (
        candidate,
      ): candidate is {
        candidates: readonly CloudExperienceCandidateSummary[];
      } =>
        hasExactFields(candidate, ["candidates"]) &&
        Array.isArray(candidate.candidates) &&
        candidate.candidates.every(isExperienceCandidateSummary),
    );
    return value.candidates.map(detachExperienceCandidateSummary);
  }

  async listWorkspaceExperienceCandidates(
    workspaceId: string,
  ): Promise<CloudExperienceCandidateSummary[]> {
    requireUUID(workspaceId);
    const value = await this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/experience-candidates`,
      { expectedStatus: 200 },
      (
        candidate,
      ): candidate is {
        candidates: readonly CloudExperienceCandidateSummary[];
      } =>
        hasExactFields(candidate, ["candidates"]) &&
        Array.isArray(candidate.candidates) &&
        candidate.candidates.every(isExperienceCandidateSummary),
    );
    return value.candidates.map(detachExperienceCandidateSummary);
  }

  async getExperienceCandidate(
    workspaceId: string,
    candidateId: string,
  ): Promise<CloudExperienceCandidateDetail> {
    requireUUID(workspaceId);
    requireUUID(candidateId);
    const value = await this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/experience-candidates/${candidateId}`,
      { expectedStatus: 200 },
      isExperienceCandidateDetail,
    );
    return detachExperienceCandidateDetail(value);
  }

  async reviewExperienceCandidate(
    workspaceId: string,
    candidateId: string,
    body: ReviewExperienceCandidateRequest,
    idempotencyKey: string,
  ): Promise<CloudExperienceCandidateDetail> {
    requireUUID(workspaceId);
    requireUUID(candidateId);
    requireIdempotencyKey(idempotencyKey);
    if (!isReviewExperienceCandidateRequest(body)) {
      throw new AgenteraAgentControlClientError(0, "invalid_request");
    }
    const value = await this.requestJSON(
      `/api/v1/workspaces/${workspaceId}/experience-candidates/${candidateId}/review`,
      { method: "POST", body, idempotencyKey, expectedStatus: 200 },
      isExperienceCandidateDetail,
    );
    return detachExperienceCandidateDetail(value);
  }

  getSigningKeys(): Promise<AgentSigningKeySet> {
    return this.requestJSON(
      "/.well-known/agentera-signing-keys.json",
      {
        authenticated: false,
        expectedStatus: 200,
        responseLimit: KEY_RESPONSE_LIMIT,
      },
      isSigningKeySet,
    );
  }

  private async requestJSON<T>(
    path: string,
    options: RequestOptions,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    const response = await this.request(path, options);
    const raw = await readBoundedText(
      response,
      options.responseLimit ?? RESPONSE_LIMIT,
    );
    if (response.status !== options.expectedStatus) {
      const serverError = safeServerError(raw);
      throw new AgenteraAgentControlClientError(
        response.status,
        serverError.code,
        serverError.findings,
      );
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    if (!validate(parsed)) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return parsed;
  }

  private async request(
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    const authenticated = options.authenticated !== false;
    const headers: Record<string, string> = { accept: "application/json" };
    if (authenticated) {
      const token = this.getAccessToken();
      if (
        typeof token !== "string" ||
        token.length === 0 ||
        token.length > 8192 ||
        token !== token.trim() ||
        /\s/.test(token)
      ) {
        throw new AgenteraAgentControlClientError(401, "session_revoked");
      }
      headers.authorization = `Bearer ${token}`;
    }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }
    if (options.official === true) {
      Object.assign(headers, this.officialRequestHeaders());
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref?.();
    try {
      return await this.fetcher(agenteraCloudUrl(this.origin, path), {
        method: options.method ?? "GET",
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof AgenteraAgentControlClientError) throw error;
      throw new AgenteraAgentControlClientError(
        0,
        timedOut ? "request_timeout" : "network_unavailable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private requireOfficialConfiguration(): {
    channel: OfficialAgentChannel;
    desktopVersion: string;
    getContext: () => AgenteraAgentControlContext;
  } {
    if (
      this.officialAgentChannel === null ||
      this.desktopVersion === null ||
      this.getAgentContext === null
    ) {
      throw new AgenteraAgentControlClientError(0, "invalid_request");
    }
    return {
      channel: this.officialAgentChannel,
      desktopVersion: this.desktopVersion,
      getContext: this.getAgentContext,
    };
  }

  private officialRequestHeaders(): Record<string, string> {
    const configuration = this.requireOfficialConfiguration();
    const context = configuration.getContext();
    const headers: Record<string, string> = {
      "x-agentera-official-channel": configuration.channel,
      "x-agentera-desktop-version": configuration.desktopVersion,
    };
    if (hasExactFields(context, ["scope"]) && context.scope === "USER") {
      headers["x-agentera-product-context"] = "USER";
      return headers;
    }
    if (
      hasExactFields(context, ["role", "scope", "workspaceId"]) &&
      context.scope === "WORKSPACE" &&
      isCanonicalUUID(context.workspaceId) &&
      (context.role === "owner" ||
        context.role === "admin" ||
        context.role === "member")
    ) {
      headers["x-agentera-product-context"] = "WORKSPACE";
      headers["x-agentera-product-context-id"] = context.workspaceId;
      return headers;
    }
    if (
      hasExactFields(context, ["organizationId", "role", "scope"]) &&
      context.scope === "ORGANIZATION" &&
      isCanonicalUUID(context.organizationId) &&
      (context.role === "owner" ||
        context.role === "admin" ||
        context.role === "auditor" ||
        context.role === "member")
    ) {
      headers["x-agentera-product-context"] = "ORGANIZATION";
      headers["x-agentera-product-context-id"] = context.organizationId;
      return headers;
    }
    throw new AgenteraAgentControlClientError(0, "invalid_request");
  }
}
