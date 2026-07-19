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
