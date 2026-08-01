import type {
  AgentDraft,
  AgentDraftAssetKind,
  AgenteraAgentControlErrorCode,
  AgenteraAgentControlResult,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  AgenteraAgentOperationScope,
  AgenteraAgentVersionSummary,
  AgenteraClaimVersionInput,
  AgenteraInstallVersionInput,
  AgenteraRepairInstallationModelInput,
  AgenteraRetryPendingInstallationInput,
  AgenteraSelectInstallationVersionInput,
  ConfirmExperienceCandidateImportInput,
  ConfirmOfficialAgentInstallInput,
  ConfirmOrganizationReviewInput,
  ConfirmOrganizationSubmissionInput,
  ConfirmOrganizationWithdrawalInput,
  CreateAgentDraftInput,
  ExperienceCandidateFinding,
  OrganizationAgentSubmissionDetail,
  OrganizationAgentSubmissionSummary,
  OrganizationReviewPreview,
  OrganizationSubmissionPreview,
  OrganizationWithdrawalPreview,
  PrepareExperienceCandidateInput,
  PrepareOrganizationReviewInput,
  ReviewExperienceCandidateInput,
  SubmitExperienceCandidateInput,
  UpdateAgentDraftInput,
} from "../../shared/agentera-agent-control";
import type { AgentDefinition, AgentVersion } from "./client";
import type { LocalAgentInstallation } from "./installation-manager";
import type {
  OrganizationAgentSubmissionDetail as MainOrganizationAgentSubmissionDetail,
  OrganizationReviewPreview as MainOrganizationReviewPreview,
  OrganizationSubmissionPreview as MainOrganizationSubmissionPreview,
  OrganizationWithdrawalPreview as MainOrganizationWithdrawalPreview,
} from "./organization-publication-service";
import { AGENTERA_UUID_PATTERN as UUID_PATTERN } from "../../shared/agentera-identifier";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const FINDING_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_DRAFT_IPC_BYTES = 3 * 1024 * 1024;
const MAX_SAFE_NOTE_LENGTH = 240;
const MAX_ORGANIZATION_SAFE_NOTE_LENGTH = 500;
const MAX_FINDING_PATH_BYTES = 512;
const MAX_IPC_FINDINGS = 128;

function invalidRequest(): never {
  const error = new Error("Aera Agent control request is invalid.");
  Object.assign(error, { code: "invalid_request" });
  throw error;
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function cloneBounded<T>(value: unknown): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalidRequest();
  }
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > MAX_DRAFT_IPC_BYTES
  ) {
    return invalidRequest();
  }
  try {
    return JSON.parse(serialized) as T;
  } catch {
    return invalidRequest();
  }
}

export function parseAgentControlId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return invalidRequest();
  }
  return value.toLowerCase();
}

export function parseAgentOperationScope(
  value: unknown,
): AgenteraAgentOperationScope | undefined {
  if (value === undefined) return undefined;
  if (value !== "USER") return invalidRequest();
  return value;
}

function parseProfileId(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    return invalidRequest();
  }
  return value;
}

function assertDraftShape(
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (!exactObject(value, fields)) invalidRequest();
}

export function parseCreateDraftInput(value: unknown): CreateAgentDraftInput {
  assertDraftShape(value, [
    "sourceAgentDefinitionId",
    "baseAgentVersionId",
    "displayName",
    "icon",
    "manifest",
    "assets",
  ]);
  return cloneBounded<CreateAgentDraftInput>(value);
}

export function parseUpdateDraftInput(value: unknown): UpdateAgentDraftInput {
  assertDraftShape(value, [
    "id",
    "expectedRevision",
    "displayName",
    "icon",
    "manifest",
    "assets",
  ]);
  parseAgentControlId(value.id);
  if (
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 1
  ) {
    invalidRequest();
  }
  return cloneBounded<UpdateAgentDraftInput>(value);
}

export function parseInstallVersionInput(
  value: unknown,
): AgenteraInstallVersionInput {
  if (
    !exactObject(value, ["definitionId", "versionId", "profileName"]) &&
    !exactObject(value, [
      "definitionId",
      "versionId",
      "profileName",
      "modelProfileId",
    ])
  ) {
    return invalidRequest();
  }
  return {
    definitionId: parseAgentControlId(value.definitionId),
    versionId: parseAgentControlId(value.versionId),
    profileName: parseProfileId(value.profileName),
    ...(Object.hasOwn(value, "modelProfileId")
      ? { modelProfileId: parseProfileId(value.modelProfileId) }
      : {}),
  };
}

