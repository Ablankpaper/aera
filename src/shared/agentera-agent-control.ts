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
  | "operation_failed";

export type AgenteraAgentControlResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: AgenteraAgentControlErrorCode };

export interface AgenteraAgentControlPublicState {
  access: "online" | "offline";
  cloudAvailable: boolean;
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
