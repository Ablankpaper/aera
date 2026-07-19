import { randomUUID as nodeRandomUUID } from "node:crypto";
import type {
  AgentInstallation,
  AgentInstallationCreation,
  AgentPolicySnapshot,
  AgentVersion,
  CreateAgentInstallationRequest,
} from "./client";
import type { AgenteraControlPlaneDatabase } from "./db";
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

export interface LocalAgentInstallation {
  agentInstallationId: string;
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

function parseLocalRow(row: LocalInstallationRow): LocalAgentInstallation {
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

function assertPendingCreation(
  creation: AgentInstallationCreation,
  definitionId: string,
  versionId: string,
  expectedOrigin: string,
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
    policy.issuer !== expectedOrigin
  ) {
    throw new AgentInstallationManagerError("installation_conflict");
  }
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
): void {
  if (
    uuid(policy.installation_id) !== installationId ||
    uuid(policy.agent_version_id) !== uuid(version.id) ||
    policy.issuer !== expectedOrigin ||
    uuid(policy.document.agent_definition_id) !== definitionId ||
    uuid(policy.document.agent_version_id) !== uuid(version.id) ||
    policy.document.version_digest !== version.content_digest ||
    !DIGEST_PATTERN.test(policy.content_digest)
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
    uuid(options.owner.tenantId);
    uuid(options.owner.ownerId);
    uuid(options.owner.deviceInstallationId);
    this.database = options.database;
    this.client = options.client;
    this.trust = options.trust;
    this.cache = options.cache;
    this.projection = options.projection;
    this.profileBindings = options.profileBindings;
    this.profiles = options.profiles;
    this.owner = { ...options.owner };
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
        "SELECT * FROM local_agent_installations WHERE agent_installation_id = ?",
      )
      .get(agentInstallationId) as LocalInstallationRow | undefined;
    if (!row) {
      throw new AgentInstallationManagerError("installation_not_found");
    }
    return parseLocalRow(row);
  }

  listLocalInstallations(): LocalAgentInstallation[] {
    const rows = this.database.sqlite
      .prepare(
        `SELECT * FROM local_agent_installations
         ORDER BY created_at DESC, agent_installation_id ASC`,
      )
      .all() as LocalInstallationRow[];
    return rows.map(parseLocalRow);
  }

