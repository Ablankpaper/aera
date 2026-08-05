export type AgentDraftAssetKind = "skill" | "sop" | "knowledge";
export type AgentDraftAssetMediaType = "text/markdown" | "text/plain";
export type AgentDraftIconMediaType = "image/png" | "image/webp";
export type OfficialAgentChannel = "internal" | "stable";

/**
 * A renderer may explicitly operate on the signed-in user's private Agent
 * assets while the shell remains inside an Organization context. Arbitrary
 * tenant identifiers are deliberately not accepted at this boundary.
 */
export type AgenteraAgentOperationScope = "USER";

export interface OfficialAgentSummary {
  definitionId: string;
  displayName: string;
  iconMediaType: "image/png" | "image/webp" | null;
  iconDataBase64Url: string | null;
  versionId: string;
  versionNumber: number;
  releaseId: string;
  releaseRevisionId: string;
  channel: OfficialAgentChannel;
  runtimeMinimumVersion: string;
  runtimeMaximumVersionExclusive: string | null;
  installationState: "not_installed" | "installed";
  updateState: "current" | "update_available";
}

/**
 * Renderer-safe presentation metadata for one eligible official Agent.
 * Signed bytes, bundle contents, keys, rollout inputs, owner identity, and
 * Runtime Profile paths deliberately stay in the main process.
 */
export interface OfficialAgentDetail {
  agent: OfficialAgentSummary;
  capabilitySummary: string;
  assetCounts: Record<AgentDraftAssetKind, number>;
  allowedProviders: string[];
  allowedModels: string[];
  allowedToolCount: number;
}

export interface OfficialManagedUpdate {
  installationId: string;
  expectedSelectedReleaseRevisionId: string;
  targetReleaseRevisionId: string;
  targetVersionId: string;
}

export interface OfficialAgentInstallPreview {
  installHandle: string;
  agent: OfficialAgentSummary;
  expiresAt: string;
}

export interface ConfirmOfficialAgentInstallInput {
  installHandle: string;
  confirmation: "install-official-agent";
}

export interface AgentEditableManifestAsset {
  path: string;
  kind: AgentDraftAssetKind;
  mediaType: AgentDraftAssetMediaType;
}

export interface AgentEditableDependency {
  agentDefinitionId: string;
  agentVersionId: string;
}

export type AgentModelSelectionMode = "user_select" | "allowlist" | "fixed";

interface AgentEditableManifestBase {
  identity: {
    systemPrompt: string;
  };
  assets: AgentEditableManifestAsset[];
  tools: {
    allowed: string[];
    denied: string[];
  };
  dependencies: AgentEditableDependency[];
  runtimeCompatibility: {
    minimumVersion: string;
    maximumVersionExclusive: string | null;
  };
}

export interface AgentEditableManifestV1 extends AgentEditableManifestBase {
  schemaVersion: 1;
  modelConstraints: {
    allowedProviders: string[];
    allowedModels: string[];
  };
}

export interface AgentEditableManifestV2 extends AgentEditableManifestBase {
  schemaVersion: 2;
  modelPolicy: {
    mode: AgentModelSelectionMode;
    allowedProviders: string[];
    allowedModels: string[];
  };
}

export type AgentEditableManifest =
  | AgentEditableManifestV1
  | AgentEditableManifestV2;

export interface AgentRuntimeModelPolicy {
  mode: AgentModelSelectionMode;
  allowedProviders: readonly string[];
  allowedModels: readonly string[];
}

export function runtimeModelPolicyForEditableManifest(
  manifest: AgentEditableManifest,
): AgentRuntimeModelPolicy {
  if (manifest.schemaVersion === 2) return manifest.modelPolicy;
  return {
    mode: "allowlist",
    allowedProviders: manifest.modelConstraints.allowedProviders,
    allowedModels: manifest.modelConstraints.allowedModels,
  };
}

export interface AgentDraftAssetInput {
  path: string;
  content: string;
}

export interface AgentDraftAssetMetadata {
  path: string;
  kind: AgentDraftAssetKind;
  mediaType: AgentDraftAssetMediaType;
  sizeBytes: number;
  sha256: string;
}

