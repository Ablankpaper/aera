export type AgentDraftAssetKind = "skill" | "sop" | "knowledge";
export type AgentDraftAssetMediaType = "text/markdown" | "text/plain";
export type AgentDraftIconMediaType = "image/png" | "image/webp";

export interface AgentEditableManifestAsset {
  path: string;
  kind: AgentDraftAssetKind;
  mediaType: AgentDraftAssetMediaType;
}

export interface AgentEditableDependency {
  agentDefinitionId: string;
  agentVersionId: string;
}

export interface AgentEditableManifest {
  schemaVersion: 1;
  identity: {
    systemPrompt: string;
  };
  assets: AgentEditableManifestAsset[];
  modelConstraints: {
    allowedProviders: string[];
    allowedModels: string[];
  };
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
      scope: "ORGANIZATION_UNAVAILABLE";
      organizationId: string;
      role: "owner" | "admin" | "auditor" | "member";
    };

export type AgenteraAgentControlErrorCode =
  | "invalid_request"
  | "sign_in_required"
  | "online_required"
  | "entitlement_required"
  | "not_found"
  | "conflict"
  | "verification_failed"
  | "runtime_incompatible"
  | "local_runtime_required"
  | "cloud_unavailable"
  | "workspace_forbidden"
  | "workspace_archived"
  | "workspace_owner_unavailable"
  | "organization_agent_not_enabled"
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
  definitionId: string;
  selectedVersionId: string;
  runtimeProfileId: string | null;
  policySnapshotId: string | null;
  status: "pending" | "active" | "archived";
  retryCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgenteraInstallVersionInput {
  definitionId: string;
  versionId: string;
  profileName: string;
}

export interface AgenteraClaimVersionInput {
  definitionId: string;
  versionId: string;
  localProfileId: string;
  confirmation: "claim-existing-profile";
}

export type AgenteraPendingInstallationTarget =
  | { kind: "fresh"; profileName: string }
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
