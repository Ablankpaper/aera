import { randomUUID as nodeRandomUUID } from "node:crypto";
import type {
  AgentInstallation,
  AgentInstallationCreation,
  AgentPolicySnapshot,
  AgentVersion,
  CreateAgentInstallationRequest,
} from "./client";
import type { AgentAssetContext, AgenteraControlPlaneDatabase } from "./db";
import type {
  ActivatedHermesProjection,
  HermesVersionProjection,
} from "./hermes-projection";
import type {
  AgenteraProfileBindingStore,
  AgenteraRuntimeOwner,
  ProfileCreationResult,
  RuntimeOwnerBinding,
} from "../agentera-profile-binding";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type AgentInstallationManagerErrorCode =
  | "invalid_installation_request"
  | "installation_conflict"
  | "creation_failed"
  | "materialization_failed"
  | "profile_binding_failed"
  | "activation_failed"
  | "update_failed"
  | "archive_failed"
  | "installation_not_found";

type AgentInstallationRetryCode =
  | AgentInstallationManagerErrorCode
  | "materialization_version_failed"
  | "materialization_policy_failed"
  | "materialization_projection_failed"
  | "profile_creation_failed"
  | "profile_attachment_failed"
  | "profile_projection_failed";

export class AgentInstallationManagerError extends Error {
  readonly code: AgentInstallationManagerErrorCode;

  constructor(code: AgentInstallationManagerErrorCode) {
    super(`AgentEra Agent installation failed: ${code}.`);
    this.name = "AgentInstallationManagerError";
    this.code = code;
  }
}

export interface AgentInstallationClient {
  readonly origin: string;
  createInstallation(
    body: CreateAgentInstallationRequest,
    idempotencyKey: string,
  ): Promise<AgentInstallationCreation>;
  getVersion(versionId: string): Promise<AgentVersion>;
  getPolicySnapshot(snapshotId: string): Promise<AgentPolicySnapshot>;
  activateInstallation(
    installationId: string,
    runtimeProfileId: string,
    versionDigest: string,
    idempotencyKey: string,
  ): Promise<AgentInstallation>;
  selectInstallationVersion(
    installationId: string,
    versionId: string,
    idempotencyKey: string,
  ): Promise<AgentInstallation>;
  archiveInstallation(
    installationId: string,
    idempotencyKey: string,
  ): Promise<AgentInstallation>;
}

export interface AgentInstallationTrust {
  verifyPolicy(
    policy: AgentPolicySnapshot,
    context: { runtimeVersion: string },
  ): { contentDigest: string };
}

export interface AgentInstallationVersionCache {
  cacheVerifiedVersion(version: AgentVersion): AgentVersion;
  getVerifiedVersion(versionId: string): AgentVersion;
  cacheVerifiedPolicySnapshot(
    versionId: string,
    policy: AgentPolicySnapshot,
  ): AgentPolicySnapshot;
  getVerifiedPolicySnapshot(
    versionId: string,
    policyId: string,
  ): AgentPolicySnapshot;
}

export interface AgentInstallationProjection {
  materializeVersion(input: {
    agentInstallationId: string;
    version: AgentVersion;
  }): HermesVersionProjection;
  activateForProfile(input: {
    projection: HermesVersionProjection;
    profilePath: string;
  }): ActivatedHermesProjection;
}

export interface AgentInstallationProfileAdapter {
  createProfile(name: string, cloneFrom: string | null): ProfileCreationResult;
  resolveProfilePath(profileId: string): string;
  activateProfile(profileId: string): void;
}

export type AgentInstallationProfileTarget =
  | { kind: "fresh"; name: string }
  | { kind: "claim"; profileId: string; profilePath: string };

export type AgentInstallationSource =
  | { scope: "USER" }
  | { scope: "WORKSPACE"; workspaceId: string }
  | { scope: "ORGANIZATION"; organizationId: string }
  | {
      scope: "PLATFORM";
      officialReleaseId: string;
      selectedReleaseRevisionId: string;
      updatePolicy: "managed";
    };