export function parseClaimVersionInput(
  value: unknown,
): AgenteraClaimVersionInput {
  if (
    !exactObject(value, [
      "definitionId",
      "versionId",
      "localProfileId",
      "confirmation",
    ]) ||
    value.confirmation !== "claim-existing-profile"
  ) {
    return invalidRequest();
  }
  return {
    definitionId: parseAgentControlId(value.definitionId),
    versionId: parseAgentControlId(value.versionId),
    localProfileId: parseProfileId(value.localProfileId),
    confirmation: "claim-existing-profile",
  };
}

export function parseConfirmOfficialAgentInstallInput(
  value: unknown,
): ConfirmOfficialAgentInstallInput {
  if (
    !exactObject(value, ["installHandle", "confirmation"]) ||
    value.confirmation !== "install-official-agent"
  ) {
    return invalidRequest();
  }
  return {
    installHandle: parseAgentControlId(value.installHandle),
    confirmation: "install-official-agent",
  };
}

export function parseRetryPendingInstallationInput(
  value: unknown,
): AgenteraRetryPendingInstallationInput {
  if (!exactObject(value, ["id", "target"])) return invalidRequest();
  const id = parseAgentControlId(value.id);
  const target = value.target;
  if (
    (exactObject(target, ["kind", "profileName"]) ||
      exactObject(target, ["kind", "profileName", "modelProfileId"])) &&
    target.kind === "fresh"
  ) {
    return {
      id,
      target: {
        kind: "fresh",
        profileName: parseProfileId(target.profileName),
        ...(Object.hasOwn(target, "modelProfileId")
          ? { modelProfileId: parseProfileId(target.modelProfileId) }
          : {}),
      },
    };
  }
  if (
    exactObject(target, ["kind", "localProfileId", "confirmation"]) &&
    target.kind === "claim" &&
    target.confirmation === "claim-existing-profile"
  ) {
    return {
      id,
      target: {
        kind: "claim",
        localProfileId: parseProfileId(target.localProfileId),
        confirmation: "claim-existing-profile",
      },
    };
  }
  return invalidRequest();
}

export function parseSelectInstallationVersionInput(
  value: unknown,
): AgenteraSelectInstallationVersionInput {
  if (!exactObject(value, ["id", "versionId", "localProfileId"])) {
    return invalidRequest();
  }
  return {
    id: parseAgentControlId(value.id),
    versionId: parseAgentControlId(value.versionId),
    localProfileId: parseProfileId(value.localProfileId),
  };
}

export function parseRepairInstallationModelInput(
  value: unknown,
): AgenteraRepairInstallationModelInput {
  if (!exactObject(value, ["id", "localProfileId", "modelProfileId"])) {
    return invalidRequest();
  }
  return {
    id: parseAgentControlId(value.id),
    localProfileId: parseProfileId(value.localProfileId),
    modelProfileId: parseProfileId(value.modelProfileId),
  };
}

export function parsePrepareExperienceCandidateInput(
  value: unknown,
): PrepareExperienceCandidateInput {
  if (!exactObject(value, ["installationId", "skillName"])) {
    return invalidRequest();
  }
  if (
    typeof value.skillName !== "string" ||
    !SKILL_NAME_PATTERN.test(value.skillName)
  ) {
    return invalidRequest();
  }
  return {
    installationId: parseAgentControlId(value.installationId),
    skillName: value.skillName,
  };
}

export function parseSubmitExperienceCandidateInput(
  value: unknown,
): SubmitExperienceCandidateInput {
  if (
    !exactObject(value, ["candidateId", "confirmation"]) ||
    value.confirmation !== "submit-selected-skill"
  ) {
    return invalidRequest();
  }
  return {
    candidateId: parseAgentControlId(value.candidateId),
    confirmation: "submit-selected-skill",
  };
}

