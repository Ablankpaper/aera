import { randomUUID as nodeRandomUUID } from "node:crypto";
import type {
  AgentDraft,
  AgentDraftDetail,
  AgentDraftIcon,
  AgentEditableManifest,
  ConfirmOrganizationExperienceCandidateImportInput,
  CreateAgentDraftInput,
  ExperienceCandidateBundleV1,
  OrganizationExperienceCandidateImportPreview,
  OrganizationExperienceCandidateImportReceipt,
} from "../../shared/agentera-agent-control";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import {
  AgenteraAgentControlClientError,
  type AgentDefinition,
  type AgentVersion,
  type CloudOrganizationExperienceCandidateDetail,
} from "./client";
import type { AgenteraControlPlaneDatabase } from "./db";
import {
  EXPERIENCE_CANDIDATE_DLP_VERSION,
  canonicalizeExperienceCandidate,
  scanExperienceCandidate,
} from "./experience-candidate-contract";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PREPARED_IMPORTS = 64;

export type OrganizationExperienceCandidateImporterErrorCode =
  | "invalid_request"
  | "organization_agent_forbidden"
  | "organization_archived"
  | "candidate_not_found"
  | "candidate_not_approved"
  | "candidate_base_advanced"
  | "candidate_import_failed"
  | "verification_failed"
  | "cloud_unavailable";

export class OrganizationExperienceCandidateImporterError extends Error {
  readonly code: OrganizationExperienceCandidateImporterErrorCode;

  constructor(code: OrganizationExperienceCandidateImporterErrorCode) {
    super(`ExperienceCandidate import failed: ${code}.`);
    this.name = "OrganizationExperienceCandidateImporterError";
    this.code = code;
  }
}

export interface OrganizationExperienceCandidateImportClient {
  getOrganizationExperienceCandidate(
    organizationId: string,
    candidateId: string,
  ): Promise<CloudOrganizationExperienceCandidateDetail>;
  getOrganizationDefinition(
    organizationId: string,
    definitionId: string,
  ): Promise<AgentDefinition>;
  listOrganizationVersions(
    organizationId: string,
    definitionId: string,
  ): Promise<AgentVersion[]>;
}

export interface OrganizationExperienceCandidateImportDraftStore {
  createDraftRowsInCurrentTransaction(input: CreateAgentDraftInput): AgentDraft;
  getDraftDetail(id: string): AgentDraftDetail;
  discardDraftMaterialization(id: string): void;
}

export interface OrganizationExperienceCandidateImportReceiptStore {
  findImport(
    organizationId: string,
    candidateId: string,
  ): OrganizationExperienceCandidateImportReceipt | null;
  recordImportInCurrentTransaction(input: {
    candidateId: string;
    organizationId: string;
    agentDefinitionId: string;
    baseAgentVersionId: string;
    candidateContentDigest: string;
    draftId: string;
  }): OrganizationExperienceCandidateImportReceipt;
}

export interface OrganizationExperienceCandidateImportVersionCache {
  cacheVerifiedVersion(version: AgentVersion): AgentVersion;
  getVerifiedVersion(versionId: string): AgentVersion;
}

export interface OrganizationExperienceCandidateImporterOptions {
  database: AgenteraControlPlaneDatabase;
  client: OrganizationExperienceCandidateImportClient;
  candidates: OrganizationExperienceCandidateImportReceiptStore;
  drafts: OrganizationExperienceCandidateImportDraftStore;
  cache: OrganizationExperienceCandidateImportVersionCache;
  owner: AgenteraRuntimeOwner;
  now?: () => Date;
  randomUUID?: () => string;
  afterDraftRowsWritten?: () => void;
  afterImportReceiptWritten?: () => void;
}

interface PreparedImport {
  ownerKey: string;
  organizationId: string;
  candidateId: string;
  candidateContentDigest: string;
  agentDefinitionId: string;
  sourceVersionId: string;
  latestVersionId: string;
  latestVersionDigest: string;
  latestVersionNumber: number;
  skillName: string;
  draftInput: CreateAgentDraftInput;
  addedPaths: string[];
  replacedPaths: string[];
  removedPaths: string[];
}

function importerError(
  code: OrganizationExperienceCandidateImporterErrorCode,
): never {
  throw new OrganizationExperienceCandidateImporterError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return importerError("invalid_request");
  }
  return value.toLowerCase();
}

function normalizedOwner(owner: AgenteraRuntimeOwner): AgenteraRuntimeOwner {
  return {
    tenantId: uuid(owner.tenantId),
    ownerId: uuid(owner.ownerId),
    deviceInstallationId: uuid(owner.deviceInstallationId),
  };
}