export interface AgentDraftIcon {
  mediaType: AgentDraftIconMediaType;
  dataBase64: string;
}

export interface AgentDraftPublicationAttempt {
  revision: number;
  attemptedAt: string;
  errorCode: string | null;
  errorSummary: string | null;
}

export interface AgentDraftPublishedRevision {
  revision: number;
  definitionId: string;
  versionId: string;
}

/**
 * Renderer-safe local draft. Ownership, device identity, paths, signing data,
 * credentials, raw server errors, and Runtime Profile content are absent by
 * construction rather than removed with an object spread at the IPC edge.
 */
export interface AgentDraft {
  id: string;
  sourceAgentDefinitionId: string | null;
  baseAgentVersionId: string | null;
  displayName: string;
  icon: AgentDraftIcon | null;
  manifest: AgentEditableManifest;
  assets: AgentDraftAssetMetadata[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastPublicationAttempt: AgentDraftPublicationAttempt | null;
  publishedRevision: AgentDraftPublishedRevision | null;
}

/**
 * Renderer-safe editable detail for one explicitly opened local draft. These
 * bytes belong to the draft itself; they are never read from a Hermes Profile.
 */
export interface AgentDraftDetail extends AgentDraft {
  editableAssets: AgentDraftAssetInput[];
}

export interface CreateAgentDraftInput {
  sourceAgentDefinitionId: string | null;
  baseAgentVersionId: string | null;
  displayName: string;
  icon: AgentDraftIcon | null;
  manifest: AgentEditableManifest;
  assets: AgentDraftAssetInput[];
}

export interface UpdateAgentDraftInput {
  id: string;
  expectedRevision: number;
  displayName: string;
  icon: AgentDraftIcon | null;
  manifest: AgentEditableManifest;
  assets: AgentDraftAssetInput[];
}

export interface AgentDraftPublicationIdentity {
  revision: number;
  attemptedAt: string;
  idempotencyKey: string;
}

export interface PublicationPreview {
  publicationHandle: string;
  draftId: string;
  revision: number;
  targetScope: "USER" | "WORKSPACE";
  assetCounts: Record<AgentDraftAssetKind, number>;
  totalBytes: number;
}

export interface PublishedRevision {
  draftId: string;
  revision: number;
  definitionId: string;
  versionId: string;
  versionNumber: number;
  contentDigest: string;
  publishedAt: string;
  replayed: boolean;
}

export type AgenteraAgentControlContext =
  | { scope: "USER" }
  | {
      scope: "WORKSPACE";
      workspaceId: string;
      role: "owner" | "admin" | "member";
    }
  | {
      scope: "ORGANIZATION";
      organizationId: string;
      role: "owner" | "admin" | "auditor" | "member";
    };

export type OrganizationAgentSubmissionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "withdrawn"
  | "superseded";

export interface OrganizationAgentReview {
  id: string;
  reviewerUserId: string;
  decision: "approve" | "reject";
  reasonCode: string | null;
  safeNote: string | null;
  organizationPolicySnapshotId: string;
  organizationPolicyVersion: number;
  reviewedContentDigest: string;
  reviewedAt: string;
}

export interface OrganizationAgentSubmissionSummary {
  id: string;
  organizationId: string;
  kind: "initial" | "next";
  definitionId: string;
  baseVersionId: string | null;
  publishedVersionId: string | null;
  localDraftId: string | null;
  localDraftRevision: number | null;
  submittedByUserId: string;
  contentDigest: string;
  status: OrganizationAgentSubmissionStatus;
  revision: number;
  submittedAt: string;
  terminalAt: string | null;
  review: OrganizationAgentReview | null;
}

export interface OrganizationSubmissionPreview {
  publicationHandle: string;
  draftId: string;
  revision: number;
  kind: "initial" | "next";
  definitionId: string | null;
  baseVersionId: string | null;
  contentDigest: string;
  assetCounts: Record<AgentDraftAssetKind, number>;
  totalBytes: number;
  expiresAt: string;
}

export interface OrganizationAgentSubmissionAsset {
  path: string;
  kind: AgentDraftAssetKind;
  mediaType: AgentDraftAssetMediaType;
  sha256: string;
  content: string;
  sizeBytes: number;
}

/**
 * Renderer-safe immutable review package. It contains only the explicitly
 * submitted Agent product asset; Organization policy bytes, credentials,
 * Profile paths, Memory, sessions, and private learned Skills are absent.
 */
export interface OrganizationAgentSubmissionDetail {
  summary: OrganizationAgentSubmissionSummary;
  displayName: string | null;
  icon: {
    mediaType: AgentDraftIconMediaType;
    dataBase64Url: string;
  } | null;
  systemPrompt: string;
  assets: OrganizationAgentSubmissionAsset[];
  modelConstraints: {
    allowedProviders: string[];
    allowedModels: string[];
  };
  tools: {
    allowed: string[];
    denied: string[];
  };
  dependencies: Array<{
    agentDefinitionId: string;
    agentVersionId: string;
  }>;
  runtimeCompatibility: {
    minimumVersion: string;
    maximumVersionExclusive: string | null;
  };
  manifestDigest: string;
  bundleDigest: string;
  assetCounts: Record<AgentDraftAssetKind, number>;
  totalBytes: number;
}

export interface OrganizationReviewPreview {
  reviewHandle: string | null;
  selfReview: boolean;
  decision: "approve" | "reject";
  reasonCode: string | null;
  safeNote: string | null;
  detail: OrganizationAgentSubmissionDetail;
  expiresAt: string | null;
}

export interface OrganizationWithdrawalPreview {
  withdrawalHandle: string;
  submission: OrganizationAgentSubmissionSummary;
  revision: number;
  contentDigest: string;
  expiresAt: string;
}

/**
 * Mutation confirmation types deliberately carry only a one-use opaque handle
 * and an exact phrase. Trusted Organization identity and role stay in main.
 */
export interface ConfirmOrganizationSubmissionInput {
  publicationHandle: string;
  confirmation: "submit-organization-agent";
}

export interface PrepareOrganizationReviewInput {
  submissionId: string;
  decision: "approve" | "reject";
  reasonCode: string | null;
  safeNote: string | null;
}

export interface ConfirmOrganizationReviewInput {
  reviewHandle: string;
  confirmation: "approve-organization-agent" | "reject-organization-agent";
}

export interface ConfirmOrganizationWithdrawalInput {
  withdrawalHandle: string;
  confirmation: "withdraw-organization-agent";
}

export type AgenteraAgentControlErrorCode =
  | "invalid_request"
  | "sign_in_required"
  | "online_required"
  | "entitlement_required"
  | "not_found"
  | "conflict"
  | "verification_failed"
  | "signature_verification_failed"
  | "published_content_mismatch"
  | "publication_cache_failed"
  | "publication_cache_conflict"
  | "publication_cache_corrupt"
  | "publication_cache_permissions_invalid"
  | "publication_cache_filesystem_denied"
  | "publication_cache_filesystem_failed"
  | "publication_cache_database_failed"
  | "publication_cache_recovery_failed"
  | "runtime_incompatible"
  | "profile_model_configuration_failed"
  | "local_runtime_required"
  | "cloud_unavailable"
  | "workspace_forbidden"
  | "workspace_archived"
  | "workspace_owner_unavailable"
  | "organization_agent_not_found"
  | "organization_agent_forbidden"
  | "organization_archived"
  | "organization_submission_conflict"
  | "organization_submission_superseded"
  | "organization_publication_policy_blocked"
  | "organization_publication_dlp_blocked"
  | "official_agent_not_eligible"
  | "official_release_paused"
  | "official_client_version_unsupported"
  | "official_installation_policy_blocked"
  | "candidate_source_ineligible"
  | "candidate_dlp_blocked"
  | "candidate_already_reviewed"
  | "candidate_not_approved"
  | "candidate_base_advanced"
  | "candidate_import_failed"
  | "operation_failed";

export type AgenteraAgentControlResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      errorCode: AgenteraAgentControlErrorCode;
      findings?: ExperienceCandidateFinding[];
    };

