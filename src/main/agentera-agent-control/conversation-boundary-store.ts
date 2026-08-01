import { randomUUID as nodeRandomUUID } from "node:crypto";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { AgentAssetContext, AgenteraControlPlaneDatabase } from "./db";
import type { LocalRuntimeBinding } from "./runtime-binding-store";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type ConversationBoundaryScope = "USER" | "WORKSPACE" | "ORGANIZATION";
export type ConversationBoundaryVisibility =
  "PRIVATE" | "WORKSPACE_SHARED" | "ORGANIZATION_SHARED" | "ARTIFACT_ONLY";
export type ConversationBoundaryOrigin = "NEW_CONVERSATION" | "LEGACY_DEFAULT";

export interface ConversationBoundary {
  id: string;
  tenantId: string;
  actorUserId: string;
  deviceInstallationId: string;
  conversationKey: string;
  hermesSessionId: string | null;
  scopeType: ConversationBoundaryScope;
  scopeId: string;
  visibility: ConversationBoundaryVisibility;
  memoryScope: "ACTOR_PRIVATE";
  filesScope: "CONVERSATION_PRIVATE";
  artifactScope: "CONVERSATION_PRIVATE";
  agentRunScope: "CONVERSATION_BOUNDARY";
  runtimeBindingId: string | null;
  agentInstallationId: string | null;
  agentDefinitionId: string | null;
  agentVersionId: string | null;
  runtimeProfileId: string | null;
  runtimeVersion: string | null;
  policySnapshotId: string | null;
  officialReleaseRevisionId: string | null;
  toolPermissionSnapshot:
    { kind: "PROFILE_DEFAULT" } | { kind: "AGENT_DIGEST"; digest: string };
  origin: ConversationBoundaryOrigin;
  createdAt: string;
}

export interface PrepareConversationBoundaryInput {
  conversationKey: string;
  resumeSessionId: string | null;
  context: AgentAssetContext;
  runtimeBinding: LocalRuntimeBinding | null;
}

export type ConversationBoundaryStoreErrorCode =
  | "invalid_boundary"
  | "boundary_conflict"
  | "boundary_required"
  | "boundary_corrupt";

export class ConversationBoundaryStoreError extends Error {
  readonly code: ConversationBoundaryStoreErrorCode;

  constructor(code: ConversationBoundaryStoreErrorCode) {
    super(`Aera conversation boundary failed: ${code}.`);
    this.name = "ConversationBoundaryStoreError";
    this.code = code;
  }
}

export interface ConversationBoundaryStoreOptions {
  database: AgenteraControlPlaneDatabase;
  owner: AgenteraRuntimeOwner;
  now?: () => Date;
  randomUUID?: () => string;
}

interface BoundaryRow {
  id?: unknown;
  tenant_id?: unknown;
  actor_user_id?: unknown;
  device_installation_id?: unknown;
  conversation_key?: unknown;
  hermes_session_id?: unknown;
  scope_type?: unknown;
  scope_id?: unknown;
  visibility?: unknown;
  memory_scope?: unknown;
  files_scope?: unknown;
  artifact_scope?: unknown;
  agent_run_scope?: unknown;
  runtime_binding_id?: unknown;
  agent_installation_id?: unknown;
  agent_definition_id?: unknown;
  agent_version_id?: unknown;
  runtime_profile_id?: unknown;
  runtime_version?: unknown;
  policy_snapshot_id?: unknown;
  official_release_revision_id?: unknown;
  tool_permission_snapshot_kind?: unknown;
  tool_permission_digest?: unknown;
  origin?: unknown;
  created_at?: unknown;
}

const SELECT_BOUNDARY = `
  SELECT id, tenant_id, actor_user_id, device_installation_id,
         conversation_key, hermes_session_id, scope_type, scope_id,
         visibility, memory_scope, files_scope, artifact_scope,
         agent_run_scope, runtime_binding_id, agent_installation_id,
         agent_definition_id, agent_version_id, runtime_profile_id,
         runtime_version, policy_snapshot_id, official_release_revision_id,
         tool_permission_snapshot_kind, tool_permission_digest, origin,
         created_at
  FROM conversation_boundaries
`;

function uuid(
  value: unknown,
  code: ConversationBoundaryStoreErrorCode,
): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ConversationBoundaryStoreError(code);
  }
  return value.toLowerCase();
}

