import { randomUUID as nodeRandomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type {
  AgentDraft,
  AgentDraftPublicationIdentity,
  PublicationPreview,
  PublishedRevision,
} from "../../shared/agentera-agent-control";
import type { AgentAssetContext } from "./db";
import type {
  AgentPublication,
  AgentVersion,
  PublishInitialAgentRequest,
  PublishNextAgentVersionRequest,
} from "./client";
import { AgenteraAgentControlClientError } from "./client";
import { AgentDraftStoreError } from "./draft-store";
import {
  AgentManifestValidationError,
  canonicalizeEditableAgent,
} from "./manifest";
import {
  AgenteraAgentTrustError,
  canonicalizeAgentVersionContent,
} from "./trust";

export interface AgentPublicationDraftStore {
  getDraft(id: string): AgentDraft;
  readAsset(id: string, path: string): Buffer;
  beginPublicationAttempt(
    id: string,
    revision: number,
  ): AgentDraftPublicationIdentity;
  recordPublicationFailure(
    id: string,
    revision: number,
    errorCode: string,
    errorSummary: string,
  ): void;
  markPublished(
    id: string,
    revision: number,
    definitionId: string,
    versionId: string,
  ): AgentDraft;
}

export interface AgentPublicationClient {
  readonly origin: string;
  publishInitial(
    body: PublishInitialAgentRequest,
    idempotencyKey: string,
  ): Promise<AgentPublication>;
  publishNext(
    definitionId: string,
    body: PublishNextAgentVersionRequest,
    idempotencyKey: string,
  ): Promise<AgentPublication>;
  publishWorkspaceInitial(
    workspaceId: string,
    body: PublishInitialAgentRequest,
    idempotencyKey: string,
  ): Promise<AgentPublication>;
  publishWorkspaceNext(
    workspaceId: string,
    definitionId: string,
    body: PublishNextAgentVersionRequest,
    idempotencyKey: string,
  ): Promise<AgentPublication>;
}

export interface AgentPublicationTrust {
  verifyVersion(
    version: AgentVersion,
    context: { issuer: string; runtimeVersion: string },
  ): { contentDigest: string };
}

export interface VerifiedAgentVersionCache {
  cacheVerifiedVersion(version: AgentVersion): AgentVersion;
}

export interface AgentPublisherOptions {
  drafts: AgentPublicationDraftStore;
  client: AgentPublicationClient;
  trust: AgentPublicationTrust;
  cache: VerifiedAgentVersionCache;
  context?: AgentAssetContext;
  runtimeVersion: string;
  refreshTrust?: () => Promise<void>;
  randomUUID?: () => string;
}

export type AgentPublisherErrorCode = string;

export class AgentPublisherError extends Error {
  readonly code: AgentPublisherErrorCode;

  constructor(code: AgentPublisherErrorCode) {
    super(`Aera Agent publication failed: ${code}.`);
    this.name = "AgentPublisherError";
    this.code = code;
  }
}

interface PreparedPublication {
  draftId: string;
  revision: number;
  sourceAgentDefinitionId: string | null;
  baseAgentVersionId: string | null;
  displayName: string;
  icon: AgentDraft["icon"];
  manifestBytes: Buffer;
  bundleBytes: Buffer;
  contentDigest: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AgentPublisherError("invalid_publication_state");
  }
  return value.toLowerCase();
}

type NormalizedPublicationContext =
  | { scope: "USER"; workspaceId: null; canPublish: true }
  | { scope: "WORKSPACE"; workspaceId: string; canPublish: boolean };

function normalizeContext(
  context: AgentAssetContext | undefined,
): NormalizedPublicationContext {
  if (context === undefined || context.scope === "USER") {
    return { scope: "USER", workspaceId: null, canPublish: true };
  }
  if (
    context.scope !== "WORKSPACE" ||
    (context.role !== "owner" &&
      context.role !== "admin" &&
      context.role !== "member")
  ) {
    throw new AgentPublisherError("invalid_publication_state");
  }
  return {
    scope: "WORKSPACE",
    workspaceId: requireUuid(context.workspaceId),
    canPublish: context.role === "owner" || context.role === "admin",
  };
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new AgentPublisherError("invalid_agent_content");
  }
}