export interface AgenteraAgentControlPublicState {
  access: "online" | "offline";
  cloudAvailable: boolean;
  context: AgenteraAgentControlContext;
  draftCount: number;
  installationCount: number;
}

export interface AgenteraAgentDefinitionSummary {
  id: string;
  displayName: string;
  status: "active" | "archived";
  latestVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgenteraAgentVersionSummary {
  id: string;
  definitionId: string;
  versionNumber: number;
  contentDigest: string;
  publishedAt: string;
  runtimeMinimumVersion: string;
  runtimeMaximumVersionExclusive: string | null;
  assetCounts: Record<AgentDraftAssetKind, number>;
}

export interface AgenteraAgentInstallationSummary {
  id: string;
  sourceScope: "USER" | "WORKSPACE" | "ORGANIZATION" | "PLATFORM";
  officialReleaseId: string | null;
  selectedReleaseRevisionId: string | null;
  updatePolicy: "manual" | "managed";
  definitionId: string;
  selectedVersionId: string;
  runtimeProfileId: string | null;
  policySnapshotId: string | null;
  status: "pending" | "active" | "archived";
  retryCode: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A local, credential-backed model route eligible for one Agent Runtime. */
export interface AgentRuntimeModelRoute {
  /** Profile + library-row identity; local only and never published. */
  id: string;
  sourceProfileId: string;
  modelLibraryId: string;
  provider: string;
  providerLabel: string;
  model: string;
  displayName: string;
  baseUrl: string;
}

/** Renderer selection revalidated by Main before any Runtime Profile write. */
export interface AgentRuntimeModelSelection {
  sourceProfileId: string;
  modelLibraryId: string;
}

export interface AgenteraInstallVersionInput {
  definitionId: string;
  versionId: string;
  profileName: string;
  modelProfileId?: string;
  modelSelection?: AgentRuntimeModelSelection;
}

export interface AgenteraClaimVersionInput {
  definitionId: string;
  versionId: string;
  localProfileId: string;
  confirmation: "claim-existing-profile";
}

export type AgenteraPendingInstallationTarget =
  | {
      kind: "fresh";
      profileName: string;
      modelProfileId?: string;
      modelSelection?: AgentRuntimeModelSelection;
    }
  | {
      kind: "claim";
      localProfileId: string;
      confirmation: "claim-existing-profile";
    };

export interface AgenteraRetryPendingInstallationInput {
  id: string;
  target: AgenteraPendingInstallationTarget;
}

export interface AgenteraSelectInstallationVersionInput {
  id: string;
  versionId: string;
  localProfileId: string;
}

export interface AgenteraRepairInstallationModelInput {
  id: string;
  localProfileId: string;
  modelProfileId?: string;
  modelSelection?: AgentRuntimeModelSelection;
}

export interface EligibleExperienceSkill {
  skillName: string;
  description: string;
}

export interface PrepareExperienceCandidateInput {
  installationId: string;
  skillName: string;
}

export interface SubmitExperienceCandidateInput {
  candidateId: string;
  confirmation: "submit-selected-skill";
}

export interface ReviewExperienceCandidateInput {
  candidateId: string;
  decision: "APPROVED" | "REJECTED";
  reasonCode: string | null;
  safeNote: string | null;
}

export interface ExperienceCandidateImportPreview {
  importHandle: string;
  candidateId: string;
  sourceVersionId: string;
  latestVersionId: string;
  latestVersionNumber: number;
  skillName: string;
  replacesExistingSkill: boolean;
  addedPaths: string[];
  replacedPaths: string[];
  removedPaths: string[];
}

export interface ConfirmExperienceCandidateImportInput {
  importHandle: string;
  confirmation: "apply-approved-skill-to-latest";
}

export type ExperienceCandidateLocalStatus =
  | "PREPARED"
  | "UPLOAD_FAILED"
  | "SUBMITTED";

/**
 * Renderer-safe receipt for a local Organization experience snapshot. Runtime
 * Profile IDs, source paths, snapshot paths, and private bytes remain in the
 * main-process SQLite partition and are absent by construction.
 */
export interface OrganizationExperienceCandidateLocalReceipt {
  id: string;
  agentInstallationId: string;
  organizationId: string;
  agentDefinitionId: string;
  sourceAgentVersionId: string;
  skillName: string;
  contentDigest: string;
  status: ExperienceCandidateLocalStatus;
  cloudCandidateId: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

export interface OrganizationExperienceCandidateImportReceipt {
  candidateId: string;
  organizationId: string;
  agentDefinitionId: string;
  baseAgentVersionId: string;
  candidateContentDigest: string;
  draftId: string;
  importedAt: string;
}

export interface OrganizationExperienceCandidatePreview {
  candidateHandle: string;
  installationId: string;
  sourceAgentVersionId: string;
  skillName: string;
  assets: Array<{
    path: string;
    mediaType: "text/markdown" | "text/plain";
    sizeBytes: number;
  }>;
  fileCount: number;
  totalBytes: number;
  contentDigest: string;
  findings: ExperienceCandidateFinding[];
}

export interface PrepareOrganizationExperienceCandidateInput {
  installationId: string;
  skillName: string;
}

export interface SubmitOrganizationExperienceCandidateInput {
  candidateHandle: string;
  confirmation: "submit-selected-organization-skill";
}

export interface ReviewOrganizationExperienceCandidateInput {
  reviewHandle: string;
  confirmation:
    | "approve-organization-experience"
    | "reject-organization-experience";
  reasonCode: string | null;
  safeNote: string | null;
}

export interface OrganizationExperienceCandidateSummary {
  candidateHandle: string | null;
  reviewHandle: string | null;
  cloudCandidateId: string | null;
  organizationId: string;
  agentDefinitionId: string;
  sourceAgentVersionId: string;
  skillName: string;
  contentDigest: string;
  localStatus: ExperienceCandidateLocalStatus | null;
  reviewStatus: ExperienceCandidateReviewStatus | null;
  lastErrorCode: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface OrganizationExperienceCandidateDetail extends OrganizationExperienceCandidateSummary {
  bundle: ExperienceCandidateBundleV1;
  decisionReasonCode: string | null;
  safeNote: string | null;
}

export interface OrganizationExperienceCandidateImportPreview extends ExperienceCandidateImportPreview {}

export interface ConfirmOrganizationExperienceCandidateImportInput {
  importHandle: string;
  confirmation: "apply-approved-skill-to-organization-draft";
}

export interface ExperienceCandidateAssetV1 {
  path: string;
  mediaType: "text/markdown" | "text/plain";
  content: string;
}

export interface ExperienceCandidateBundleV1 {
  schemaVersion: 1;
  skillName: string;
  assets: ExperienceCandidateAssetV1[];
}

export interface CanonicalExperienceCandidate {
  bundle: ExperienceCandidateBundleV1;
  canonicalJson: string;
  contentDigest: string;
}

export interface ExperienceCandidateFinding {
  code: string;
  path: string;
  line: number | null;
}

export type ExperienceCandidateReviewStatus =
  | "PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED";

export interface ExperienceCandidatePreview {
  localCandidateId: string;
  installationId: string;
  sourceAgentVersionId: string;
  skillName: string;
  assets: Array<{
    path: string;
    mediaType: "text/markdown" | "text/plain";
    sizeBytes: number;
  }>;
  fileCount: number;
  totalBytes: number;
  contentDigest: string;
  findings: ExperienceCandidateFinding[];
}

export interface ExperienceCandidateSummary {
  localCandidateId: string | null;
  cloudCandidateId: string | null;
  agentDefinitionId: string;
  sourceAgentVersionId: string;
  skillName: string;
  contentDigest: string;
  localStatus: ExperienceCandidateLocalStatus | null;
  reviewStatus: ExperienceCandidateReviewStatus | null;
  lastErrorCode: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface ExperienceCandidateDetail extends ExperienceCandidateSummary {
  bundle: ExperienceCandidateBundleV1;
  decisionReasonCode: string | null;
  safeNote: string | null;
}
