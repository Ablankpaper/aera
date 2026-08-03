import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type {
  OfficialAgentSummary,
  OfficialManagedUpdate,
} from "../../shared/agentera-agent-control";
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
import type { SessionModelOverride } from "../../shared/model-override";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
const RESTORE_MAXIMUM_FILES = 100_000;
const RESTORE_MAXIMUM_BYTES = 1024 * 1024 * 1024;
const RESTORE_PROVENANCE_MAXIMUM_BYTES = 1024 * 1024;
const RESTORE_COPY_BUFFER_BYTES = 256 * 1024;

export type AgentInstallationManagerErrorCode =
  | "invalid_installation_request"
  | "installation_conflict"
  | "creation_failed"
  | "materialization_failed"
  | "profile_binding_failed"
  | "profile_model_configuration_failed"
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
  | "profile_model_configuration_failed"
  | "profile_attachment_failed"
  | "profile_projection_failed"
  | "managed_update_target_failed"
  | "managed_update_version_failed"
  | "managed_update_projection_failed"
  | "managed_update_cloud_failed"
  | "managed_update_policy_failed"
  | "managed_update_activation_failed";

export class AgentInstallationManagerError extends Error {
  readonly code: AgentInstallationManagerErrorCode;

  constructor(code: AgentInstallationManagerErrorCode) {
    super(`Aera Agent installation failed: ${code}.`);
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
  getOfficialAgent(definitionId: string): Promise<{
    agent: OfficialAgentSummary;
    version: AgentVersion;
  }>;
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
  getManagedUpdate(
    installationId: string,
  ): Promise<OfficialManagedUpdate | null>;
  applyManagedUpdate(
    installationId: string,
    expectedSelectedReleaseRevisionId: string,
    targetReleaseRevisionId: string,
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
  profileIdForAgentName(name: string): string;
  createProfile(
    name: string,
    cloneFrom: string | null,
    reservedProfileId?: string,
  ): ProfileCreationResult;
  deleteProfile(profileId: string): { success: boolean; error?: string };
  resolveProfilePath(profileId: string): string;
  activateProfile(profileId: string): void;
  readProfileModelConfig?: (profilePath: string) => SessionModelOverride;
  configureFreshProfileModel?: (input: {
    sourceProfileId: string;
    targetProfileId: string;
    version: AgentVersion;
    policy: AgentPolicySnapshot;
    sourceModelId?: string;
  }) => void;
}

export type AgentInstallationProfileTarget =
  | {
      kind: "fresh";
      name: string;
      modelSourceProfileId?: string;
      modelSourceModelId?: string;
    }
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

export interface ActivateVerifiedRestoreInput {
  backupId: string;
  sourceInstallationId: string;
  definitionId: string;
  versionId: string;
  profileLineageId: string;
  name: string;
  stagedProfilePath: string;
  encryptedRuntimeBindingProvenancePath: string;
}

export interface ActivatedVerifiedRestore {
  agentInstallationId: string;
  profileId: string;
  runtimeProfileId: string;
  sourceScope: "USER";
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

interface ManagedUpdateIntent {
  id: string;
  installationId: string;
  expectedSelectedReleaseRevisionId: string;
  targetReleaseRevisionId: string;
  targetVersionId: string;
  idempotencyKey: string;
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
    uuid(context.device_installation_id) === owner.deviceInstallationId &&
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

async function downloadManagedOfficialTarget(
  client: AgentInstallationClient,
  local: LocalAgentInstallation,
  intent: ManagedUpdateIntent,
): Promise<AgentVersion> {
  if (local.sourceScope !== "PLATFORM" || local.officialReleaseId === null) {
    throw new AgentInstallationManagerError("installation_conflict");
  }
  let officialDetailError: unknown;
  try {
    const detail = await client.getOfficialAgent(local.definitionId);
    if (
      detail.agent.definitionId !== local.definitionId ||
      detail.agent.releaseId !== local.officialReleaseId ||
      detail.agent.releaseRevisionId !== intent.targetReleaseRevisionId ||
      detail.agent.versionId !== intent.targetVersionId
    ) {
      throw new AgentInstallationManagerError("installation_conflict");
    }
    return detail.version;
  } catch (error) {
    officialDetailError = error;
  }

  // An earlier idempotent apply may already have advanced Cloud while local
  // activation failed. In that case the installation-bound version endpoint
  // remains the only authorized way to recover the exact selected bytes.
  try {
    return await client.getVersion(intent.targetVersionId);
  } catch {
    throw officialDetailError;
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

function assertManagedCloudState(
  installation: AgentInstallation,
  local: LocalAgentInstallation,
  intent: ManagedUpdateIntent,
): void {
  if (
    local.sourceScope !== "PLATFORM" ||
    local.officialReleaseId === null ||
    local.runtimeProfileId === null ||
    uuid(installation.id) !== local.agentInstallationId ||
    uuid(installation.definition_id) !== local.definitionId ||
    uuid(installation.selected_version_id) !== intent.targetVersionId ||
    installation.status !== "active" ||
    installation.update_policy !== "managed" ||
    installation.official_release_id === undefined ||
    uuid(installation.official_release_id) !== local.officialReleaseId ||
    installation.selected_release_revision_id === undefined ||
    uuid(installation.selected_release_revision_id) !==
      intent.targetReleaseRevisionId ||
    installation.runtime_profile_id === undefined ||
    uuid(installation.runtime_profile_id) !== local.runtimeProfileId ||
    installation.policy_snapshot_id === undefined
  ) {
    throw new AgentInstallationManagerError("installation_conflict");
  }
  uuid(installation.policy_snapshot_id);
}

function restoreFailure(
  code: "destination_exists" | "activation_failed",
): Error {
  return Object.assign(
    new Error(`Aera encrypted backup restore failed: ${code}.`),
    { code },
  );
}

function insidePath(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function allowedRestoredProfilePath(path: string): boolean {
  if (
    path.length < 1 ||
    path.length > 1024 ||
    path !== path.normalize("NFC") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.includes("//")
  ) {
    return false;
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length < 1 ||
        segment === "." ||
        segment === ".." ||
        segment.toLocaleLowerCase("en-US").endsWith(".pem") ||
        segment.toLocaleLowerCase("en-US").endsWith(".key"),
    )
  ) {
    return false;
  }
  return (
    path === "memories/MEMORY.md" ||
    path === "memories/USER.md" ||
    path === "config.yaml" ||
    path === "state.db" ||
    path.startsWith("skills/") ||
    path.startsWith("curator/") ||
    path.startsWith(".curator/") ||
    path.startsWith("files/")
  );
}

interface RestoreSourceFile {
  path: string;
  relativePath: string;
  size: number;
}

function listRestoredProfileFiles(
  stagedProfilePath: string,
): RestoreSourceFile[] {
  if (!isAbsolute(stagedProfilePath)) {
    throw restoreFailure("activation_failed");
  }
  const root = resolve(stagedProfilePath);
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw restoreFailure("activation_failed");
  }
  const files: RestoreSourceFile[] = [];
  let totalBytes = 0;
  const visit = (directory: string, prefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath =
        prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        throw restoreFailure("activation_failed");
      }
      if (stats.isDirectory()) {
        visit(path, relativePath);
        continue;
      }
      if (!stats.isFile() || !allowedRestoredProfilePath(relativePath)) {
        throw restoreFailure("activation_failed");
      }
      files.push({ path, relativePath, size: stats.size });
      totalBytes += stats.size;
      if (
        files.length > RESTORE_MAXIMUM_FILES ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > RESTORE_MAXIMUM_BYTES
      ) {
        throw restoreFailure("activation_failed");
      }
    }
  };
  visit(root, "");
  return files;
}

function ensureRestoreParent(profilePath: string, destination: string): void {
  if (!insidePath(profilePath, destination) || destination === profilePath) {
    throw restoreFailure("activation_failed");
  }
  const relativeParent = relative(profilePath, dirname(destination));
  let current = profilePath;
  if (relativeParent.length === 0) return;
  for (const segment of relativeParent.split(/[\\/]/)) {
    current = join(current, segment);
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
    }
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw restoreFailure("activation_failed");
    }
    chmodSync(current, 0o700);
  }
}

function copyRestoreFile(
  source: RestoreSourceFile,
  profilePath: string,
  temporaryId: string,
): void {
  const destination = join(profilePath, ...source.relativePath.split("/"));
  ensureRestoreParent(profilePath, destination);
  if (existsSync(destination)) {
    const destinationStats = lstatSync(destination);
    if (destinationStats.isSymbolicLink() || !destinationStats.isFile()) {
      throw restoreFailure("activation_failed");
    }
  }
  const temporary = join(
    dirname(destination),
    `.agentera-restore-${temporaryId}`,
  );
  let sourceDescriptor: number | null = null;
  let destinationDescriptor: number | null = null;
  const buffer = Buffer.allocUnsafe(RESTORE_COPY_BUFFER_BYTES);
  try {
    sourceDescriptor = openSync(
      source.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const sourceStats = fstatSync(sourceDescriptor);
    if (!sourceStats.isFile() || sourceStats.size !== source.size) {
      throw restoreFailure("activation_failed");
    }
    destinationDescriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let copied = 0;
    while (copied < source.size) {
      const count = readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, source.size - copied),
        null,
      );
      if (count < 1) throw restoreFailure("activation_failed");
      let offset = 0;
      while (offset < count) {
        offset += writeSync(
          destinationDescriptor,
          buffer,
          offset,
          count - offset,
        );
      }
      copied += count;
    }
    if (readSync(sourceDescriptor, buffer, 0, 1, null) !== 0) {
      throw restoreFailure("activation_failed");
    }
    fsyncSync(destinationDescriptor);
    closeSync(destinationDescriptor);
    destinationDescriptor = null;
    chmodSync(temporary, 0o600);
    if (existsSync(destination)) unlinkSync(destination);
    renameSync(temporary, destination);
  } finally {
    buffer.fill(0);
    if (sourceDescriptor !== null) closeSync(sourceDescriptor);
    if (destinationDescriptor !== null) closeSync(destinationDescriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function materializeRestoredProfile(
  stagedProfilePath: string,
  profilePathValue: string,
  randomUUID: () => string,
): void {
  if (!isAbsolute(profilePathValue)) {
    throw restoreFailure("activation_failed");
  }
  const profilePath = resolve(profilePathValue);
  const stats = lstatSync(profilePath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw restoreFailure("activation_failed");
  }
  chmodSync(profilePath, 0o700);
  const files = listRestoredProfileFiles(stagedProfilePath);
  for (const source of files) {
    copyRestoreFile(source, profilePath, uuid(randomUUID()));
  }
}

function readEncryptedRestoreProvenance(pathValue: string): Buffer {
  if (!isAbsolute(pathValue)) {
    throw restoreFailure("activation_failed");
  }
  const path = resolve(pathValue);
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size < 1 ||
    stats.size > RESTORE_PROVENANCE_MAXIMUM_BYTES
  ) {
    throw restoreFailure("activation_failed");
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = fstatSync(descriptor);
    if (!current.isFile() || current.size !== stats.size) {
      throw restoreFailure("activation_failed");
    }
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength !== stats.size) {
      bytes.fill(0);
      throw restoreFailure("activation_failed");
    }
    return bytes;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
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

  listManagedInstallations(): LocalAgentInstallation[] {
    const rows = this.database.sqlite
      .prepare(
        `SELECT * FROM local_agent_installations
         WHERE tenant_id = ? AND owner_id = ? AND device_installation_id = ?
           AND source_scope = 'PLATFORM' AND update_policy = 'managed'
         ORDER BY created_at DESC, agent_installation_id ASC`,
      )
      .all(
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      ) as LocalInstallationRow[];
    return rows.map(parseLocalRow);
  }

  async verifyImmutableUserBase(input: {
    definitionId: string;
    versionId: string;
    ownerScope: "USER";
  }): Promise<void> {
    if (input.ownerScope !== "USER") {
      throw new AgentInstallationManagerError("invalid_installation_request");
    }
    const definitionId = uuid(input.definitionId);
    const versionId = uuid(input.versionId);
    try {
      const downloaded = await this.client.getVersion(versionId);
      assertVersion(downloaded, definitionId, versionId);
      const verified = this.cache.cacheVerifiedVersion(downloaded);
      assertVersion(verified, definitionId, versionId);
    } catch (error) {
      reportStageFailure("restore-base-verification", error);
      throw new AgentInstallationManagerError("materialization_failed");
    }
  }

  async activateVerifiedRestore(
    input: ActivateVerifiedRestoreInput,
  ): Promise<ActivatedVerifiedRestore> {
    const backupId = uuid(input.backupId);
    const sourceInstallationId = uuid(input.sourceInstallationId);
    const definitionId = uuid(input.definitionId);
    const versionId = uuid(input.versionId);
    const profileLineageId = uuid(input.profileLineageId);
    await this.verifyImmutableUserBase({
      definitionId,
      versionId,
      ownerScope: "USER",
    });

    let profileId: string | null = null;
    let profilePath: string | null = null;
    let installed: LocalAgentInstallation | null = null;
    let binding: RuntimeOwnerBinding | null = null;
    let provenance: Buffer | null = null;
    try {
      const created = this.profiles.createProfile(input.name, null);
      if (
        !created.success ||
        typeof created.id !== "string" ||
        !PROFILE_ID_PATTERN.test(created.id)
      ) {
        if (
          typeof created.error === "string" &&
          /exist|already|duplicate/i.test(created.error)
        ) {
          throw restoreFailure("destination_exists");
        }
        throw restoreFailure("activation_failed");
      }
      profileId = created.id;
      profilePath = this.profiles.resolveProfilePath(profileId);
      if (
        !isAbsolute(profilePath) ||
        basename(resolve(profilePath)) !== profileId
      ) {
        throw restoreFailure("activation_failed");
      }
      materializeRestoredProfile(
        input.stagedProfilePath,
        profilePath,
        this.randomUUID,
      );
      provenance = readEncryptedRestoreProvenance(
        input.encryptedRuntimeBindingProvenancePath,
      );
      installed = await this.install({
        definitionId,
        versionId,
        source: { scope: "USER" },
        profile: {
          kind: "claim",
          profileId,
          profilePath,
        },
      });
      if (
        installed.sourceScope !== "USER" ||
        installed.sourceWorkspaceId !== null ||
        installed.sourceOrganizationId !== null ||
        installed.selectedVersionId !== versionId ||
        installed.definitionId !== definitionId ||
        installed.runtimeProfileId === null ||
        installed.agentInstallationId === sourceInstallationId
      ) {
        throw restoreFailure("activation_failed");
      }
      binding = this.profileBindings.verifyProfileBinding(
        profilePath,
        this.owner,
      );
      if (
        binding.agentInstallationId !== installed.agentInstallationId ||
        binding.runtimeProfileId !== installed.runtimeProfileId
      ) {
        throw restoreFailure("activation_failed");
      }

      this.database.sqlite.exec("BEGIN IMMEDIATE");
      try {
        this.database.sqlite
          .prepare(
            `INSERT INTO encrypted_backup_restores (
               backup_id, tenant_id, owner_id, device_installation_id,
               source_installation_id, agent_installation_id,
               runtime_profile_id, profile_lineage_id,
               encrypted_runtime_binding_provenance,
               historical_sessions_read_only, restored_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          )
          .run(
            backupId,
            this.owner.tenantId,
            this.owner.ownerId,
            this.owner.deviceInstallationId,
            sourceInstallationId,
            installed.agentInstallationId,
            installed.runtimeProfileId,
            profileLineageId,
            provenance,
            timestamp(this.now),
          );
        this.database.sqlite.exec("COMMIT");
      } catch (error) {
        try {
          this.database.sqlite.exec("ROLLBACK");
        } catch {
          // Preserve the restore provenance persistence failure.
        }
        throw error;
      }
      this.profiles.activateProfile(profileId);
      return {
        agentInstallationId: installed.agentInstallationId,
        profileId,
        runtimeProfileId: installed.runtimeProfileId,
        sourceScope: "USER",
      };
    } catch (error) {
      if (profilePath !== null && binding === null) {
        try {
          binding = this.profileBindings.verifyProfileBinding(
            profilePath,
            this.owner,
          );
        } catch {
          // The failure may have happened before local binding.
        }
      }
      await this.rollbackVerifiedRestore({
        backupId,
        profileId,
        profilePath,
        installed,
        binding,
      });
      if (
        (error as { code?: unknown })?.code === "destination_exists" ||
        error instanceof AgentInstallationManagerError
      ) {
        throw error;
      }
      if ((error as { code?: unknown })?.code === "ENOSPC") {
        throw error;
      }
      throw restoreFailure("activation_failed");
    } finally {
      provenance?.fill(0);
    }
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
      reportStageFailure("creation", error);
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

  async repairInstallationModel(input: {
    agentInstallationId: string;
    profilePath: string;
    localProfileId: string;
    modelSourceProfileId: string;
    modelSourceModelId?: string;
  }): Promise<LocalAgentInstallation> {
    const local = this.getLocalInstallation(input.agentInstallationId);
    if (local.status !== "active" || local.runtimeProfileId === null) {
      throw new AgentInstallationManagerError("installation_conflict");
    }

    try {
      const targetBinding = this.profileBindings.verifyProfileBinding(
        input.profilePath,
        this.owner,
      );
      if (
        targetBinding.agentInstallationId !== local.agentInstallationId ||
        targetBinding.runtimeProfileId !== local.runtimeProfileId
      ) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      this.profileBindings.verifyProfileBinding(
        this.profiles.resolveProfilePath(input.modelSourceProfileId),
        this.owner,
      );
    } catch {
      throw new AgentInstallationManagerError("profile_binding_failed");
    }

    let version: AgentVersion;
    let policy: AgentPolicySnapshot;
    try {
      version = this.cache.getVerifiedVersion(local.selectedVersionId);
      assertVersion(version, local.definitionId, local.selectedVersionId);
      if (local.policySnapshotId === null) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      policy = this.cache.getVerifiedPolicySnapshot(
        local.selectedVersionId,
        local.policySnapshotId,
      );
    } catch {
      throw new AgentInstallationManagerError("materialization_failed");
    }

    try {
      if (!this.profiles.configureFreshProfileModel) {
        throw new Error("Runtime Profile model configuration is unavailable.");
      }
      this.profiles.configureFreshProfileModel({
        sourceProfileId: input.modelSourceProfileId,
        targetProfileId: input.localProfileId,
        version,
        policy,
        ...(input.modelSourceModelId
          ? { sourceModelId: input.modelSourceModelId }
          : {}),
      });
    } catch {
      throw new AgentInstallationManagerError(
        "profile_model_configuration_failed",
      );
    }

    this.database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET retry_code = NULL, updated_at = ?
         WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ? AND status = 'active'
           AND runtime_profile_id = ?`,
      )
      .run(
        timestamp(this.now),
        local.agentInstallationId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
        local.runtimeProfileId,
      );
    return this.getLocalInstallation(local.agentInstallationId);
  }

  async applyManagedOfficialUpdate(
    agentInstallationIdInput: string,
  ): Promise<LocalAgentInstallation> {
    let local = this.getLocalInstallation(agentInstallationIdInput);
    if (
      local.sourceScope !== "PLATFORM" ||
      local.updatePolicy !== "managed" ||
      local.officialReleaseId === null ||
      local.selectedReleaseRevisionId === null ||
      local.runtimeProfileId === null ||
      local.policySnapshotId === null ||
      local.status !== "active"
    ) {
      throw new AgentInstallationManagerError("invalid_installation_request");
    }

    let intent = this.getManagedUpdateIntent(local.agentInstallationId);
    if (!intent) {
      let update: OfficialManagedUpdate | null;
      try {
        update = await this.client.getManagedUpdate(local.agentInstallationId);
      } catch (error) {
        reportStageFailure("managed-update-target", error);
        this.recordManagedUpdateFailure(
          local.agentInstallationId,
          "managed_update_target_failed",
        );
        throw new AgentInstallationManagerError("update_failed");
      }
      if (update === null) {
        this.clearManagedUpdateFailure(local.agentInstallationId);
        return this.getLocalInstallation(local.agentInstallationId);
      }
      let normalized: Omit<ManagedUpdateIntent, "id" | "idempotencyKey">;
      try {
        normalized = {
          installationId: uuid(update.installationId),
          expectedSelectedReleaseRevisionId: uuid(
            update.expectedSelectedReleaseRevisionId,
          ),
          targetReleaseRevisionId: uuid(update.targetReleaseRevisionId),
          targetVersionId: uuid(update.targetVersionId),
        };
      } catch {
        this.recordManagedUpdateFailure(
          local.agentInstallationId,
          "managed_update_target_failed",
        );
        throw new AgentInstallationManagerError("update_failed");
      }
      if (
        normalized.installationId !== local.agentInstallationId ||
        normalized.expectedSelectedReleaseRevisionId !==
          local.selectedReleaseRevisionId ||
        normalized.targetReleaseRevisionId ===
          normalized.expectedSelectedReleaseRevisionId
      ) {
        this.recordManagedUpdateFailure(
          local.agentInstallationId,
          "managed_update_target_failed",
        );
        throw new AgentInstallationManagerError("update_failed");
      }
      intent = this.beginManagedUpdateIntent(normalized);
    }

    if (
      local.selectedVersionId === intent.targetVersionId &&
      local.selectedReleaseRevisionId === intent.targetReleaseRevisionId
    ) {
      this.completeManagedUpdateIntent(intent.id);
      this.clearManagedUpdateFailure(local.agentInstallationId);
      return this.getLocalInstallation(local.agentInstallationId);
    }
    if (
      local.selectedReleaseRevisionId !==
      intent.expectedSelectedReleaseRevisionId
    ) {
      throw new AgentInstallationManagerError("installation_conflict");
    }

    let version: AgentVersion;
    let projection: HermesVersionProjection;
    try {
      const downloaded = await downloadManagedOfficialTarget(
        this.client,
        local,
        intent,
      );
      assertVersion(downloaded, local.definitionId, intent.targetVersionId);
      version = this.cache.cacheVerifiedVersion(downloaded);
      assertVersion(version, local.definitionId, intent.targetVersionId);
    } catch (error) {
      reportStageFailure("managed-update-version", error);
      this.recordManagedUpdateFailure(
        local.agentInstallationId,
        "managed_update_version_failed",
      );
      throw new AgentInstallationManagerError("update_failed");
    }
    try {
      projection = this.projection.materializeVersion({
        agentInstallationId: local.agentInstallationId,
        version,
      });
    } catch (error) {
      reportStageFailure("managed-update-projection", error);
      this.recordManagedUpdateFailure(
        local.agentInstallationId,
        "managed_update_projection_failed",
      );
      throw new AgentInstallationManagerError("update_failed");
    }

    let selected: AgentInstallation;
    try {
      selected = await this.client.applyManagedUpdate(
        local.agentInstallationId,
        intent.expectedSelectedReleaseRevisionId,
        intent.targetReleaseRevisionId,
        intent.idempotencyKey,
      );
      assertManagedCloudState(selected, local, intent);
    } catch (error) {
      reportStageFailure("managed-update-cloud", error);
      this.recordManagedUpdateFailure(
        local.agentInstallationId,
        "managed_update_cloud_failed",
      );
      throw new AgentInstallationManagerError("update_failed");
    }

    const targetLocal: LocalAgentInstallation = {
      ...local,
      selectedVersionId: intent.targetVersionId,
      selectedReleaseRevisionId: intent.targetReleaseRevisionId,
    };
    let selectedPolicy: AgentPolicySnapshot;
    try {
      selectedPolicy = await this.client.getPolicySnapshot(
        selected.policy_snapshot_id as string,
      );
      assertPolicy(
        selectedPolicy,
        local.agentInstallationId,
        local.definitionId,
        version,
        this.client.origin,
        targetLocal,
        this.owner,
      );
      const verifiedPolicy = this.trust.verifyPolicy(selectedPolicy, {
        runtimeVersion: this.runtimeVersion,
      });
      if (verifiedPolicy.contentDigest !== selectedPolicy.content_digest) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      this.cache.cacheVerifiedPolicySnapshot(version.id, selectedPolicy);
    } catch (error) {
      reportStageFailure("managed-update-policy", error);
      this.recordManagedUpdateFailure(
        local.agentInstallationId,
        "managed_update_policy_failed",
      );
      throw new AgentInstallationManagerError("update_failed");
    }

    let profilePath: string;
    try {
      profilePath = this.profileBindings.resolveAttachedProfilePath(
        local.runtimeProfileId,
        local.agentInstallationId,
        this.owner,
      );
      this.projection.activateForProfile({ projection, profilePath });
    } catch (error) {
      reportStageFailure("managed-update-activation", error);
      this.recordManagedUpdateFailure(
        local.agentInstallationId,
        "managed_update_activation_failed",
      );
      throw new AgentInstallationManagerError("update_failed");
    }

    try {
      const result = this.database.sqlite
        .prepare(
          `UPDATE local_agent_installations
           SET selected_version_id = ?, selected_release_revision_id = ?,
               policy_snapshot_id = ?, retry_code = NULL, updated_at = ?
           WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ? AND source_scope = 'PLATFORM'
             AND update_policy = 'managed' AND status = 'active'
             AND selected_version_id = ?
             AND selected_release_revision_id = ?
             AND policy_snapshot_id = ?`,
        )
        .run(
          intent.targetVersionId,
          intent.targetReleaseRevisionId,
          selectedPolicy.id,
          timestamp(this.now),
          local.agentInstallationId,
          this.owner.tenantId,
          this.owner.ownerId,
          this.owner.deviceInstallationId,
          local.selectedVersionId,
          intent.expectedSelectedReleaseRevisionId,
          local.policySnapshotId,
        );
      if (Number(result.changes) !== 1) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
    } catch (error) {
      try {
        const previousVersion = this.cache.getVerifiedVersion(
          local.selectedVersionId,
        );
        assertVersion(
          previousVersion,
          local.definitionId,
          local.selectedVersionId,
        );
        this.projection.activateForProfile({
          projection: this.projection.materializeVersion({
            agentInstallationId: local.agentInstallationId,
            version: previousVersion,
          }),
          profilePath,
        });
      } catch (restoreError) {
        reportStageFailure("managed-update-restore", restoreError);
      }
      reportStageFailure("managed-update-commit", error);
      this.recordManagedUpdateFailure(
        local.agentInstallationId,
        "managed_update_activation_failed",
      );
      throw new AgentInstallationManagerError("update_failed");
    }

    local = this.getLocalInstallation(local.agentInstallationId);
    this.completeManagedUpdateIntent(intent.id);
    return local;
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
    let createdFreshProfile: {
      id: string;
      path: string;
      runtimeProfileId: string;
    } | null = null;
    let profileStage: AgentInstallationRetryCode = "profile_creation_failed";
    try {
      if (local.runtimeProfileId !== null && target.kind !== "claim") {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      if (target.kind === "fresh") {
        if (target.modelSourceProfileId) {
          this.profileBindings.verifyProfileBinding(
            this.profiles.resolveProfilePath(target.modelSourceProfileId),
            this.owner,
          );
        }
        const existingReservation =
          this.profileBindings.getFreshProfileReservation(
            local.agentInstallationId,
            this.owner,
          );
        const profileId =
          existingReservation?.profileId ??
          this.profiles.profileIdForAgentName(target.name);
        const created = this.profileBindings.createAndBindFreshProfile({
          operationId: local.agentInstallationId,
          name: target.name,
          owner: this.owner,
          profileId,
          createProfile: this.profiles.createProfile,
          resolveProfilePath: this.profiles.resolveProfilePath,
          activateProfile: this.profiles.activateProfile,
          activate: false,
        });
        profilePath = this.profiles.resolveProfilePath(created.profileId);
        binding = created.binding;
        createdFreshProfile = {
          id: created.profileId,
          path: profilePath,
          runtimeProfileId: binding.runtimeProfileId,
        };
        if (target.modelSourceProfileId) {
          profileStage = "profile_model_configuration_failed";
          if (!this.profiles.configureFreshProfileModel) {
            throw new Error(
              "Fresh Profile model configuration is unavailable.",
            );
          }
          this.profiles.configureFreshProfileModel({
            sourceProfileId: target.modelSourceProfileId,
            targetProfileId: created.profileId,
            version,
            policy,
            ...(target.modelSourceModelId
              ? { sourceModelId: target.modelSourceModelId }
              : {}),
          });
        }
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
    } catch (error) {
      if (createdFreshProfile !== null) {
        let bindingRemoved = false;
        try {
          const currentBinding = this.profileBindings.verifyProfileBinding(
            createdFreshProfile.path,
            this.owner,
          );
          bindingRemoved = this.profileBindings.removeProfileBinding(
            createdFreshProfile.path,
            this.owner,
            {
              runtimeProfileId: currentBinding.runtimeProfileId,
              agentInstallationId: currentBinding.agentInstallationId,
            },
          );
        } catch (cleanupError) {
          reportStageFailure("fresh-profile-binding-cleanup", cleanupError);
        }
        if (bindingRemoved) {
          try {
            const deleted = this.profiles.deleteProfile(createdFreshProfile.id);
            if (!deleted.success) {
              throw new Error(
                deleted.error || "Fresh Profile deletion failed.",
              );
            }
          } catch (cleanupError) {
            reportStageFailure("fresh-profile-delete", cleanupError);
          }
          this.database.sqlite
            .prepare(
              `UPDATE local_agent_installations
               SET runtime_profile_id = NULL, updated_at = ?
               WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
                 AND device_installation_id = ? AND status = 'pending'
                 AND (runtime_profile_id IS NULL OR runtime_profile_id = ?)`,
            )
            .run(
              timestamp(this.now),
              local.agentInstallationId,
              this.owner.tenantId,
              this.owner.ownerId,
              this.owner.deviceInstallationId,
              createdFreshProfile.runtimeProfileId,
            );
        }
      }
      reportStageFailure("profile", error);
      this.recordFailure(local.agentInstallationId, profileStage);
      throw new AgentInstallationManagerError(
        profileStage === "profile_model_configuration_failed"
          ? "profile_model_configuration_failed"
          : "profile_binding_failed",
      );
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
      if (createdFreshProfile !== null) {
        try {
          this.profiles.activateProfile(createdFreshProfile.id);
        } catch (error) {
          reportStageFailure("fresh-profile-activation", error);
        }
      }
    } catch {
      this.recordFailure(local.agentInstallationId, "activation_failed");
      throw new AgentInstallationManagerError("activation_failed");
    }
    return this.getLocalInstallation(local.agentInstallationId);
  }

  private async rollbackVerifiedRestore(input: {
    backupId: string;
    profileId: string | null;
    profilePath: string | null;
    installed: LocalAgentInstallation | null;
    binding: RuntimeOwnerBinding | null;
  }): Promise<void> {
    const installationId =
      input.installed?.agentInstallationId ??
      input.binding?.agentInstallationId ??
      null;
    let archived = installationId === null;
    if (installationId !== null) {
      try {
        const local = this.getLocalInstallation(installationId);
        const cloud = await this.client.archiveInstallation(
          installationId,
          operationKey("restore-archive", installationId, input.backupId),
        );
        assertCloudState(
          cloud,
          local,
          "archived",
          local.selectedVersionId,
          local.runtimeProfileId,
        );
        archived = true;
      } catch (error) {
        reportStageFailure("restore-archive", error);
      }
    }

    if (input.profilePath !== null && input.binding !== null) {
      try {
        this.profileBindings.removeProfileBinding(
          input.profilePath,
          this.owner,
          {
            runtimeProfileId: input.binding.runtimeProfileId,
            agentInstallationId: input.binding.agentInstallationId,
          },
        );
      } catch (error) {
        reportStageFailure("restore-binding-cleanup", error);
      }
    }
    if (input.profileId !== null) {
      try {
        const deleted = this.profiles.deleteProfile(input.profileId);
        if (!deleted.success) {
          throw new Error(deleted?.error ?? "Profile deletion is unavailable.");
        }
      } catch (error) {
        reportStageFailure("restore-profile-cleanup", error);
      }
    }
    if (!archived || installationId === null) return;

    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.database.sqlite
        .prepare(
          `DELETE FROM encrypted_backup_restores
           WHERE tenant_id = ? AND owner_id = ?
             AND device_installation_id = ?
             AND agent_installation_id = ?`,
        )
        .run(
          this.owner.tenantId,
          this.owner.ownerId,
          this.owner.deviceInstallationId,
          installationId,
        );
      this.database.sqlite
        .prepare(
          `DELETE FROM local_agent_installations
           WHERE tenant_id = ? AND owner_id = ?
             AND device_installation_id = ?
             AND agent_installation_id = ?`,
        )
        .run(
          this.owner.tenantId,
          this.owner.ownerId,
          this.owner.deviceInstallationId,
          installationId,
        );
      this.database.sqlite.exec("COMMIT");
    } catch (error) {
      try {
        this.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the cleanup failure.
      }
      reportStageFailure("restore-local-cleanup", error);
    }
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

  private recordManagedUpdateFailure(
    agentInstallationId: string,
    code: Extract<AgentInstallationRetryCode, `managed_update_${string}`>,
  ): void {
    this.database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET retry_code = ?, updated_at = ?
         WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ? AND source_scope = 'PLATFORM'
           AND update_policy = 'managed' AND status = 'active'`,
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

  private clearManagedUpdateFailure(agentInstallationId: string): void {
    this.database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET retry_code = NULL, updated_at = ?
         WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ? AND source_scope = 'PLATFORM'
           AND update_policy = 'managed' AND status = 'active'`,
      )
      .run(
        timestamp(this.now),
        agentInstallationId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      );
  }

  private getManagedUpdateIntent(
    agentInstallationId: string,
  ): ManagedUpdateIntent | null {
    const rows = this.database.sqlite
      .prepare(
        `SELECT id, payload_json
         FROM pending_sanitized_records
         WHERE record_type = 'official_managed_update' AND tenant_id = ?
           AND owner_id = ? AND device_installation_id = ?
         ORDER BY created_at ASC`,
      )
      .all(
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      ) as Array<{ id?: unknown; payload_json?: unknown }>;
    const matches: ManagedUpdateIntent[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.payload_json !== "string") {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      let value: unknown;
      try {
        value = JSON.parse(row.payload_json);
      } catch {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).sort().join("\0") !==
        [
          "agent_installation_id",
          "expected_selected_release_revision_id",
          "idempotency_key",
          "target_release_revision_id",
          "target_version_id",
        ]
          .sort()
          .join("\0")
      ) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      const parsed: ManagedUpdateIntent = {
        id: uuid(row.id),
        installationId: uuid(record.agent_installation_id),
        expectedSelectedReleaseRevisionId: uuid(
          record.expected_selected_release_revision_id,
        ),
        targetReleaseRevisionId: uuid(record.target_release_revision_id),
        targetVersionId: uuid(record.target_version_id),
        idempotencyKey:
          typeof record.idempotency_key === "string"
            ? record.idempotency_key
            : "",
      };
      if (
        parsed.idempotencyKey !==
        operationKey(
          "managed-update",
          parsed.installationId,
          parsed.expectedSelectedReleaseRevisionId,
          parsed.targetReleaseRevisionId,
        )
      ) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      if (parsed.installationId === agentInstallationId) matches.push(parsed);
    }
    if (matches.length > 1) {
      throw new AgentInstallationManagerError("installation_conflict");
    }
    return matches[0] ?? null;
  }

  private beginManagedUpdateIntent(
    input: Omit<ManagedUpdateIntent, "id" | "idempotencyKey">,
  ): ManagedUpdateIntent {
    const id = uuid(this.randomUUID());
    const idempotencyKey = operationKey(
      "managed-update",
      input.installationId,
      input.expectedSelectedReleaseRevisionId,
      input.targetReleaseRevisionId,
    );
    const createdAt = timestamp(this.now);
    this.database.sqlite
      .prepare(
        `INSERT INTO pending_sanitized_records (
           id, tenant_id, owner_id, device_installation_id,
           record_type, payload_json, attempt_count, next_attempt_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'official_managed_update', ?, 0, NULL, ?, ?)`,
      )
      .run(
        id,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
        JSON.stringify({
          agent_installation_id: input.installationId,
          expected_selected_release_revision_id:
            input.expectedSelectedReleaseRevisionId,
          target_release_revision_id: input.targetReleaseRevisionId,
          target_version_id: input.targetVersionId,
          idempotency_key: idempotencyKey,
        }),
        createdAt,
        createdAt,
      );
    return { id, idempotencyKey, ...input };
  }

  private completeManagedUpdateIntent(id: string): void {
    const result = this.database.sqlite
      .prepare(
        `DELETE FROM pending_sanitized_records
         WHERE id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?
           AND record_type = 'official_managed_update'`,
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