function stableFailureSummary(code: string): string {
  switch (code) {
    case "network_unavailable":
    case "request_timeout":
      return "Network unavailable.";
    case "session_revoked":
    case "authorization_expired":
      return "Authentication required.";
    case "version_conflict":
      return "Draft base version is stale.";
    case "invalid_agent_content":
      return "Agent content was rejected.";
    case "runtime_incompatible":
      return "Runtime version is incompatible.";
    case "signature_invalid":
    case "signature_verification_failed":
      return "Published Agent signature verification failed.";
    case "digest_mismatch":
    case "published_content_mismatch":
      return "Published Agent content did not match the draft.";
    case "cache_conflict":
    case "cache_corrupt":
    case "cache_permissions_invalid":
    case "publication_cache_failed":
      return "Verified Agent version cache failed.";
    default:
      return "Publication failed.";
  }
}

function publicFailureCode(error: unknown): string {
  if (error instanceof AgenteraAgentControlClientError) return error.code;
  if (error instanceof AgentManifestValidationError) return error.code;
  if (error instanceof AgentDraftStoreError) return error.code;
  if (error instanceof AgenteraAgentTrustError) return "verification_failed";
  if (error instanceof AgentPublisherError) return error.code;
  return "publication_failed";
}

function localVerificationFailureCode(error: unknown): string {
  if (error instanceof AgenteraAgentTrustError) return error.code;
  return publicFailureCode(error);
}

function boundedFailureCode(error: unknown, fallback: string): string {
  const code =
    error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : fallback;
}

function publicationVerificationFailureCode(error: unknown): string {
  if (error instanceof AgentPublisherError) return error.code;
  if (error instanceof AgenteraAgentTrustError) {
    if (error.code === "digest_mismatch") {
      return "published_content_mismatch";
    }
    if (error.code === "runtime_incompatible") {
      return "runtime_incompatible";
    }
    return "signature_verification_failed";
  }
  if (error instanceof AgenteraAgentControlClientError) return error.code;
  return "verification_failed";
}

export class AgentPublisher {
  private readonly drafts: AgentPublicationDraftStore;
  private readonly client: AgentPublicationClient;
  private readonly trust: AgentPublicationTrust;
  private readonly cache: VerifiedAgentVersionCache;
  private readonly runtimeVersion: string;
  private readonly refreshTrust: (() => Promise<void>) | null;
  private readonly randomUUID: () => string;
  private readonly context: NormalizedPublicationContext;
  private readonly handles = new Map<string, PreparedPublication>();