export function parseReviewExperienceCandidateInput(
  value: unknown,
): ReviewExperienceCandidateInput {
  if (
    !exactObject(value, ["candidateId", "decision", "reasonCode", "safeNote"])
  ) {
    return invalidRequest();
  }
  const candidateId = parseAgentControlId(value.candidateId);
  if (value.decision === "APPROVED") {
    if (value.reasonCode !== null || value.safeNote !== null) {
      return invalidRequest();
    }
    return {
      candidateId,
      decision: "APPROVED",
      reasonCode: null,
      safeNote: null,
    };
  }
  if (
    value.decision !== "REJECTED" ||
    typeof value.reasonCode !== "string" ||
    !REASON_CODE_PATTERN.test(value.reasonCode) ||
    (value.safeNote !== null &&
      (typeof value.safeNote !== "string" ||
        value.safeNote.length < 1 ||
        value.safeNote.length > MAX_SAFE_NOTE_LENGTH ||
        /[\r\n\0]/.test(value.safeNote)))
  ) {
    return invalidRequest();
  }
  return {
    candidateId,
    decision: "REJECTED",
    reasonCode: value.reasonCode,
    safeNote: value.safeNote,
  };
}

export function parseConfirmExperienceCandidateImportInput(
  value: unknown,
): ConfirmExperienceCandidateImportInput {
  if (
    !exactObject(value, ["importHandle", "confirmation"]) ||
    value.confirmation !== "apply-approved-skill-to-latest"
  ) {
    return invalidRequest();
  }
  return {
    importHandle: parseAgentControlId(value.importHandle),
    confirmation: "apply-approved-skill-to-latest",
  };
}

export function parseConfirmOrganizationSubmissionInput(
  value: unknown,
): ConfirmOrganizationSubmissionInput {
  if (
    !exactObject(value, ["publicationHandle", "confirmation"]) ||
    value.confirmation !== "submit-organization-agent"
  ) {
    return invalidRequest();
  }
  return {
    publicationHandle: parseAgentControlId(value.publicationHandle),
    confirmation: "submit-organization-agent",
  };
}

export function parsePrepareOrganizationReviewInput(
  value: unknown,
): PrepareOrganizationReviewInput {
  if (
    !exactObject(value, ["submissionId", "decision", "reasonCode", "safeNote"])
  ) {
    return invalidRequest();
  }
  const submissionId = parseAgentControlId(value.submissionId);
  if (value.decision === "approve") {
    if (value.reasonCode !== null || value.safeNote !== null) {
      return invalidRequest();
    }
    return {
      submissionId,
      decision: "approve",
      reasonCode: null,
      safeNote: null,
    };
  }
  if (
    value.decision !== "reject" ||
    typeof value.reasonCode !== "string" ||
    !REASON_CODE_PATTERN.test(value.reasonCode) ||
    (value.safeNote !== null &&
      (typeof value.safeNote !== "string" ||
        value.safeNote.length < 1 ||
        value.safeNote.length > MAX_ORGANIZATION_SAFE_NOTE_LENGTH ||
        /[\r\n\0]/.test(value.safeNote)))
  ) {
    return invalidRequest();
  }
  return {
    submissionId,
    decision: "reject",
    reasonCode: value.reasonCode,
    safeNote: value.safeNote,
  };
}

export function parseConfirmOrganizationReviewInput(
  value: unknown,
): ConfirmOrganizationReviewInput {
  if (
    !exactObject(value, ["reviewHandle", "confirmation"]) ||
    (value.confirmation !== "approve-organization-agent" &&
      value.confirmation !== "reject-organization-agent")
  ) {
    return invalidRequest();
  }
  return {
    reviewHandle: parseAgentControlId(value.reviewHandle),
    confirmation: value.confirmation,
  };
}

export function parseConfirmOrganizationWithdrawalInput(
  value: unknown,
): ConfirmOrganizationWithdrawalInput {
  if (
    !exactObject(value, ["withdrawalHandle", "confirmation"]) ||
    value.confirmation !== "withdraw-organization-agent"
  ) {
    return invalidRequest();
  }
  return {
    withdrawalHandle: parseAgentControlId(value.withdrawalHandle),
    confirmation: "withdraw-organization-agent",
  };
}

function safeFindingPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("://") ||
    (value.length >= 2 && value[1] === ":") ||
    Buffer.byteLength(value, "utf8") > MAX_FINDING_PATH_BYTES
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length >= 3 &&
    segments[0] === "skills" &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith("."),
    )
  );
}

function safeOrganizationFindingPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("://") ||
    (value.length >= 2 && value[1] === ":") ||
    Buffer.byteLength(value, "utf8") > MAX_FINDING_PATH_BYTES
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith("."),
    );
}

function sanitizeExperienceCandidateFindings(
  error: unknown,
  pathValidator: (value: unknown) => value is string = safeFindingPath,
): ExperienceCandidateFinding[] {
  if (error === null || typeof error !== "object") return [];
  const raw = (error as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return [];
  const findings: ExperienceCandidateFinding[] = [];
  for (const candidate of raw.slice(0, MAX_IPC_FINDINGS)) {
    if (candidate === null || typeof candidate !== "object") continue;
    const finding = candidate as {
      code?: unknown;
      path?: unknown;
      line?: unknown;
    };
    if (
      typeof finding.code !== "string" ||
      !FINDING_CODE_PATTERN.test(finding.code) ||
      !pathValidator(finding.path) ||
      !(
        finding.line === null ||
        (Number.isSafeInteger(finding.line) && (finding.line as number) >= 1)
      )
    ) {
      continue;
    }
    findings.push({
      code: finding.code,
      path: finding.path,
      line: finding.line as number | null,
    });
  }
  return findings;
}

function mappedCode(error: unknown): AgenteraAgentControlErrorCode {
  const code =
    error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  if (code === "local_runtime_required") return "local_runtime_required";
  if (
    code === "authorization_expired" ||
    code === "offline_expired" ||
    code === "entitlement_required"
  ) {
    return "entitlement_required";
  }
  if (
    code === "draft_not_found" ||
    code === "installation_not_found" ||
    code === "candidate_not_found" ||
    code === "not_found" ||
    code === "cache_not_found"
  ) {
    return "not_found";
  }
  if (
    code === "organization_agent_not_found" ||
    code === "organization_agent_forbidden" ||
    code === "organization_archived" ||
    code === "organization_submission_conflict" ||
    code === "organization_submission_superseded" ||
    code === "organization_publication_policy_blocked" ||
    code === "organization_publication_dlp_blocked"
  ) {
    return code;
  }
  if (
    code === "official_agent_not_eligible" ||
    code === "official_release_paused" ||
    code === "official_client_version_unsupported" ||
    code === "official_installation_policy_blocked"
  ) {
    return code;
  }
  if (code === "official_install_handle_invalid") return "invalid_request";
  if (code === "official_release_changed") return "conflict";
  if (
    code.includes("conflict") ||
    code === "draft_conflict" ||
    code === "version_revoked" ||
    code === "installation_archived"
  ) {
    return "conflict";
  }
  if (
    code === "verification_failed" ||
    code.includes("signature") ||
    code.includes("digest") ||
    code === "cache_corrupt" ||
    code === "published_content_mismatch" ||
    // Trust-store faults are verification failures, not malformed requests.
    // Without these the `invalid_` prefix rule below would report a key or
    // cache problem as an invalid request.
    code === "unknown_signing_key" ||
    code === "issuer_mismatch" ||
    code === "signing_purpose_mismatch" ||
    code === "invalid_signing_keys" ||
    code === "invalid_trust_cache"
  ) {
    return "verification_failed";
  }
  if (code === "runtime_incompatible" || code === "runtime_drift") {
    return "runtime_incompatible";
  }
  if (
    code === "service_unavailable" ||
    code === "creation_failed" ||
    code === "cloud_unavailable"
  ) {
    return "cloud_unavailable";
  }
  if (code === "sign_in_required" || code === "invalid_credentials") {
    return "sign_in_required";
  }
  if (code === "online_required") return "online_required";
  if (code === "workspace_forbidden") return "workspace_forbidden";
  if (code === "workspace_archived") return "workspace_archived";
  if (code === "workspace_owner_unavailable") {
    return "workspace_owner_unavailable";
  }
  if (code === "candidate_source_ineligible") {
    return "candidate_source_ineligible";
  }
  if (code === "candidate_dlp_blocked") return "candidate_dlp_blocked";
  if (code === "candidate_already_reviewed") {
    return "candidate_already_reviewed";
  }
  if (code === "candidate_not_approved") return "candidate_not_approved";
  if (code === "candidate_base_advanced") return "candidate_base_advanced";
  if (code === "candidate_import_failed") return "candidate_import_failed";
  if (code.startsWith("invalid_")) return "invalid_request";
  return "operation_failed";
}

export async function executeAgentControlIpc<T>(
  task: () => T | Promise<T>,
): Promise<AgenteraAgentControlResult<T>> {
  try {
    return { ok: true, data: await task() };
  } catch (error) {
    const errorCode = mappedCode(error);
    if (errorCode === "candidate_dlp_blocked") {
      const findings = sanitizeExperienceCandidateFindings(error);
      if (findings.length > 0) {
        return { ok: false, errorCode, findings };
      }
    }
    if (errorCode === "organization_publication_dlp_blocked") {
      const findings = sanitizeExperienceCandidateFindings(
        error,
        safeOrganizationFindingPath,
      );
      if (findings.length > 0) {
        return { ok: false, errorCode, findings };
      }
    }
    return { ok: false, errorCode };
  }
}

function safeDigest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    return invalidRequest();
  }
  return value;
}