export interface LocalAgentInstallation {
  agentInstallationId: string;
  sourceScope: "USER" | "WORKSPACE" | "ORGANIZATION" | "PLATFORM";
  sourceWorkspaceId: string | null;
  sourceOrganizationId: string | null;
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

export interface AgentInstallationManagerOptions {
  database: AgenteraControlPlaneDatabase;
  client: AgentInstallationClient;
  trust: AgentInstallationTrust;
  cache: AgentInstallationVersionCache;
  projection: AgentInstallationProjection;
  profileBindings: AgenteraProfileBindingStore;
  profiles: AgentInstallationProfileAdapter;
  owner: AgenteraRuntimeOwner;
  runtimeVersion: string;
  now?: () => Date;
  randomUUID?: () => string;
}

interface LocalInstallationRow {
  agent_installation_id: unknown;
  source_scope: unknown;
  source_workspace_id: unknown;
  source_organization_id: unknown;
  official_release_id: unknown;
  selected_release_revision_id: unknown;
  update_policy: unknown;
  definition_id: unknown;
  selected_version_id: unknown;
  runtime_profile_id: unknown;
  policy_snapshot_id: unknown;
  status: unknown;
  retry_code: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface InstallationCreationIntent {
  id: string;
  definitionId: string;
  versionId: string;
  idempotencyKey: string;
  sourceScope: "USER" | "WORKSPACE" | "ORGANIZATION" | "PLATFORM";
  sourceWorkspaceId: string | null;
  sourceOrganizationId: string | null;
  officialReleaseId: string | null;
  selectedReleaseRevisionId: string | null;
  updatePolicy: "manual" | "managed";
}

interface NormalizedInstallationSource {
  scope: "USER" | "WORKSPACE" | "ORGANIZATION" | "PLATFORM";
  workspaceId: string | null;
  organizationId: string | null;
  officialReleaseId: string | null;
  selectedReleaseRevisionId: string | null;
  updatePolicy: "manual" | "managed";
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AgentInstallationManagerError("invalid_installation_request");
  }
  return value.toLowerCase();
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AgentInstallationManagerError("invalid_installation_request");
  }
  return value.toISOString();
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function normalizeInstallationSource(
  context: AgentAssetContext | AgentInstallationSource | undefined,
): NormalizedInstallationSource {
  if (context === undefined || context.scope === "USER") {
    return {
      scope: "USER",
      workspaceId: null,
      organizationId: null,
      officialReleaseId: null,
      selectedReleaseRevisionId: null,
      updatePolicy: "manual",
    };
  }
  if (context.scope === "WORKSPACE") {
    const role = "role" in context ? context.role : "member";
    if (role !== "owner" && role !== "admin" && role !== "member") {
      throw new AgentInstallationManagerError("invalid_installation_request");
    }
    return {
      scope: "WORKSPACE",
      workspaceId: uuid(context.workspaceId),
      organizationId: null,
      officialReleaseId: null,
      selectedReleaseRevisionId: null,
      updatePolicy: "manual",
    };
  }
  if (context.scope === "PLATFORM") {
    if (context.updatePolicy !== "managed") {
      throw new AgentInstallationManagerError("invalid_installation_request");
    }
    return {
      scope: "PLATFORM",
      workspaceId: null,
      organizationId: null,
      officialReleaseId: uuid(context.officialReleaseId),
      selectedReleaseRevisionId: uuid(context.selectedReleaseRevisionId),
      updatePolicy: "managed",
    };
  }
  const role = "role" in context ? context.role : "member";
  if (role !== "owner" && role !== "admin" && role !== "member") {
    throw new AgentInstallationManagerError("invalid_installation_request");
  }
  return {
    scope: "ORGANIZATION",
    workspaceId: null,
    organizationId: uuid(context.organizationId),
    officialReleaseId: null,
    selectedReleaseRevisionId: null,
    updatePolicy: "manual",
  };
}

function parseStoredSource(
  row: LocalInstallationRow,
): NormalizedInstallationSource {
  if (
    row.source_scope === "USER" &&
    row.source_workspace_id === null &&
    row.source_organization_id === null &&
    row.official_release_id === null &&
    row.selected_release_revision_id === null &&
    row.update_policy === "manual"
  ) {
    return {
      scope: "USER",
      workspaceId: null,
      organizationId: null,
      officialReleaseId: null,
      selectedReleaseRevisionId: null,
      updatePolicy: "manual",
    };
  }
  if (
    row.source_scope === "WORKSPACE" &&
    row.source_workspace_id !== null &&
    row.source_organization_id === null &&
    row.official_release_id === null &&
    row.selected_release_revision_id === null &&
    row.update_policy === "manual"
  ) {
    try {
      return {
        scope: "WORKSPACE",
        workspaceId: uuid(row.source_workspace_id),
        organizationId: null,
        officialReleaseId: null,
        selectedReleaseRevisionId: null,
        updatePolicy: "manual",
      };
    } catch {
      // Stored rows must fail closed as conflicts, not as user input errors.
    }
  }
  if (
    row.source_scope === "ORGANIZATION" &&
    row.source_workspace_id === null &&
    row.source_organization_id !== null &&
    row.official_release_id === null &&
    row.selected_release_revision_id === null &&
    row.update_policy === "manual"
  ) {
    try {
      return {
        scope: "ORGANIZATION",
        workspaceId: null,
        organizationId: uuid(row.source_organization_id),
        officialReleaseId: null,
        selectedReleaseRevisionId: null,
        updatePolicy: "manual",
      };
    } catch {
      // Stored rows must fail closed as conflicts, not as user input errors.
    }
  }
  if (
    row.source_scope === "PLATFORM" &&
    row.source_workspace_id === null &&
    row.source_organization_id === null &&
    row.official_release_id !== null &&
    row.selected_release_revision_id !== null &&
    row.update_policy === "managed"
  ) {
    try {
      return {
        scope: "PLATFORM",
        workspaceId: null,
        organizationId: null,
        officialReleaseId: uuid(row.official_release_id),
        selectedReleaseRevisionId: uuid(row.selected_release_revision_id),
        updatePolicy: "managed",
      };
    } catch {
      // Stored rows must fail closed as conflicts, not as user input errors.
    }
  }
  throw new AgentInstallationManagerError("installation_conflict");
}

function parseLocalRow(row: LocalInstallationRow): LocalAgentInstallation {
  const source = parseStoredSource(row);
  const status = row.status;
  if (status !== "pending" && status !== "active" && status !== "archived") {
    throw new AgentInstallationManagerError("installation_conflict");
  }
  if (
    (row.retry_code !== null && typeof row.retry_code !== "string") ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string"
  ) {
    throw new AgentInstallationManagerError("installation_conflict");
  }
  const createdAt = new Date(row.created_at);
  const updatedAt = new Date(row.updated_at);
  if (
    !Number.isFinite(createdAt.getTime()) ||
    createdAt.toISOString() !== row.created_at ||
    !Number.isFinite(updatedAt.getTime()) ||
    updatedAt.toISOString() !== row.updated_at
  ) {
    throw new AgentInstallationManagerError("installation_conflict");
  }
  return {
    agentInstallationId: uuid(row.agent_installation_id),
    sourceScope: source.scope,
    sourceWorkspaceId: source.workspaceId,
    sourceOrganizationId: source.organizationId,
    officialReleaseId: source.officialReleaseId,
    selectedReleaseRevisionId: source.selectedReleaseRevisionId,
    updatePolicy: source.updatePolicy,
    definitionId: uuid(row.definition_id),
    selectedVersionId: uuid(row.selected_version_id),
    runtimeProfileId: nullableUuid(row.runtime_profile_id),
    policySnapshotId: nullableUuid(row.policy_snapshot_id),
    status,
    retryCode: row.retry_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function operationKey(kind: string, ...ids: string[]): string {
  return `agentera:${kind}:${ids.join(":")}`;
}

function reportStageFailure(stage: string, error: unknown): void {
  const candidate = error as { code?: unknown; name?: unknown } | null;
  const code =
    candidate &&
    typeof candidate.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(candidate.code)
      ? candidate.code
      : candidate && typeof candidate.name === "string"
        ? candidate.name
        : "unknown";
  console.error(`[AGENTERA_AGENT_INSTALLATION] ${stage} failed: ${code}`);
}

function assertPendingCreation(
  creation: AgentInstallationCreation,
  definitionId: string,
  versionId: string,
  expectedOrigin: string,
  source: NormalizedInstallationSource,
  owner: AgenteraRuntimeOwner,
): void {
  const installation = creation.installation;
  const policy = creation.policy_snapshot;
  if (
    uuid(installation.definition_id) !== definitionId ||
    uuid(installation.selected_version_id) !== versionId ||
    installation.status !== "pending" ||
    installation.runtime_profile_id !== undefined ||
    installation.policy_snapshot_id === undefined ||
    uuid(installation.policy_snapshot_id) !== uuid(policy.id) ||
    uuid(policy.installation_id) !== uuid(installation.id) ||
    uuid(policy.agent_version_id) !== versionId ||
    policy.issuer !== expectedOrigin ||
    !cloudSourceMatches(installation, source) ||
    !policySourceMatches(policy, source, owner, uuid(installation.id))
  ) {
    throw new AgentInstallationManagerError("installation_conflict");
  }
}

function cloudSourceMatches(
  installation: AgentInstallation,
  source: NormalizedInstallationSource,
): boolean {
  if (source.scope === "PLATFORM") {
    return (
      installation.update_policy === "managed" &&
      installation.official_release_id !== undefined &&
      uuid(installation.official_release_id) === source.officialReleaseId &&
      installation.selected_release_revision_id !== undefined &&
      uuid(installation.selected_release_revision_id) ===
        source.selectedReleaseRevisionId
    );
  }
  return (
    installation.update_policy === "manual" &&
    installation.official_release_id === undefined &&
    installation.selected_release_revision_id === undefined
  );
}

function policySourceMatches(
  policy: AgentPolicySnapshot,
  source: NormalizedInstallationSource,
  owner: AgenteraRuntimeOwner,
  installationId: string,
): boolean {
  const context = policy.document.official_context;
  if (source.scope !== "PLATFORM") return context === undefined;
  return (
    context !== undefined &&
    uuid(context.release_id) === source.officialReleaseId &&
    uuid(context.release_revision_id) === source.selectedReleaseRevisionId &&
    uuid(context.user_id) === owner.ownerId &&
    uuid(context.device_id) === owner.deviceInstallationId &&
    uuid(context.installation_id) === installationId
  );
}

function assertVersion(
  version: AgentVersion,
  definitionId: string,
  versionId: string,
): void {
  if (
    uuid(version.id) !== versionId ||
    uuid(version.definition_id) !== definitionId ||
    !DIGEST_PATTERN.test(version.content_digest)
  ) {
    throw new AgentInstallationManagerError("installation_conflict");
  }
}

function assertPolicy(
  policy: AgentPolicySnapshot,
  installationId: string,
  definitionId: string,
  version: AgentVersion,
  expectedOrigin: string,
  local: LocalAgentInstallation,
  owner: AgenteraRuntimeOwner,
): void {
  if (
    uuid(policy.installation_id) !== installationId ||
    uuid(policy.agent_version_id) !== uuid(version.id) ||
    policy.issuer !== expectedOrigin ||
    uuid(policy.document.agent_definition_id) !== definitionId ||
    uuid(policy.document.agent_version_id) !== uuid(version.id) ||
    policy.document.version_digest !== version.content_digest ||
    !DIGEST_PATTERN.test(policy.content_digest) ||
    !policySourceMatches(
      policy,
      {
        scope: local.sourceScope,
        workspaceId: local.sourceWorkspaceId,
        organizationId: local.sourceOrganizationId,
        officialReleaseId: local.officialReleaseId,
        selectedReleaseRevisionId: local.selectedReleaseRevisionId,
        updatePolicy: local.updatePolicy,
      },
      owner,
      installationId,
    )
  ) {
    throw new AgentInstallationManagerError("installation_conflict");
  }
}

function assertCloudState(
  installation: AgentInstallation,
  local: LocalAgentInstallation,
  expectedStatus: LocalAgentInstallation["status"],
  expectedVersionId: string,
  expectedRuntimeProfileId: string | null,
): void {
  if (
    uuid(installation.id) !== local.agentInstallationId ||
    uuid(installation.definition_id) !== local.definitionId ||
    uuid(installation.selected_version_id) !== expectedVersionId ||
    installation.status !== expectedStatus ||
    !cloudSourceMatches(installation, {
      scope: local.sourceScope,
      workspaceId: local.sourceWorkspaceId,
      organizationId: local.sourceOrganizationId,
      officialReleaseId: local.officialReleaseId,
      selectedReleaseRevisionId: local.selectedReleaseRevisionId,
      updatePolicy: local.updatePolicy,
    }) ||
    (expectedRuntimeProfileId === null
      ? installation.runtime_profile_id !== undefined
      : uuid(installation.runtime_profile_id) !== expectedRuntimeProfileId)
  ) {
    throw new AgentInstallationManagerError("installation_conflict");
  }
}

export class AgentInstallationManager {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly client: AgentInstallationClient;
  private readonly trust: AgentInstallationTrust;
  private readonly cache: AgentInstallationVersionCache;
  private readonly projection: AgentInstallationProjection;
  private readonly profileBindings: AgenteraProfileBindingStore;
  private readonly profiles: AgentInstallationProfileAdapter;
  private readonly owner: AgenteraRuntimeOwner;
  private readonly runtimeVersion: string;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(options: AgentInstallationManagerOptions) {
    if (
      typeof options.client.origin !== "string" ||
      options.client.origin.length === 0 ||
      typeof options.runtimeVersion !== "string" ||
      options.runtimeVersion.length === 0 ||
      options.runtimeVersion.length > 128
    ) {
      throw new AgentInstallationManagerError("invalid_installation_request");
    }
    this.database = options.database;
    this.client = options.client;
    this.trust = options.trust;
    this.cache = options.cache;
    this.projection = options.projection;
    this.profileBindings = options.profileBindings;
    this.profiles = options.profiles;
    this.owner = {
      tenantId: uuid(options.owner.tenantId),
      ownerId: uuid(options.owner.ownerId),
      deviceInstallationId: uuid(options.owner.deviceInstallationId),
    };
    this.runtimeVersion = options.runtimeVersion;
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  getLocalInstallation(
    agentInstallationIdInput: string,
  ): LocalAgentInstallation {
    const agentInstallationId = uuid(agentInstallationIdInput);
    const row = this.database.sqlite
      .prepare(
        `SELECT * FROM local_agent_installations
         WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?`,
      )
      .get(
        agentInstallationId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      ) as LocalInstallationRow | undefined;
    if (!row) {
      throw new AgentInstallationManagerError("installation_not_found");
    }
    return parseLocalRow(row);
  }

  listLocalInstallations(
    context: AgentAssetContext = { scope: "USER" },
  ): LocalAgentInstallation[] {
    const source = normalizeInstallationSource(context);
    const rows = this.database.sqlite
      .prepare(
        `SELECT * FROM local_agent_installations
         WHERE tenant_id = ? AND owner_id = ? AND device_installation_id = ?
           AND source_scope = ? AND source_workspace_id IS ?
           AND source_organization_id IS ?
         ORDER BY created_at DESC, agent_installation_id ASC`,
      )
      .all(
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
        source.scope,
        source.workspaceId,
        source.organizationId,
      ) as LocalInstallationRow[];
    return rows.map(parseLocalRow);
  }

  async install(input: {
    definitionId: string;
    versionId: string;
    profile: AgentInstallationProfileTarget;
    source?: AgentAssetContext | AgentInstallationSource;
  }): Promise<LocalAgentInstallation> {
    const definitionId = uuid(input.definitionId);
    const versionId = uuid(input.versionId);
    const source = normalizeInstallationSource(input.source);
    if (source.scope === "PLATFORM" && input.profile.kind !== "fresh") {
      throw new AgentInstallationManagerError("invalid_installation_request");
    }
    const intent = this.beginCreationIntent(definitionId, versionId, source);
    let creation: AgentInstallationCreation;
    try {
      const request: CreateAgentInstallationRequest = {
        definition_id: definitionId,
        ...(source.scope === "PLATFORM"
          ? {
              official_release_revision_id:
                source.selectedReleaseRevisionId as string,
            }
          : {
              version_id: versionId,
              ...(source.scope === "WORKSPACE"
                ? { workspace_id: source.workspaceId as string }
                : source.scope === "ORGANIZATION"
                  ? { organization_id: source.organizationId as string }
                  : {}),
            }),
      };
      creation = await this.client.createInstallation(
        request,
        intent.idempotencyKey,
      );
      assertPendingCreation(
        creation,
        definitionId,
        versionId,
        this.client.origin,
        source,
        this.owner,
      );
    } catch (error) {
      if (error instanceof AgentInstallationManagerError) throw error;
      throw new AgentInstallationManagerError("creation_failed");
    }

    const installationId = uuid(creation.installation.id);
    const policyId = uuid(creation.policy_snapshot.id);
    const createdAt = timestamp(this.now);
    try {
      const existing = this.database.sqlite
        .prepare(
          `SELECT * FROM local_agent_installations
           WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ?`,
        )
        .get(
          installationId,
          this.owner.tenantId,
          this.owner.ownerId,
          this.owner.deviceInstallationId,
        ) as LocalInstallationRow | undefined;
      if (existing) {
        const parsed = parseLocalRow(existing);
        if (
          parsed.definitionId !== definitionId ||
          parsed.selectedVersionId !== versionId ||
          parsed.policySnapshotId !== policyId ||
          parsed.sourceScope !== source.scope ||
          parsed.sourceWorkspaceId !== source.workspaceId ||
          parsed.sourceOrganizationId !== source.organizationId ||
          parsed.officialReleaseId !== source.officialReleaseId ||
          parsed.selectedReleaseRevisionId !==
            source.selectedReleaseRevisionId ||
          parsed.updatePolicy !== source.updatePolicy ||
          parsed.status !== "pending"
        ) {
          throw new AgentInstallationManagerError("installation_conflict");
        }
      } else {
        this.database.sqlite
          .prepare(
            `INSERT INTO local_agent_installations (
             agent_installation_id, tenant_id, owner_id, device_installation_id,
             source_scope, source_workspace_id, source_organization_id,
             official_release_id, selected_release_revision_id, update_policy,
             definition_id, selected_version_id,
             runtime_profile_id, policy_snapshot_id, status, retry_code,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending', NULL, ?, ?)`,
          )
          .run(
            installationId,
            this.owner.tenantId,
            this.owner.ownerId,
            this.owner.deviceInstallationId,
            source.scope,
            source.workspaceId,
            source.organizationId,
            source.officialReleaseId,
            source.selectedReleaseRevisionId,
            source.updatePolicy,
            definitionId,
            versionId,
            policyId,
            createdAt,
            createdAt,
          );
      }
      this.completeCreationIntent(intent.id);
    } catch (error) {
      if (error instanceof AgentInstallationManagerError) throw error;
      throw new AgentInstallationManagerError("installation_conflict");
    }

    return this.materializeAndActivate(
      this.getLocalInstallation(installationId),
      input.profile,
      creation.policy_snapshot,
    );
  }

  async retryPendingInstallation(input: {
    agentInstallationId: string;
    profile: AgentInstallationProfileTarget;
  }): Promise<LocalAgentInstallation> {
    const local = this.getLocalInstallation(input.agentInstallationId);
    if (local.status !== "pending") {
      throw new AgentInstallationManagerError("installation_conflict");
    }
    if (
      local.sourceScope === "PLATFORM" &&
      local.runtimeProfileId === null &&
      input.profile.kind !== "fresh"
    ) {
      throw new AgentInstallationManagerError("invalid_installation_request");
    }
    let policy: AgentPolicySnapshot;
    try {
      if (local.policySnapshotId === null) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      policy = await this.client.getPolicySnapshot(local.policySnapshotId);
    } catch (error) {
      this.recordFailure(local.agentInstallationId, "materialization_failed");
      if (error instanceof AgentInstallationManagerError) throw error;
      throw new AgentInstallationManagerError("materialization_failed");
    }
    return this.materializeAndActivate(local, input.profile, policy);
  }

  async selectInstallationVersion(input: {
    agentInstallationId: string;
    versionId: string;
    profilePath: string;
  }): Promise<LocalAgentInstallation> {
    const local = this.getLocalInstallation(input.agentInstallationId);
    const versionId = uuid(input.versionId);
    if (local.sourceScope === "PLATFORM") {
      throw new AgentInstallationManagerError("invalid_installation_request");
    }
    if (local.status !== "active" || local.runtimeProfileId === null) {
      throw new AgentInstallationManagerError("installation_conflict");
    }
    const binding = this.profileBindings.verifyProfileBinding(
      input.profilePath,
      this.owner,
    );
    if (
      binding.agentInstallationId !== local.agentInstallationId ||
      binding.runtimeProfileId !== local.runtimeProfileId
    ) {
      throw new AgentInstallationManagerError("installation_conflict");
    }

    let version: AgentVersion;
    let projection: HermesVersionProjection;
    try {
      const downloaded = await this.client.getVersion(versionId);
      assertVersion(downloaded, local.definitionId, versionId);
      version = this.cache.cacheVerifiedVersion(downloaded);
      assertVersion(version, local.definitionId, versionId);
      projection = this.projection.materializeVersion({
        agentInstallationId: local.agentInstallationId,
        version,
      });
    } catch {
      throw new AgentInstallationManagerError("update_failed");
    }

    let selected: AgentInstallation;
    try {
      selected = await this.client.selectInstallationVersion(
        local.agentInstallationId,
        versionId,
        operationKey("select", local.agentInstallationId, versionId),
      );
      assertCloudState(
        selected,
        local,
        "active",
        versionId,
        local.runtimeProfileId,
      );
      if (selected.policy_snapshot_id === undefined) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      const selectedPolicy = await this.client.getPolicySnapshot(
        selected.policy_snapshot_id,
      );
      assertPolicy(
        selectedPolicy,
        local.agentInstallationId,
        local.definitionId,
        version,
        this.client.origin,
        local,
        this.owner,
      );
      const verifiedPolicy = this.trust.verifyPolicy(selectedPolicy, {
        runtimeVersion: this.runtimeVersion,
      });
      if (verifiedPolicy.contentDigest !== selectedPolicy.content_digest) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      this.cache.cacheVerifiedPolicySnapshot(version.id, selectedPolicy);
      this.projection.activateForProfile({
        projection,
        profilePath: input.profilePath,
      });
    } catch {
      throw new AgentInstallationManagerError("update_failed");
    }

    this.database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET selected_version_id = ?, policy_snapshot_id = ?, retry_code = NULL,
             updated_at = ?
         WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ? AND status = 'active'`,
      )
      .run(
        versionId,
        selected.policy_snapshot_id ?? local.policySnapshotId,
        timestamp(this.now),
        local.agentInstallationId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      );
    return this.getLocalInstallation(local.agentInstallationId);
  }

  async archiveInstallation(
    agentInstallationIdInput: string,
  ): Promise<LocalAgentInstallation> {
    const local = this.getLocalInstallation(agentInstallationIdInput);
    if (local.status === "archived") return local;
    let archived: AgentInstallation;
    try {
      archived = await this.client.archiveInstallation(
        local.agentInstallationId,
        operationKey("archive", local.agentInstallationId),
      );
      assertCloudState(
        archived,
        local,
        "archived",
        local.selectedVersionId,
        local.runtimeProfileId,
      );
    } catch {
      throw new AgentInstallationManagerError("archive_failed");
    }
    this.database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET status = 'archived', retry_code = NULL, updated_at = ?
         WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?`,
      )
      .run(
        timestamp(this.now),
        local.agentInstallationId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      );
    return this.getLocalInstallation(local.agentInstallationId);
  }

  private async materializeAndActivate(
    local: LocalAgentInstallation,
    target: AgentInstallationProfileTarget,
    policy: AgentPolicySnapshot,
  ): Promise<LocalAgentInstallation> {
    let version: AgentVersion;
    let projection: HermesVersionProjection;
    let materializationStage: AgentInstallationRetryCode =
      "materialization_version_failed";
    try {
      const downloaded = await this.client.getVersion(local.selectedVersionId);
      assertVersion(downloaded, local.definitionId, local.selectedVersionId);
      version = this.cache.cacheVerifiedVersion(downloaded);
      assertVersion(version, local.definitionId, local.selectedVersionId);
      materializationStage = "materialization_policy_failed";
      assertPolicy(
        policy,
        local.agentInstallationId,
        local.definitionId,
        version,
        this.client.origin,
        local,
        this.owner,
      );
      const verifiedPolicy = this.trust.verifyPolicy(policy, {
        runtimeVersion: this.runtimeVersion,
      });
      if (verifiedPolicy.contentDigest !== policy.content_digest) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      this.cache.cacheVerifiedPolicySnapshot(version.id, policy);
      materializationStage = "materialization_projection_failed";
      projection = this.projection.materializeVersion({
        agentInstallationId: local.agentInstallationId,
        version,
      });
    } catch (error) {
      reportStageFailure("materialization", error);
      this.recordFailure(local.agentInstallationId, materializationStage);
      throw new AgentInstallationManagerError("materialization_failed");
    }

    let profilePath: string;
    let binding: RuntimeOwnerBinding;
    let profileStage: AgentInstallationRetryCode = "profile_creation_failed";
    try {
      if (local.runtimeProfileId !== null && target.kind !== "claim") {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      if (target.kind === "fresh") {
        const created = this.profileBindings.createAndBindFreshProfile({
          name: target.name,
          owner: this.owner,
          createProfile: this.profiles.createProfile,
          resolveProfilePath: this.profiles.resolveProfilePath,
          activateProfile: this.profiles.activateProfile,
        });
        profilePath = this.profiles.resolveProfilePath(created.profileId);
        binding = created.binding;
      } else {
        profilePath = target.profilePath;
        binding = this.profileBindings.bindExistingProfile(
          profilePath,
          this.owner,
        );
      }
      if (
        local.runtimeProfileId !== null &&
        binding.runtimeProfileId !== local.runtimeProfileId
      ) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      profileStage = "profile_attachment_failed";
      this.database.sqlite
        .prepare(
          `UPDATE local_agent_installations
           SET runtime_profile_id = ?, updated_at = ?
           WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ? AND status = 'pending'`,
        )
        .run(
          binding.runtimeProfileId,
          timestamp(this.now),
          local.agentInstallationId,
          this.owner.tenantId,
          this.owner.ownerId,
          this.owner.deviceInstallationId,
        );
      binding = this.profileBindings.attachAgentInstallation(
        profilePath,
        this.owner,
        local.agentInstallationId,
      );
      profileStage = "profile_projection_failed";
      this.projection.activateForProfile({ projection, profilePath });
    } catch {
      this.recordFailure(local.agentInstallationId, profileStage);
      throw new AgentInstallationManagerError("profile_binding_failed");
    }

    try {
      const activated = await this.client.activateInstallation(
        local.agentInstallationId,
        binding.runtimeProfileId,
        version.content_digest,
        operationKey("activate", local.agentInstallationId),
      );
      assertCloudState(
        activated,
        { ...local, runtimeProfileId: binding.runtimeProfileId },
        "active",
        local.selectedVersionId,
        binding.runtimeProfileId,
      );
      if (
        local.policySnapshotId === null ||
        activated.policy_snapshot_id === undefined ||
        uuid(activated.policy_snapshot_id) !== local.policySnapshotId
      ) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      this.database.sqlite
        .prepare(
          `UPDATE local_agent_installations
           SET runtime_profile_id = ?, policy_snapshot_id = ?, status = 'active',
               retry_code = NULL, updated_at = ?
           WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ? AND status = 'pending'`,
        )
        .run(
          binding.runtimeProfileId,
          activated.policy_snapshot_id,
          timestamp(this.now),
          local.agentInstallationId,
          this.owner.tenantId,
          this.owner.ownerId,
          this.owner.deviceInstallationId,
        );
    } catch {
      this.recordFailure(local.agentInstallationId, "activation_failed");
      throw new AgentInstallationManagerError("activation_failed");
    }
    return this.getLocalInstallation(local.agentInstallationId);
  }

  private recordFailure(
    agentInstallationId: string,
    code: AgentInstallationRetryCode,
  ): void {
    this.database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET retry_code = ?, updated_at = ?
         WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ? AND status = 'pending'`,
      )
      .run(
        code,
        timestamp(this.now),
        agentInstallationId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      );
  }

  private beginCreationIntent(
    definitionId: string,
    versionId: string,
    source: NormalizedInstallationSource,
  ): InstallationCreationIntent {
    const rows = this.database.sqlite
      .prepare(
        `SELECT id, payload_json
         FROM pending_sanitized_records
         WHERE record_type = 'agent_installation_create' AND tenant_id = ?
           AND owner_id = ? AND device_installation_id = ?
         ORDER BY created_at ASC`,
      )
      .all(
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      ) as Array<{ id?: unknown; payload_json?: unknown }>;
    const matches: InstallationCreationIntent[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.payload_json !== "string") {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      const record = payload as Record<string, unknown>;
      const keys = Object.keys(record).sort().join("\0");
      const legacyKeys = ["definition_id", "idempotency_key", "version_id"]
        .sort()
        .join("\0");
      const legacyScopedKeys = [
        "definition_id",
        "idempotency_key",
        "source_scope",
        "source_workspace_id",
        "version_id",
      ]
        .sort()
        .join("\0");
      const scopedKeys = [
        "definition_id",
        "idempotency_key",
        "source_organization_id",
        "source_scope",
        "source_workspace_id",
        "version_id",
      ]
        .sort()
        .join("\0");
      const platformKeys = [
        "definition_id",
        "idempotency_key",
        "official_release_id",
        "selected_release_revision_id",
        "source_organization_id",
        "source_scope",
        "source_workspace_id",
        "update_policy",
        "version_id",
      ]
        .sort()
        .join("\0");
      if (
        (keys !== legacyKeys &&
          keys !== legacyScopedKeys &&
          keys !== scopedKeys &&
          keys !== platformKeys) ||
        uuid(row.id) !== uuid(record.idempotency_key)
      ) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      let storedSource: NormalizedInstallationSource;
      if (keys === legacyKeys) {
        storedSource = {
          scope: "USER",
          workspaceId: null,
          organizationId: null,
          officialReleaseId: null,
          selectedReleaseRevisionId: null,
          updatePolicy: "manual",
        };
      } else if (
        record.source_scope === "USER" &&
        record.source_workspace_id === null &&
        (keys === legacyScopedKeys || record.source_organization_id === null)
      ) {
        storedSource = {
          scope: "USER",
          workspaceId: null,
          organizationId: null,
          officialReleaseId: null,
          selectedReleaseRevisionId: null,
          updatePolicy: "manual",
        };
      } else if (
        record.source_scope === "WORKSPACE" &&
        record.source_workspace_id !== null &&
        (keys === legacyScopedKeys || record.source_organization_id === null)
      ) {
        storedSource = {
          scope: "WORKSPACE",
          workspaceId: uuid(record.source_workspace_id),
          organizationId: null,
          officialReleaseId: null,
          selectedReleaseRevisionId: null,
          updatePolicy: "manual",
        };
      } else if (
        keys === scopedKeys &&
        record.source_scope === "ORGANIZATION" &&
        record.source_workspace_id === null &&
        record.source_organization_id !== null
      ) {
        storedSource = {
          scope: "ORGANIZATION",
          workspaceId: null,
          organizationId: uuid(record.source_organization_id),
          officialReleaseId: null,
          selectedReleaseRevisionId: null,
          updatePolicy: "manual",
        };
      } else if (
        keys === platformKeys &&
        record.source_scope === "PLATFORM" &&
        record.source_workspace_id === null &&
        record.source_organization_id === null &&
        record.update_policy === "managed"
      ) {
        storedSource = {
          scope: "PLATFORM",
          workspaceId: null,
          organizationId: null,
          officialReleaseId: uuid(record.official_release_id),
          selectedReleaseRevisionId: uuid(record.selected_release_revision_id),
          updatePolicy: "managed",
        };
      } else {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      if (
        uuid(record.definition_id) === definitionId &&
        uuid(record.version_id) === versionId &&
        storedSource.scope === source.scope &&
        storedSource.workspaceId === source.workspaceId &&
        storedSource.organizationId === source.organizationId &&
        storedSource.officialReleaseId === source.officialReleaseId &&
        storedSource.selectedReleaseRevisionId ===
          source.selectedReleaseRevisionId &&
        storedSource.updatePolicy === source.updatePolicy
      ) {
        matches.push({
          id: row.id,
          definitionId,
          versionId,
          idempotencyKey: row.id,
          sourceScope: storedSource.scope,
          sourceWorkspaceId: storedSource.workspaceId,
          sourceOrganizationId: storedSource.organizationId,
          officialReleaseId: storedSource.officialReleaseId,
          selectedReleaseRevisionId: storedSource.selectedReleaseRevisionId,
          updatePolicy: storedSource.updatePolicy,
        });
      }
    }
    if (matches.length > 1) {
      throw new AgentInstallationManagerError("installation_conflict");
    }
    if (matches.length === 1) return matches[0];

    const id = uuid(this.randomUUID());
    const createdAt = timestamp(this.now);
    const payload = JSON.stringify(
      source.scope === "PLATFORM"
        ? {
            definition_id: definitionId,
            version_id: versionId,
            idempotency_key: id,
            source_scope: source.scope,
            source_workspace_id: null,
            source_organization_id: null,
            official_release_id: source.officialReleaseId,
            selected_release_revision_id: source.selectedReleaseRevisionId,
            update_policy: "managed",
          }
        : {
            definition_id: definitionId,
            version_id: versionId,
            idempotency_key: id,
            source_scope: source.scope,
            source_workspace_id: source.workspaceId,
            source_organization_id: source.organizationId,
          },
    );
    this.database.sqlite
      .prepare(
        `INSERT INTO pending_sanitized_records (
           id, tenant_id, owner_id, device_installation_id,
           record_type, payload_json, attempt_count, next_attempt_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'agent_installation_create', ?, 0, NULL, ?, ?)`,
      )
      .run(
        id,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
        payload,
        createdAt,
        createdAt,
      );
    return {
      id,
      definitionId,
      versionId,
      idempotencyKey: id,
      sourceScope: source.scope,
      sourceWorkspaceId: source.workspaceId,
      sourceOrganizationId: source.organizationId,
      officialReleaseId: source.officialReleaseId,
      selectedReleaseRevisionId: source.selectedReleaseRevisionId,
      updatePolicy: source.updatePolicy,
    };
  }

  private completeCreationIntent(id: string): void {
    const result = this.database.sqlite
      .prepare(
        `DELETE FROM pending_sanitized_records
         WHERE id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?
           AND record_type = 'agent_installation_create'`,
      )
      .run(
        id,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      );
    if (Number(result.changes) !== 1) {
      throw new AgentInstallationManagerError("installation_conflict");
    }
  }
}