  constructor(options: AgentPublisherOptions) {
    if (
      typeof options.runtimeVersion !== "string" ||
      options.runtimeVersion.length === 0 ||
      options.runtimeVersion.length > 128
    ) {
      throw new Error("Aera Agent publisher Runtime version is invalid.");
    }
    this.drafts = options.drafts;
    this.client = options.client;
    this.trust = options.trust;
    this.cache = options.cache;
    this.context = normalizeContext(options.context);
    this.runtimeVersion = options.runtimeVersion;
    this.refreshTrust = options.refreshTrust ?? null;
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  preparePublication(draftId: string): PublicationPreview {
    if (!this.context.canPublish) {
      throw new AgentPublisherError("workspace_forbidden");
    }
    const draft = this.drafts.getDraft(requireUuid(draftId));
    if (
      (draft.sourceAgentDefinitionId === null) !==
      (draft.baseAgentVersionId === null)
    ) {
      throw new AgentPublisherError("invalid_publication_state");
    }
    const assetInputs = draft.manifest.assets.map(({ path }) => {
      const bytes = this.drafts.readAsset(draft.id, path);
      return { path, content: decodeUtf8(bytes) };
    });
    let canonical;
    try {
      canonical = canonicalizeEditableAgent(draft.manifest, assetInputs);
    } catch (error) {
      throw new AgentPublisherError(publicFailureCode(error));
    }
    const handle = requireUuid(this.randomUUID());
    if (this.handles.has(handle)) {
      throw new AgentPublisherError("publication_confirmation_invalid");
    }
    const assetCounts = { skill: 0, sop: 0, knowledge: 0 };
    for (const asset of canonical.assets) assetCounts[asset.kind] += 1;
    const preview: PublicationPreview = {
      publicationHandle: handle,
      draftId: draft.id,
      revision: draft.revision,
      targetScope: this.context.scope,
      assetCounts,
      totalBytes: canonical.assets.reduce(
        (total, asset) => total + asset.sizeBytes,
        0,
      ),
    };
    this.handles.set(handle, {
      draftId: draft.id,
      revision: draft.revision,
      sourceAgentDefinitionId: draft.sourceAgentDefinitionId,
      baseAgentVersionId: draft.baseAgentVersionId,
      displayName: draft.displayName,
      icon: draft.icon,
      manifestBytes: canonical.manifestBytes,
      bundleBytes: canonical.bundleBytes,
      contentDigest: canonical.contentDigest,
    });
    return {
      ...preview,
      assetCounts: { ...preview.assetCounts },
    };
  }

  async confirmPublication(handleInput: string): Promise<PublishedRevision> {
    const handle = requireUuid(handleInput);
    const prepared = this.handles.get(handle);
    this.handles.delete(handle);
    if (!prepared) {
      throw new AgentPublisherError("publication_confirmation_invalid");
    }

    const current = this.drafts.getDraft(prepared.draftId);
    if (
      current.revision !== prepared.revision ||
      current.displayName !== prepared.displayName ||
      current.sourceAgentDefinitionId !== prepared.sourceAgentDefinitionId ||
      current.baseAgentVersionId !== prepared.baseAgentVersionId
    ) {
      throw new AgentPublisherError("draft_conflict");
    }
    const currentAssets = current.manifest.assets.map(({ path }) => ({
      path,
      content: decodeUtf8(this.drafts.readAsset(current.id, path)),
    }));
    let currentCanonical;
    try {
      currentCanonical = canonicalizeEditableAgent(
        current.manifest,
        currentAssets,
      );
    } catch (error) {
      throw new AgentPublisherError(publicFailureCode(error));
    }
    if (
      currentCanonical.contentDigest !== prepared.contentDigest ||
      !currentCanonical.manifestBytes.equals(prepared.manifestBytes) ||
      !currentCanonical.bundleBytes.equals(prepared.bundleBytes)
    ) {
      throw new AgentPublisherError("draft_conflict");
    }

    const attempt = this.drafts.beginPublicationAttempt(
      current.id,
      current.revision,
    );
    let publication: AgentPublication;
    try {
      publication = await this.sendPublication(prepared, attempt);
    } catch (error) {
      this.recordFailure(prepared, publicFailureCode(error));
      throw new AgentPublisherError(publicFailureCode(error));
    }

    try {
      await this.verifyPublicationWithTrustRefresh(prepared, publication);
    } catch (error) {
      this.recordFailure(prepared, localVerificationFailureCode(error));
      throw new AgentPublisherError(publicationVerificationFailureCode(error));
    }

    try {
      this.cache.cacheVerifiedVersion(publication.version);
    } catch (error) {
      this.recordFailure(
        prepared,
        boundedFailureCode(error, "publication_cache_failed"),
      );
      throw new AgentPublisherError("publication_cache_failed");
    }

    try {
      this.drafts.markPublished(
        current.id,
        current.revision,
        publication.definition.id,
        publication.version.id,
      );
    } catch (error) {
      this.recordFailure(prepared, publicFailureCode(error));
      if (error instanceof AgentDraftStoreError) {
        throw new AgentPublisherError(error.code);
      }
      throw new AgentPublisherError("publication_failed");
    }

    return {
      draftId: current.id,
      revision: current.revision,
      definitionId: publication.definition.id,
      versionId: publication.version.id,
      versionNumber: publication.version.version_number,
      contentDigest: publication.version.content_digest,
      publishedAt: publication.version.published_at,
      replayed: publication.replayed,
    };
  }

  private async sendPublication(
    prepared: PreparedPublication,
    attempt: AgentDraftPublicationIdentity,
  ): Promise<AgentPublication> {
    const manifest = JSON.parse(
      prepared.manifestBytes.toString("utf8"),
    ) as PublishInitialAgentRequest["manifest"];
    const bundle = JSON.parse(
      prepared.bundleBytes.toString("utf8"),
    ) as PublishInitialAgentRequest["bundle"];
    if (
      prepared.sourceAgentDefinitionId === null &&
      prepared.baseAgentVersionId === null
    ) {
      const icon = prepared.icon;
      const body: PublishInitialAgentRequest = {
        display_name: prepared.displayName,
        manifest,
        bundle,
        ...(icon === null
          ? {}
          : {
              icon_media_type: icon.mediaType,
              icon_data: Buffer.from(icon.dataBase64, "base64").toString(
                "base64url",
              ),
            }),
      };
      return this.context.scope === "USER"
        ? this.client.publishInitial(body, attempt.idempotencyKey)
        : this.client.publishWorkspaceInitial(
            this.context.workspaceId,
            body,
            attempt.idempotencyKey,
          );
    }
    if (
      prepared.sourceAgentDefinitionId !== null &&
      prepared.baseAgentVersionId !== null
    ) {
      const body: PublishNextAgentVersionRequest = {
        base_version_id: prepared.baseAgentVersionId,
        display_name: prepared.displayName,
        manifest,
        bundle,
      };
      return this.context.scope === "USER"
        ? this.client.publishNext(
            prepared.sourceAgentDefinitionId,
            body,
            attempt.idempotencyKey,
          )
        : this.client.publishWorkspaceNext(
            this.context.workspaceId,
            prepared.sourceAgentDefinitionId,
            body,
            attempt.idempotencyKey,
          );
    }
    throw new AgentPublisherError("invalid_publication_state");
  }

  private verifyPublication(
    prepared: PreparedPublication,
    publication: AgentPublication,
  ): void {
    const expectedDefinitionId = prepared.sourceAgentDefinitionId;
    if (
      publication.definition.id !== publication.version.definition_id ||
      publication.definition.latest_version_id !== publication.version.id ||
      (expectedDefinitionId !== null &&
        publication.definition.id !== expectedDefinitionId) ||
      publication.definition.display_name !== prepared.displayName
    ) {
      throw new AgentPublisherError("published_content_mismatch");
    }
    const canonical = canonicalizeAgentVersionContent(publication.version);
    if (
      canonical.contentDigest !== prepared.contentDigest ||
      publication.version.content_digest !== prepared.contentDigest ||
      !canonical.manifestBytes.equals(prepared.manifestBytes) ||
      !canonical.bundleBytes.equals(prepared.bundleBytes)
    ) {
      throw new AgentPublisherError("published_content_mismatch");
    }
    const verified = this.trust.verifyVersion(publication.version, {
      issuer: this.client.origin,
      runtimeVersion: this.runtimeVersion,
    });
    if (verified.contentDigest !== prepared.contentDigest) {
      throw new AgentPublisherError("published_content_mismatch");
    }
  }

  private async verifyPublicationWithTrustRefresh(
    prepared: PreparedPublication,
    publication: AgentPublication,
  ): Promise<void> {
    try {
      this.verifyPublication(prepared, publication);
    } catch (error) {
      if (
        !(error instanceof AgenteraAgentTrustError) ||
        this.refreshTrust === null
      ) {
        throw error;
      }
      await this.refreshTrust();
      this.verifyPublication(prepared, publication);
    }
  }

  private recordFailure(prepared: PreparedPublication, code: string): void {
    try {
      this.drafts.recordPublicationFailure(
        prepared.draftId,
        prepared.revision,
        /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "publication_failed",
        stableFailureSummary(code),
      );
    } catch {
      // Never replace the primary publication failure with bookkeeping noise.
    }
  }
}