function safeAssetCounts(
  value: Record<AgentDraftAssetKind, number>,
): Record<AgentDraftAssetKind, number> {
  const result = {
    skill: value.skill,
    sop: value.sop,
    knowledge: value.knowledge,
  };
  if (
    !Object.values(result).every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  ) {
    return invalidRequest();
  }
  return result;
}

export function serializeOrganizationAgentSubmission(
  value: OrganizationAgentSubmissionSummary,
): OrganizationAgentSubmissionSummary {
  return {
    id: parseAgentControlId(value.id),
    organizationId: parseAgentControlId(value.organizationId),
    kind: value.kind,
    definitionId: parseAgentControlId(value.definitionId),
    baseVersionId:
      value.baseVersionId === null
        ? null
        : parseAgentControlId(value.baseVersionId),
    submittedByUserId: parseAgentControlId(value.submittedByUserId),
    contentDigest: safeDigest(value.contentDigest),
    status: value.status,
    revision: value.revision,
    submittedAt: value.submittedAt,
    terminalAt: value.terminalAt,
    review:
      value.review === null
        ? null
        : {
            id: parseAgentControlId(value.review.id),
            reviewerUserId: parseAgentControlId(value.review.reviewerUserId),
            decision: value.review.decision,
            reasonCode: value.review.reasonCode,
            safeNote: value.review.safeNote,
            organizationPolicySnapshotId: parseAgentControlId(
              value.review.organizationPolicySnapshotId,
            ),
            organizationPolicyVersion: value.review.organizationPolicyVersion,
            reviewedContentDigest: safeDigest(
              value.review.reviewedContentDigest,
            ),
            reviewedAt: value.review.reviewedAt,
          },
  };
}

export function serializeOrganizationSubmissionPreview(
  value: MainOrganizationSubmissionPreview,
): OrganizationSubmissionPreview {
  return {
    publicationHandle: parseAgentControlId(value.publicationHandle),
    draftId: parseAgentControlId(value.draftId),
    revision: value.revision,
    kind: value.kind,
    definitionId:
      value.definitionId === null
        ? null
        : parseAgentControlId(value.definitionId),
    baseVersionId:
      value.baseVersionId === null
        ? null
        : parseAgentControlId(value.baseVersionId),
    contentDigest: safeDigest(value.contentDigest),
    assetCounts: safeAssetCounts(value.assetCounts),
    totalBytes: value.totalBytes,
    expiresAt: value.expiresAt,
  };
}