  async install(input: {
    definitionId: string;
    versionId: string;
    profile: AgentInstallationProfileTarget;
  }): Promise<LocalAgentInstallation> {
    const definitionId = uuid(input.definitionId);
    const versionId = uuid(input.versionId);
    const intent = this.beginCreationIntent(definitionId, versionId);
    let creation: AgentInstallationCreation;
    try {
      creation = await this.client.createInstallation(
        { definition_id: definitionId, version_id: versionId },
        intent.idempotencyKey,
      );
      assertPendingCreation(
        creation,
        definitionId,
        versionId,
        this.client.origin,
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
          "SELECT * FROM local_agent_installations WHERE agent_installation_id = ?",
        )
        .get(installationId) as LocalInstallationRow | undefined;
      if (existing) {
        const parsed = parseLocalRow(existing);
        if (
          parsed.definitionId !== definitionId ||
          parsed.selectedVersionId !== versionId ||
          parsed.policySnapshotId !== policyId ||
          parsed.status !== "pending"
        ) {
          throw new AgentInstallationManagerError("installation_conflict");
        }
      } else {
        this.database.sqlite
          .prepare(
            `INSERT INTO local_agent_installations (
             agent_installation_id, definition_id, selected_version_id,
             runtime_profile_id, policy_snapshot_id, status, retry_code,
             created_at, updated_at
           ) VALUES (?, ?, ?, NULL, ?, 'pending', NULL, ?, ?)`,
          )
          .run(
            installationId,
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
         WHERE agent_installation_id = ? AND status = 'active'`,
      )
      .run(
        versionId,
        selected.policy_snapshot_id ?? local.policySnapshotId,
        timestamp(this.now),
        local.agentInstallationId,
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
         WHERE agent_installation_id = ?`,
      )
      .run(timestamp(this.now), local.agentInstallationId);
    return this.getLocalInstallation(local.agentInstallationId);
  }

  private async materializeAndActivate(
    local: LocalAgentInstallation,
    target: AgentInstallationProfileTarget,
    policy: AgentPolicySnapshot,
  ): Promise<LocalAgentInstallation> {
    let version: AgentVersion;
    let projection: HermesVersionProjection;
    try {
      const downloaded = await this.client.getVersion(local.selectedVersionId);
      assertVersion(downloaded, local.definitionId, local.selectedVersionId);
      version = this.cache.cacheVerifiedVersion(downloaded);
      assertVersion(version, local.definitionId, local.selectedVersionId);
      assertPolicy(
        policy,
        local.agentInstallationId,
        local.definitionId,
        version,
        this.client.origin,
      );
      const verifiedPolicy = this.trust.verifyPolicy(policy, {
        runtimeVersion: this.runtimeVersion,
      });
      if (verifiedPolicy.contentDigest !== policy.content_digest) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      this.cache.cacheVerifiedPolicySnapshot(version.id, policy);
      projection = this.projection.materializeVersion({
        agentInstallationId: local.agentInstallationId,
        version,
      });
    } catch {
      this.recordFailure(local.agentInstallationId, "materialization_failed");
      throw new AgentInstallationManagerError("materialization_failed");
    }

    let profilePath: string;
    let binding: RuntimeOwnerBinding;
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
      this.database.sqlite
        .prepare(
          `UPDATE local_agent_installations
           SET runtime_profile_id = ?, updated_at = ?
           WHERE agent_installation_id = ? AND status = 'pending'`,
        )
        .run(
          binding.runtimeProfileId,
          timestamp(this.now),
          local.agentInstallationId,
        );
      binding = this.profileBindings.attachAgentInstallation(
        profilePath,
        this.owner,
        local.agentInstallationId,
      );
      this.projection.activateForProfile({ projection, profilePath });
    } catch {
      this.recordFailure(local.agentInstallationId, "profile_binding_failed");
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
           WHERE agent_installation_id = ? AND status = 'pending'`,
        )
        .run(
          binding.runtimeProfileId,
          activated.policy_snapshot_id,
          timestamp(this.now),
          local.agentInstallationId,
        );
    } catch {
      this.recordFailure(local.agentInstallationId, "activation_failed");
      throw new AgentInstallationManagerError("activation_failed");
    }
    return this.getLocalInstallation(local.agentInstallationId);
  }

  private recordFailure(
    agentInstallationId: string,
    code: AgentInstallationManagerErrorCode,
  ): void {
    this.database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET retry_code = ?, updated_at = ?
         WHERE agent_installation_id = ? AND status = 'pending'`,
      )
      .run(code, timestamp(this.now), agentInstallationId);
  }

  private beginCreationIntent(
    definitionId: string,
    versionId: string,
  ): InstallationCreationIntent {
    const rows = this.database.sqlite
      .prepare(
        `SELECT id, payload_json
         FROM pending_sanitized_records
         WHERE record_type = 'agent_installation_create'
         ORDER BY created_at ASC`,
      )
      .all() as Array<{ id?: unknown; payload_json?: unknown }>;
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
      if (
        Object.keys(record).sort().join("\0") !==
          ["definition_id", "idempotency_key", "version_id"]
            .sort()
            .join("\0") ||
        uuid(row.id) !== uuid(record.idempotency_key)
      ) {
        throw new AgentInstallationManagerError("installation_conflict");
      }
      if (
        uuid(record.definition_id) === definitionId &&
        uuid(record.version_id) === versionId
      ) {
        matches.push({
          id: row.id,
          definitionId,
          versionId,
          idempotencyKey: row.id,
        });
      }
    }
    if (matches.length > 1) {
      throw new AgentInstallationManagerError("installation_conflict");
    }
    if (matches.length === 1) return matches[0];

    const id = uuid(this.randomUUID());
    const createdAt = timestamp(this.now);
    const payload = JSON.stringify({
      definition_id: definitionId,
      version_id: versionId,
      idempotency_key: id,
    });
    this.database.sqlite
      .prepare(
        `INSERT INTO pending_sanitized_records (
           id, record_type, payload_json, attempt_count, next_attempt_at,
           created_at, updated_at
         ) VALUES (?, 'agent_installation_create', ?, 0, NULL, ?, ?)`,
      )
      .run(id, payload, createdAt, createdAt);
    return {
      id,
      definitionId,
      versionId,
      idempotencyKey: id,
    };
  }

  private completeCreationIntent(id: string): void {
    const result = this.database.sqlite
      .prepare(
        `DELETE FROM pending_sanitized_records
         WHERE id = ? AND record_type = 'agent_installation_create'`,
      )
      .run(id);
    if (Number(result.changes) !== 1) {
      throw new AgentInstallationManagerError("installation_conflict");
    }
  }
}