function ownerKey(owner: AgenteraRuntimeOwner): string {
  return `${owner.tenantId}\0${owner.ownerId}\0${owner.deviceInstallationId}`;
}

function rollback(database: AgenteraControlPlaneDatabase): void {
  try {
    database.sqlite.exec("ROLLBACK");
  } catch {
    // Preserve the primary import failure.
  }
}

function mapClientError(error: AgenteraAgentControlClientError): never {
  switch (error.code) {
    case "organization_agent_forbidden":
      return importerError("organization_agent_forbidden");
    case "organization_archived":
      return importerError("organization_archived");
    case "not_found":
    case "candidate_not_found":
      return importerError("candidate_not_found");
    default:
      return importerError("cloud_unavailable");
  }
}

function canonicalCandidate(
  candidate: CloudOrganizationExperienceCandidateDetail,
): ExperienceCandidateBundleV1 {
  let canonical;
  try {
    canonical = canonicalizeExperienceCandidate({
      schemaVersion: 1,
      skillName: candidate.bundle.skill_name,
      assets: candidate.bundle.assets.map((asset) => ({
        path: asset.path,
        mediaType: asset.media_type,
        content: asset.content,
      })),
    });
  } catch {
    return importerError("verification_failed");
  }
  if (
    canonical.bundle.skillName !== candidate.skill_name ||
    canonical.contentDigest !== candidate.content_digest ||
    scanExperienceCandidate(canonical).length !== 0
  ) {
    return importerError("verification_failed");
  }
  return canonical.bundle;
}

function editableManifest(version: AgentVersion): AgentEditableManifest {
  const common = {
    identity: { systemPrompt: version.manifest.identity.system_prompt },
    assets: version.manifest.assets.map((asset) => ({
      path: asset.path,
      kind: asset.kind,
      mediaType: asset.media_type,
    })),
    tools: {
      allowed: [...version.manifest.tools.allowed],
      denied: [...version.manifest.tools.denied],
    },
    dependencies: version.manifest.dependencies.map((dependency) => ({
      agentDefinitionId: dependency.agent_definition_id,
      agentVersionId: dependency.agent_version_id,
    })),
    runtimeCompatibility: {
      minimumVersion: version.manifest.runtime_compatibility.minimum_version,
      maximumVersionExclusive:
        version.manifest.runtime_compatibility.maximum_version_exclusive ??
        null,
    },
  };
  if (version.manifest.schema_version === 1) {
    return {
      schemaVersion: 1,
      ...common,
      modelConstraints: {
        allowedProviders: [
          ...version.manifest.model_constraints.allowed_providers,
        ],
        allowedModels: [...version.manifest.model_constraints.allowed_models],
      },
    };
  }
  return {
    schemaVersion: 2,
    ...common,
    modelPolicy: {
      mode: version.manifest.model_policy.mode,
      allowedProviders: [...version.manifest.model_policy.allowed_providers],
      allowedModels: [...version.manifest.model_policy.allowed_models],
    },
  };
}

function definitionIcon(definition: AgentDefinition): AgentDraftIcon | null {
  if (
    definition.icon_media_type === undefined ||
    definition.icon_data === undefined
  ) {
    return null;
  }
  return {
    mediaType: definition.icon_media_type,
    dataBase64: Buffer.from(definition.icon_data, "base64url").toString(
      "base64",
    ),
  };
}

function utf8Sort(values: Iterable<string>): string[] {
  return [...values].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}

function buildDraft(
  candidate: CloudOrganizationExperienceCandidateDetail,
  bundle: ExperienceCandidateBundleV1,
  definition: AgentDefinition,
  version: AgentVersion,
): Pick<
  PreparedImport,
  "draftInput" | "addedPaths" | "replacedPaths" | "removedPaths"
> {
  const manifest = editableManifest(version);
  const prefix = `skills/${bundle.skillName}/`;
  const basePaths = new Set(version.manifest.assets.map((asset) => asset.path));
  const baseSkillPaths = new Set(
    version.manifest.assets
      .filter((asset) => asset.path.startsWith(prefix))
      .map((asset) => asset.path),
  );
  const candidatePaths = new Set(bundle.assets.map((asset) => asset.path));
  const addedPaths = utf8Sort(
    [...candidatePaths].filter((path) => !basePaths.has(path)),
  );
  const replacedPaths = utf8Sort(
    [...candidatePaths].filter((path) => basePaths.has(path)),
  );
  const removedPaths = utf8Sort(
    [...baseSkillPaths].filter((path) => !candidatePaths.has(path)),
  );
  const unrelatedAssets = manifest.assets.filter(
    (asset) => !asset.path.startsWith(prefix),
  );
  const unrelatedContent = version.bundle.assets
    .filter((asset) => !asset.path.startsWith(prefix))
    .map((asset) => ({ path: asset.path, content: asset.content }));
  const candidateManifestAssets = bundle.assets.map((asset) => ({
    path: asset.path,
    kind: "skill" as const,
    mediaType: asset.mediaType,
  }));
  return {
    addedPaths,
    replacedPaths,
    removedPaths,
    draftInput: {
      sourceAgentDefinitionId: candidate.agent_definition_id,
      baseAgentVersionId: version.id,
      displayName: definition.display_name,
      icon: definitionIcon(definition),
      manifest: {
        ...manifest,
        assets: [...unrelatedAssets, ...candidateManifestAssets],
      },
      assets: [
        ...unrelatedContent,
        ...bundle.assets.map((asset) => ({
          path: asset.path,
          content: asset.content,
        })),
      ],
    },
  };
}