function nullableUuid(
  value: unknown,
  code: ConversationBoundaryStoreErrorCode,
): string | null {
  return value === null ? null : uuid(value, code);
}

function digest(
  value: unknown,
  code: ConversationBoundaryStoreErrorCode,
): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new ConversationBoundaryStoreError(code);
  }
  return value;
}

function boundedText(
  value: unknown,
  maximum: number,
  code: ConversationBoundaryStoreErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\0\r\n]/.test(value)
  ) {
    throw new ConversationBoundaryStoreError(code);
  }
  return value;
}

function nullableBoundedText(
  value: unknown,
  maximum: number,
  code: ConversationBoundaryStoreErrorCode,
): string | null {
  return value === null ? null : boundedText(value, maximum, code);
}

function timestamp(
  value: unknown,
  code: ConversationBoundaryStoreErrorCode,
): string {
  if (typeof value !== "string") {
    throw new ConversationBoundaryStoreError(code);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ConversationBoundaryStoreError(code);
  }
  return value;
}

function createTimestamp(
  now: () => Date,
  code: ConversationBoundaryStoreErrorCode,
): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ConversationBoundaryStoreError(code);
  }
  return value.toISOString();
}

function scopeFromContext(
  context: AgentAssetContext,
  personalSpaceId: string,
): { scopeType: ConversationBoundaryScope; scopeId: string } {
  switch (context.scope) {
    case "USER":
      return { scopeType: "USER", scopeId: personalSpaceId };
    case "WORKSPACE":
      return {
        scopeType: "WORKSPACE",
        scopeId: uuid(context.workspaceId, "invalid_boundary"),
      };
    case "ORGANIZATION":
      return {
        scopeType: "ORGANIZATION",
        scopeId: uuid(context.organizationId, "invalid_boundary"),
      };
    default:
      throw new ConversationBoundaryStoreError("invalid_boundary");
  }
}