export function serializeOrganizationSubmissionDetail(
  value: MainOrganizationAgentSubmissionDetail,
): OrganizationAgentSubmissionDetail {
  const bundle = new Map(
    value.bundle.assets.map((asset) => [asset.path, asset.content] as const),
  );
  const assets = value.manifest.assets.map((asset) => {
    const content = bundle.get(asset.path);
    if (content === undefined) return invalidRequest();
    bundle.delete(asset.path);
    return {
      path: asset.path,
      kind: asset.kind,
      mediaType: asset.media_type,
      sha256: safeDigest(asset.sha256),
      content,
      sizeBytes: Buffer.byteLength(content, "utf8"),
    };
  });
  if (bundle.size !== 0) return invalidRequest();
  const assetCounts = { skill: 0, sop: 0, knowledge: 0 };
  for (const asset of assets) assetCounts[asset.kind] += 1;
  const totalBytes = assets.reduce(
    (total, asset) => total + asset.sizeBytes,
    0,
  );
  if (totalBytes !== value.totalBytes) return invalidRequest();
  return {
    summary: serializeOrganizationAgentSubmission(value.summary),
    displayName: value.displayName,
    icon:
      value.icon === null
        ? null
        : {
            mediaType: value.icon.mediaType,
            dataBase64Url: value.icon.dataBase64Url,
          },
    systemPrompt: value.manifest.identity.system_prompt,
    assets,
    modelConstraints: {
      allowedProviders: [...value.manifest.model_constraints.allowed_providers],
      allowedModels: [...value.manifest.model_constraints.allowed_models],
    },
    tools: {
      allowed: [...value.manifest.tools.allowed],
      denied: [...value.manifest.tools.denied],
    },
    dependencies: value.manifest.dependencies.map((dependency) => ({
      agentDefinitionId: parseAgentControlId(dependency.agent_definition_id),
      agentVersionId: parseAgentControlId(dependency.agent_version_id),
    })),
    runtimeCompatibility: {
      minimumVersion: value.manifest.runtime_compatibility.minimum_version,
      maximumVersionExclusive:
        value.manifest.runtime_compatibility.maximum_version_exclusive ?? null,
    },
    manifestDigest: safeDigest(value.manifestDigest),
    bundleDigest: safeDigest(value.bundleDigest),
    assetCounts,
    totalBytes,
  };
}

export function serializeOrganizationReviewPreview(
  value: MainOrganizationReviewPreview,
): OrganizationReviewPreview {
  return {
    reviewHandle:
      value.reviewHandle === null
        ? null
        : parseAgentControlId(value.reviewHandle),
    selfReview: value.selfReview,
    decision: value.decision,
    reasonCode: value.reasonCode,
    safeNote: value.safeNote,
    detail: serializeOrganizationSubmissionDetail(value.detail),
    expiresAt: value.expiresAt,
  };
}

export function serializeOrganizationWithdrawalPreview(
  value: MainOrganizationWithdrawalPreview,
): OrganizationWithdrawalPreview {
  return {
    withdrawalHandle: parseAgentControlId(value.withdrawalHandle),
    submission: serializeOrganizationAgentSubmission(value.submission),
    revision: value.revision,
    contentDigest: safeDigest(value.contentDigest),
    expiresAt: value.expiresAt,
  };
}

export function serializeDefinition(
  definition: AgentDefinition,
): AgenteraAgentDefinitionSummary {
  return {
    id: parseAgentControlId(definition.id),
    displayName: definition.display_name,
    status: definition.status,
    latestVersionId: definition.latest_version_id ?? null,
    createdAt: definition.created_at,
    updatedAt: definition.updated_at,
  };
}

export function serializeVersion(
  version: AgentVersion,
): AgenteraAgentVersionSummary {
  const assetCounts: Record<AgentDraftAssetKind, number> = {
    skill: 0,
    sop: 0,
    knowledge: 0,
  };
  for (const asset of version.manifest.assets) assetCounts[asset.kind] += 1;
  return {
    id: parseAgentControlId(version.id),
    definitionId: parseAgentControlId(version.definition_id),
    versionNumber: version.version_number,
    contentDigest: version.content_digest,
    publishedAt: version.published_at,
    runtimeMinimumVersion: version.runtime_minimum_version,
    runtimeMaximumVersionExclusive:
      version.runtime_maximum_version_exclusive ?? null,
    assetCounts,
  };
}

export function serializeInstallation(
  installation: LocalAgentInstallation,
): AgenteraAgentInstallationSummary {
  return {
    id: installation.agentInstallationId,
    sourceScope: installation.sourceScope,
    officialReleaseId: installation.officialReleaseId,
    selectedReleaseRevisionId: installation.selectedReleaseRevisionId,
    updatePolicy: installation.updatePolicy,
    definitionId: installation.definitionId,
    selectedVersionId: installation.selectedVersionId,
    runtimeProfileId: installation.runtimeProfileId,
    policySnapshotId: installation.policySnapshotId,
    status: installation.status,
    retryCode: installation.retryCode,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  };
}

/** Marker used by type-level boundary tests: drafts are already exact public DTOs. */
export function serializeDraft(draft: AgentDraft): AgentDraft {
  return draft;
}