function exactReceipt(
  receipt: OrganizationExperienceCandidateImportReceipt,
  prepared: PreparedImport,
): boolean {
  return (
    receipt.candidateId === prepared.candidateId &&
    receipt.organizationId === prepared.organizationId &&
    receipt.agentDefinitionId === prepared.agentDefinitionId &&
    receipt.baseAgentVersionId === prepared.latestVersionId &&
    receipt.candidateContentDigest === prepared.candidateContentDigest
  );
}

export class OrganizationExperienceCandidateImporter {
  private readonly options: OrganizationExperienceCandidateImporterOptions;
  private readonly owner: AgenteraRuntimeOwner;
  private readonly randomUUID: () => string;
  private readonly prepared = new Map<string, PreparedImport>();

  constructor(options: OrganizationExperienceCandidateImporterOptions) {
    this.options = options;
    this.owner = normalizedOwner(options.owner);
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  async prepare(
    organizationIdInput: string,
    candidateIdInput: string,
  ): Promise<OrganizationExperienceCandidateImportPreview> {
    const organizationId = uuid(organizationIdInput);
    const candidateId = uuid(candidateIdInput);
    let candidate: CloudOrganizationExperienceCandidateDetail;
    try {
      candidate = await this.options.client.getOrganizationExperienceCandidate(
        organizationId,
        candidateId,
      );
    } catch (error) {
      if (error instanceof AgenteraAgentControlClientError) {
        return mapClientError(error);
      }
      return importerError("cloud_unavailable");
    }
    if (candidate.id !== candidateId)
      return importerError("verification_failed");
    if (candidate.organization_id !== organizationId) {
      return importerError("organization_agent_forbidden");
    }
    if (
      candidate.dlp_contract_version !== EXPERIENCE_CANDIDATE_DLP_VERSION ||
      candidate.review?.decision !== "APPROVED"
    ) {
      return importerError("candidate_not_approved");
    }
    const bundle = canonicalCandidate(candidate);

    let definition: AgentDefinition;
    try {
      definition = await this.options.client.getOrganizationDefinition(
        organizationId,
        candidate.agent_definition_id,
      );
    } catch (error) {
      if (error instanceof AgenteraAgentControlClientError) {
        return mapClientError(error);
      }
      return importerError("cloud_unavailable");
    }
    if (
      definition.id !== candidate.agent_definition_id ||
      definition.status !== "active" ||
      definition.latest_version_id === undefined
    ) {
      return importerError("verification_failed");
    }

    let downloaded: AgentVersion;
    try {
      const versions = await this.options.client.listOrganizationVersions(
        organizationId,
        definition.id,
      );
      const exact = versions.find(
        (version) => version.id === definition.latest_version_id,
      );
      if (!exact) return importerError("verification_failed");
      downloaded = exact;
    } catch (error) {
      if (error instanceof AgenteraAgentControlClientError) {
        return mapClientError(error);
      }
      return importerError("cloud_unavailable");
    }
    let latest: AgentVersion;
    try {
      latest = this.options.cache.cacheVerifiedVersion(downloaded);
    } catch {
      return importerError("verification_failed");
    }
    if (
      latest.id !== definition.latest_version_id ||
      latest.definition_id !== definition.id ||
      latest.content_digest !== downloaded.content_digest ||
      !Number.isSafeInteger(latest.version_number) ||
      latest.version_number < 1
    ) {
      return importerError("verification_failed");
    }

    const draft = buildDraft(candidate, bundle, definition, latest);
    const importHandle = uuid(this.randomUUID());
    const prepared: PreparedImport = {
      ownerKey: ownerKey(this.owner),
      organizationId,
      candidateId,
      candidateContentDigest: candidate.content_digest,
      agentDefinitionId: candidate.agent_definition_id,
      sourceVersionId: candidate.source_agent_version_id,
      latestVersionId: latest.id,
      latestVersionDigest: latest.content_digest,
      latestVersionNumber: latest.version_number,
      skillName: candidate.skill_name,
      draftInput: draft.draftInput,
      addedPaths: draft.addedPaths,
      replacedPaths: draft.replacedPaths,
      removedPaths: draft.removedPaths,
    };
    if (this.prepared.size >= MAX_PREPARED_IMPORTS) {
      const oldest = this.prepared.keys().next().value as string | undefined;
      if (oldest !== undefined) this.prepared.delete(oldest);
    }
    this.prepared.set(importHandle, prepared);
    return {
      importHandle,
      candidateId,
      sourceVersionId: prepared.sourceVersionId,
      latestVersionId: prepared.latestVersionId,
      latestVersionNumber: prepared.latestVersionNumber,
      skillName: prepared.skillName,
      replacesExistingSkill:
        prepared.replacedPaths.length > 0 || prepared.removedPaths.length > 0,
      addedPaths: [...prepared.addedPaths],
      replacedPaths: [...prepared.replacedPaths],
      removedPaths: [...prepared.removedPaths],
    };
  }

  async confirm(
    organizationIdInput: string,
    input: ConfirmOrganizationExperienceCandidateImportInput,
  ): Promise<AgentDraftDetail> {
    if (
      input === null ||
      typeof input !== "object" ||
      input.confirmation !== "apply-approved-skill-to-organization-draft"
    ) {
      return importerError("invalid_request");
    }
    const organizationId = uuid(organizationIdInput);
    const importHandle = uuid(input.importHandle);
    const prepared = this.prepared.get(importHandle);
    this.prepared.delete(importHandle);
    if (
      prepared === undefined ||
      prepared.ownerKey !== ownerKey(this.owner) ||
      prepared.organizationId !== organizationId
    ) {
      return importerError("invalid_request");
    }

    const existing = this.options.candidates.findImport(
      organizationId,
      prepared.candidateId,
    );
    if (existing !== null) {
      if (!exactReceipt(existing, prepared)) {
        return importerError("verification_failed");
      }
      return this.options.drafts.getDraftDetail(existing.draftId);
    }

    let current: AgentDefinition;
    try {
      current = await this.options.client.getOrganizationDefinition(
        organizationId,
        prepared.agentDefinitionId,
      );
    } catch (error) {
      if (error instanceof AgenteraAgentControlClientError) {
        return mapClientError(error);
      }
      return importerError("cloud_unavailable");
    }
    if (
      current.id !== prepared.agentDefinitionId ||
      current.status !== "active" ||
      current.latest_version_id !== prepared.latestVersionId
    ) {
      return importerError("candidate_base_advanced");
    }
    let verifiedBase: AgentVersion;
    try {
      verifiedBase = this.options.cache.getVerifiedVersion(
        prepared.latestVersionId,
      );
    } catch {
      return importerError("verification_failed");
    }
    if (
      verifiedBase.id !== prepared.latestVersionId ||
      verifiedBase.definition_id !== prepared.agentDefinitionId ||
      verifiedBase.content_digest !== prepared.latestVersionDigest ||
      verifiedBase.version_number !== prepared.latestVersionNumber
    ) {
      return importerError("verification_failed");
    }

    let created: AgentDraft | null = null;
    try {
      this.options.database.sqlite.exec("BEGIN IMMEDIATE");
      const raced = this.options.candidates.findImport(
        organizationId,
        prepared.candidateId,
      );
      if (raced !== null) {
        if (!exactReceipt(raced, prepared)) {
          return importerError("verification_failed");
        }
        this.options.database.sqlite.exec("COMMIT");
        return this.options.drafts.getDraftDetail(raced.draftId);
      }
      created = this.options.drafts.createDraftRowsInCurrentTransaction(
        prepared.draftInput,
      );
      this.options.afterDraftRowsWritten?.();
      this.options.candidates.recordImportInCurrentTransaction({
        candidateId: prepared.candidateId,
        organizationId: prepared.organizationId,
        agentDefinitionId: prepared.agentDefinitionId,
        baseAgentVersionId: prepared.latestVersionId,
        candidateContentDigest: prepared.candidateContentDigest,
        draftId: created.id,
      });
      this.options.afterImportReceiptWritten?.();
      this.options.database.sqlite.exec("COMMIT");
    } catch (error) {
      rollback(this.options.database);
      if (created !== null) {
        this.options.drafts.discardDraftMaterialization(created.id);
      }
      if (error instanceof OrganizationExperienceCandidateImporterError)
        throw error;
      return importerError("candidate_import_failed");
    }
    if (created === null) return importerError("candidate_import_failed");
    return this.options.drafts.getDraftDetail(created.id);
  }

  clearPreparedImports(): void {
    this.prepared.clear();
  }
}