function parseRow(row: BoundaryRow | undefined): ConversationBoundary | null {
  if (!row) return null;
  const scopeType = row.scope_type;
  if (
    scopeType !== "USER" &&
    scopeType !== "WORKSPACE" &&
    scopeType !== "ORGANIZATION"
  ) {
    throw new ConversationBoundaryStoreError("boundary_corrupt");
  }
  const visibility = row.visibility;
  if (
    visibility !== "PRIVATE" &&
    visibility !== "WORKSPACE_SHARED" &&
    visibility !== "ORGANIZATION_SHARED" &&
    visibility !== "ARTIFACT_ONLY"
  ) {
    throw new ConversationBoundaryStoreError("boundary_corrupt");
  }
  if (
    row.memory_scope !== "ACTOR_PRIVATE" ||
    row.files_scope !== "CONVERSATION_PRIVATE" ||
    row.artifact_scope !== "CONVERSATION_PRIVATE" ||
    row.agent_run_scope !== "CONVERSATION_BOUNDARY"
  ) {
    throw new ConversationBoundaryStoreError("boundary_corrupt");
  }
  if (row.origin !== "NEW_CONVERSATION" && row.origin !== "LEGACY_DEFAULT") {
    throw new ConversationBoundaryStoreError("boundary_corrupt");
  }

  const tenantId = uuid(row.tenant_id, "boundary_corrupt");
  const scopeId = uuid(row.scope_id, "boundary_corrupt");
  if (scopeType === "USER" && scopeId !== tenantId) {
    throw new ConversationBoundaryStoreError("boundary_corrupt");
  }

  const runtimeBindingId = nullableUuid(
    row.runtime_binding_id,
    "boundary_corrupt",
  );
  const agentInstallationId = nullableUuid(
    row.agent_installation_id,
    "boundary_corrupt",
  );
  const agentDefinitionId = nullableUuid(
    row.agent_definition_id,
    "boundary_corrupt",
  );
  const agentVersionId = nullableUuid(row.agent_version_id, "boundary_corrupt");
  const runtimeProfileId = nullableUuid(
    row.runtime_profile_id,
    "boundary_corrupt",
  );
  const runtimeVersion = nullableBoundedText(
    row.runtime_version,
    128,
    "boundary_corrupt",
  );
  const policySnapshotId = nullableUuid(
    row.policy_snapshot_id,
    "boundary_corrupt",
  );
  const officialReleaseRevisionId = nullableUuid(
    row.official_release_revision_id,
    "boundary_corrupt",
  );

  const agentValues = [
    runtimeBindingId,
    agentInstallationId,
    agentDefinitionId,
    agentVersionId,
    runtimeProfileId,
    runtimeVersion,
    policySnapshotId,
  ];
  const hasAgentSnapshot = agentValues.every((value) => value !== null);
  const hasNoAgentSnapshot =
    agentValues.every((value) => value === null) &&
    officialReleaseRevisionId === null;
  let toolPermissionSnapshot: ConversationBoundary["toolPermissionSnapshot"];
  if (
    hasNoAgentSnapshot &&
    row.tool_permission_snapshot_kind === "PROFILE_DEFAULT" &&
    row.tool_permission_digest === null
  ) {
    toolPermissionSnapshot = { kind: "PROFILE_DEFAULT" };
  } else if (
    hasAgentSnapshot &&
    row.tool_permission_snapshot_kind === "AGENT_DIGEST"
  ) {
    toolPermissionSnapshot = {
      kind: "AGENT_DIGEST",
      digest: digest(row.tool_permission_digest, "boundary_corrupt"),
    };
  } else {
    throw new ConversationBoundaryStoreError("boundary_corrupt");
  }

  return {
    id: uuid(row.id, "boundary_corrupt"),
    tenantId,
    actorUserId: uuid(row.actor_user_id, "boundary_corrupt"),
    deviceInstallationId: uuid(row.device_installation_id, "boundary_corrupt"),
    conversationKey: boundedText(row.conversation_key, 256, "boundary_corrupt"),
    hermesSessionId:
      row.hermes_session_id === null
        ? null
        : boundedText(row.hermes_session_id, 512, "boundary_corrupt"),
    scopeType,
    scopeId,
    visibility,
    memoryScope: "ACTOR_PRIVATE",
    filesScope: "CONVERSATION_PRIVATE",
    artifactScope: "CONVERSATION_PRIVATE",
    agentRunScope: "CONVERSATION_BOUNDARY",
    runtimeBindingId,
    agentInstallationId,
    agentDefinitionId,
    agentVersionId,
    runtimeProfileId,
    runtimeVersion,
    policySnapshotId,
    officialReleaseRevisionId,
    toolPermissionSnapshot,
    origin: row.origin,
    createdAt: timestamp(row.created_at, "boundary_corrupt"),
  };
}

function runtimeSnapshotOf(
  binding: LocalRuntimeBinding | null,
): Pick<
  ConversationBoundary,
  | "runtimeBindingId"
  | "agentInstallationId"
  | "agentDefinitionId"
  | "agentVersionId"
  | "runtimeProfileId"
  | "runtimeVersion"
  | "policySnapshotId"
  | "officialReleaseRevisionId"
  | "toolPermissionSnapshot"
> {
  if (binding === null) {
    return {
      runtimeBindingId: null,
      agentInstallationId: null,
      agentDefinitionId: null,
      agentVersionId: null,
      runtimeProfileId: null,
      runtimeVersion: null,
      policySnapshotId: null,
      officialReleaseRevisionId: null,
      toolPermissionSnapshot: { kind: "PROFILE_DEFAULT" },
    };
  }
  return {
    runtimeBindingId: uuid(binding.id, "invalid_boundary"),
    agentInstallationId: uuid(binding.agentInstallationId, "invalid_boundary"),
    agentDefinitionId: uuid(binding.agentDefinitionId, "invalid_boundary"),
    agentVersionId: uuid(binding.agentVersionId, "invalid_boundary"),
    runtimeProfileId: uuid(binding.runtimeProfileId, "invalid_boundary"),
    runtimeVersion: boundedText(
      binding.runtimeVersion,
      128,
      "invalid_boundary",
    ),
    policySnapshotId: uuid(binding.policySnapshotId, "invalid_boundary"),
    officialReleaseRevisionId:
      binding.officialReleaseRevisionId === null
        ? null
        : uuid(binding.officialReleaseRevisionId, "invalid_boundary"),
    toolPermissionSnapshot: {
      kind: "AGENT_DIGEST",
      digest: digest(binding.toolPermissionDigest, "invalid_boundary"),
    },
  };
}

function sameRuntimeSnapshot(
  boundary: ConversationBoundary,
  binding: LocalRuntimeBinding | null,
): boolean {
  return sameRuntimeSnapshotValue(boundary, runtimeSnapshotOf(binding));
}

function sameRuntimeSnapshotValue(
  boundary: ConversationBoundary,
  expected: ReturnType<typeof runtimeSnapshotOf>,
): boolean {
  return (
    boundary.runtimeBindingId === expected.runtimeBindingId &&
    boundary.agentInstallationId === expected.agentInstallationId &&
    boundary.agentDefinitionId === expected.agentDefinitionId &&
    boundary.agentVersionId === expected.agentVersionId &&
    boundary.runtimeProfileId === expected.runtimeProfileId &&
    boundary.runtimeVersion === expected.runtimeVersion &&
    boundary.policySnapshotId === expected.policySnapshotId &&
    boundary.officialReleaseRevisionId === expected.officialReleaseRevisionId &&
    JSON.stringify(boundary.toolPermissionSnapshot) ===
      JSON.stringify(expected.toolPermissionSnapshot)
  );
}

export class ConversationBoundaryStore {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly tenantId: string;
  private readonly actorUserId: string;
  private readonly deviceInstallationId: string;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(options: ConversationBoundaryStoreOptions) {
    this.database = options.database;
    this.tenantId = uuid(options.owner.tenantId, "invalid_boundary");
    this.actorUserId = uuid(options.owner.ownerId, "invalid_boundary");
    this.deviceInstallationId = uuid(
      options.owner.deviceInstallationId,
      "invalid_boundary",
    );
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  getByConversationKey(
    conversationKeyValue: string,
  ): ConversationBoundary | null {
    const conversationKey = boundedText(
      conversationKeyValue,
      256,
      "invalid_boundary",
    );
    return parseRow(
      this.database.sqlite
        .prepare(
          `${SELECT_BOUNDARY}
           WHERE tenant_id = ? AND actor_user_id = ?
             AND device_installation_id = ? AND conversation_key = ?`,
        )
        .get(
          this.tenantId,
          this.actorUserId,
          this.deviceInstallationId,
          conversationKey,
        ) as BoundaryRow | undefined,
    );
  }

  getByHermesSessionId(sessionIdValue: string): ConversationBoundary | null {
    const sessionId = boundedText(sessionIdValue, 512, "invalid_boundary");
    return parseRow(
      this.database.sqlite
        .prepare(
          `${SELECT_BOUNDARY}
           WHERE tenant_id = ? AND actor_user_id = ?
             AND device_installation_id = ? AND hermes_session_id = ?`,
        )
        .get(
          this.tenantId,
          this.actorUserId,
          this.deviceInstallationId,
          sessionId,
        ) as BoundaryRow | undefined,
    );
  }

  getById(boundaryIdValue: string): ConversationBoundary | null {
    const boundaryId = uuid(boundaryIdValue, "invalid_boundary");
    return parseRow(
      this.database.sqlite
        .prepare(
          `${SELECT_BOUNDARY}
           WHERE tenant_id = ? AND actor_user_id = ?
             AND device_installation_id = ? AND id = ?`,
        )
        .get(
          this.tenantId,
          this.actorUserId,
          this.deviceInstallationId,
          boundaryId,
        ) as BoundaryRow | undefined,
    );
  }

  prepare(input: PrepareConversationBoundaryInput): ConversationBoundary {
    const conversationKey = boundedText(
      input.conversationKey,
      256,
      "invalid_boundary",
    );
    const resumeSessionId =
      input.resumeSessionId === null
        ? null
        : boundedText(input.resumeSessionId, 512, "invalid_boundary");
    const runtimeSnapshot = runtimeSnapshotOf(input.runtimeBinding);
    if (
      input.runtimeBinding !== null &&
      (uuid(input.runtimeBinding.tenantId, "invalid_boundary") !==
        this.tenantId ||
        uuid(input.runtimeBinding.ownerId, "invalid_boundary") !==
          this.actorUserId ||
        uuid(input.runtimeBinding.deviceId, "invalid_boundary") !==
          this.deviceInstallationId)
    ) {
      throw new ConversationBoundaryStoreError("boundary_conflict");
    }

    const byConversation = this.getByConversationKey(conversationKey);
    if (resumeSessionId !== null) {
      const bySession = this.getByHermesSessionId(resumeSessionId);
      if (bySession) {
        if (byConversation && byConversation.id !== bySession.id) {
          throw new ConversationBoundaryStoreError("boundary_conflict");
        }
        if (!sameRuntimeSnapshot(bySession, input.runtimeBinding)) {
          throw new ConversationBoundaryStoreError("boundary_conflict");
        }
        return bySession;
      }
      if (byConversation) {
        if (!sameRuntimeSnapshot(byConversation, input.runtimeBinding)) {
          throw new ConversationBoundaryStoreError("boundary_conflict");
        }
        return this.attachHermesSession(byConversation.id, resumeSessionId);
      }
      return this.create({
        conversationKey,
        hermesSessionId: resumeSessionId,
        scopeType: "USER",
        scopeId: this.tenantId,
        origin: "LEGACY_DEFAULT",
        runtimeSnapshot,
      });
    }

    if (byConversation) {
      if (!sameRuntimeSnapshot(byConversation, input.runtimeBinding)) {
        throw new ConversationBoundaryStoreError("boundary_conflict");
      }
      return byConversation;
    }
    const scope = scopeFromContext(input.context, this.tenantId);
    return this.create({
      conversationKey,
      hermesSessionId: null,
      ...scope,
      origin: "NEW_CONVERSATION",
      runtimeSnapshot,
    });
  }

  attachHermesSession(
    boundaryIdValue: string,
    sessionIdValue: string,
  ): ConversationBoundary {
    const boundaryId = uuid(boundaryIdValue, "invalid_boundary");
    const sessionId = boundedText(sessionIdValue, 512, "invalid_boundary");
    const current = this.getById(boundaryId);
    if (!current) {
      throw new ConversationBoundaryStoreError("boundary_required");
    }
    if (current.hermesSessionId === sessionId) return current;
    if (current.hermesSessionId !== null) {
      throw new ConversationBoundaryStoreError("boundary_conflict");
    }
    const occupied = this.getByHermesSessionId(sessionId);
    if (occupied && occupied.id !== boundaryId) {
      throw new ConversationBoundaryStoreError("boundary_conflict");
    }
    let result;
    try {
      result = this.database.sqlite
        .prepare(
          `UPDATE conversation_boundaries
           SET hermes_session_id = ?
           WHERE id = ? AND tenant_id = ? AND actor_user_id = ?
             AND device_installation_id = ? AND hermes_session_id IS NULL`,
        )
        .run(
          sessionId,
          boundaryId,
          this.tenantId,
          this.actorUserId,
          this.deviceInstallationId,
        );
    } catch {
      throw new ConversationBoundaryStoreError("boundary_conflict");
    }
    if (Number(result.changes) !== 1) {
      const raced = this.getById(boundaryId);
      if (raced?.hermesSessionId === sessionId) return raced;
      throw new ConversationBoundaryStoreError("boundary_conflict");
    }
    return (
      this.getById(boundaryId) ?? {
        ...current,
        hermesSessionId: sessionId,
      }
    );
  }

  deleteForHermesSessions(sessionIdValues: readonly string[]): number {
    const unique = Array.from(
      new Set(
        sessionIdValues.map((value) =>
          boundedText(value, 512, "invalid_boundary"),
        ),
      ),
    );
    if (unique.length === 0) return 0;
    const remove = this.database.sqlite.prepare(
      `DELETE FROM conversation_boundaries
       WHERE tenant_id = ? AND actor_user_id = ?
         AND device_installation_id = ? AND hermes_session_id = ?`,
    );
    let deleted = 0;
    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const sessionId of unique) {
        deleted += Number(
          remove.run(
            this.tenantId,
            this.actorUserId,
            this.deviceInstallationId,
            sessionId,
          ).changes,
        );
      }
      this.database.sqlite.exec("COMMIT");
    } catch (error) {
      try {
        this.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the primary SQLite failure.
      }
      throw error;
    }
    return deleted;
  }

  private create(input: {
    conversationKey: string;
    hermesSessionId: string | null;
    scopeType: ConversationBoundaryScope;
    scopeId: string;
    origin: ConversationBoundaryOrigin;
    runtimeSnapshot: ReturnType<typeof runtimeSnapshotOf>;
  }): ConversationBoundary {
    const createdAt = createTimestamp(this.now, "invalid_boundary");
    const boundary: ConversationBoundary = {
      id: uuid(this.randomUUID(), "invalid_boundary"),
      tenantId: this.tenantId,
      actorUserId: this.actorUserId,
      deviceInstallationId: this.deviceInstallationId,
      conversationKey: input.conversationKey,
      hermesSessionId: input.hermesSessionId,
      scopeType: input.scopeType,
      scopeId: uuid(input.scopeId, "invalid_boundary"),
      visibility: "PRIVATE",
      memoryScope: "ACTOR_PRIVATE",
      filesScope: "CONVERSATION_PRIVATE",
      artifactScope: "CONVERSATION_PRIVATE",
      agentRunScope: "CONVERSATION_BOUNDARY",
      ...input.runtimeSnapshot,
      origin: input.origin,
      createdAt,
    };
    const toolKind = boundary.toolPermissionSnapshot.kind;
    const toolDigest =
      boundary.toolPermissionSnapshot.kind === "AGENT_DIGEST"
        ? boundary.toolPermissionSnapshot.digest
        : null;
    try {
      this.database.sqlite
        .prepare(
          `INSERT INTO conversation_boundaries (
             id, tenant_id, actor_user_id, device_installation_id,
             conversation_key, hermes_session_id, scope_type, scope_id,
             visibility, memory_scope, files_scope, artifact_scope,
             agent_run_scope, runtime_binding_id, agent_installation_id,
             agent_definition_id, agent_version_id, runtime_profile_id,
             runtime_version, policy_snapshot_id, official_release_revision_id,
             tool_permission_snapshot_kind, tool_permission_digest, origin,
             created_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?
           )`,
        )
        .run(
          boundary.id,
          boundary.tenantId,
          boundary.actorUserId,
          boundary.deviceInstallationId,
          boundary.conversationKey,
          boundary.hermesSessionId,
          boundary.scopeType,
          boundary.scopeId,
          boundary.visibility,
          boundary.memoryScope,
          boundary.filesScope,
          boundary.artifactScope,
          boundary.agentRunScope,
          boundary.runtimeBindingId,
          boundary.agentInstallationId,
          boundary.agentDefinitionId,
          boundary.agentVersionId,
          boundary.runtimeProfileId,
          boundary.runtimeVersion,
          boundary.policySnapshotId,
          boundary.officialReleaseRevisionId,
          toolKind,
          toolDigest,
          boundary.origin,
          boundary.createdAt,
        );
    } catch {
      const raced =
        (boundary.hermesSessionId
          ? this.getByHermesSessionId(boundary.hermesSessionId)
          : null) ?? this.getByConversationKey(boundary.conversationKey);
      if (
        raced &&
        raced.scopeType === boundary.scopeType &&
        raced.scopeId === boundary.scopeId &&
        raced.origin === boundary.origin &&
        sameRuntimeSnapshotValue(raced, input.runtimeSnapshot)
      ) {
        return raced;
      }
      throw new ConversationBoundaryStoreError("boundary_conflict");
    }
    return parseRow({
      id: boundary.id,
      tenant_id: boundary.tenantId,
      actor_user_id: boundary.actorUserId,
      device_installation_id: boundary.deviceInstallationId,
      conversation_key: boundary.conversationKey,
      hermes_session_id: boundary.hermesSessionId,
      scope_type: boundary.scopeType,
      scope_id: boundary.scopeId,
      visibility: boundary.visibility,
      memory_scope: boundary.memoryScope,
      files_scope: boundary.filesScope,
      artifact_scope: boundary.artifactScope,
      agent_run_scope: boundary.agentRunScope,
      runtime_binding_id: boundary.runtimeBindingId,
      agent_installation_id: boundary.agentInstallationId,
      agent_definition_id: boundary.agentDefinitionId,
      agent_version_id: boundary.agentVersionId,
      runtime_profile_id: boundary.runtimeProfileId,
      runtime_version: boundary.runtimeVersion,
      policy_snapshot_id: boundary.policySnapshotId,
      official_release_revision_id: boundary.officialReleaseRevisionId,
      tool_permission_snapshot_kind: toolKind,
      tool_permission_digest: toolDigest,
      origin: boundary.origin,
      created_at: boundary.createdAt,
    }) as ConversationBoundary;
  }
}
