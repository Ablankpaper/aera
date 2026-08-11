import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { AgenteraControlPlaneDatabase } from "./db";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
const RETRY_CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;

export type InstallationOperationPhase =
  | "prepared"
  | "profile_bound"
  | "profile_attached"
  | "projection_active"
  | "cloud_activated"
  | "committed"
  | "repair_required";

export type InstallationOperationTarget =
  | {
      kind: "fresh";
      profileId: string;
      displayName: string;
      modelSourceProfileId?: string;
      modelSourceModelId?: string;
    }
  | { kind: "claim"; profileId: string };

export interface InstallationOperationRecord {
  operationId: string;
  tenantId: string;
  ownerId: string;
  deviceInstallationId: string;
  agentInstallationId: string;
  targetKind: "fresh" | "claim";
  profileId: string;
  displayName: string | null;
  modelSourceProfileId: string | null;
  modelSourceModelId: string | null;
  runtimeProfileId: string | null;
  phase: InstallationOperationPhase;
  retryCode: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface BeginInstallationOperationInput {
  operationId: string;
  agentInstallationId: string;
  target: InstallationOperationTarget;
}

export interface AdvanceInstallationOperationInput {
  operationId: string;
  expectedRevision: number;
  phase:
    | "profile_bound"
    | "profile_attached"
    | "projection_active"
    | "cloud_activated";
  runtimeProfileId: string;
}

export interface InstallationOperationStoreOptions {
  database: AgenteraControlPlaneDatabase;
  owner: AgenteraRuntimeOwner;
  now?: () => Date;
}

export type InstallationOperationStoreErrorCode =
  | "invalid_operation"
  | "operation_conflict"
  | "operation_required"
  | "revision_conflict"
  | "operation_corrupt";

export class InstallationOperationStoreError extends Error {
  readonly code: InstallationOperationStoreErrorCode;

  constructor(code: InstallationOperationStoreErrorCode) {
    super(`Aera Installation operation failed: ${code}.`);
    this.name = "InstallationOperationStoreError";
    this.code = code;
  }
}

interface NormalizedTarget {
  kind: "fresh" | "claim";
  profileId: string;
  displayName: string | null;
  modelSourceProfileId: string | null;
  modelSourceModelId: string | null;
}

interface InstallationOperationRow {
  operation_id?: unknown;
  tenant_id?: unknown;
  owner_id?: unknown;
  device_installation_id?: unknown;
  agent_installation_id?: unknown;
  target_kind?: unknown;
  target_profile_id?: unknown;
  display_name?: unknown;
  model_source_profile_id?: unknown;
  model_source_model_id?: unknown;
  runtime_profile_id?: unknown;
  phase?: unknown;
  retry_code?: unknown;
  revision?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

const ROW_COLUMNS = `
  operation_id, tenant_id, owner_id, device_installation_id,
  agent_installation_id, target_kind, target_profile_id, display_name,
  model_source_profile_id, model_source_model_id, runtime_profile_id,
  phase, retry_code, revision, created_at, updated_at
`;

const NEXT_PHASE: Readonly<
  Record<AdvanceInstallationOperationInput["phase"], InstallationOperationPhase>
> = {
  profile_bound: "prepared",
  profile_attached: "profile_bound",
  projection_active: "profile_attached",
  cloud_activated: "projection_active",
};

function uuid(
  value: unknown,
  code: InstallationOperationStoreErrorCode,
): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new InstallationOperationStoreError(code);
  }
  return value.toLowerCase();
}

function profileId(
  value: unknown,
  code: InstallationOperationStoreErrorCode,
): string {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    throw new InstallationOperationStoreError(code);
  }
  return value;
}

function boundedText(
  value: unknown,
  maximumBytes: number,
  code: InstallationOperationStoreErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\0\r\n]/.test(value)
  ) {
    throw new InstallationOperationStoreError(code);
  }
  return value.trim();
}

function optionalProfileId(
  value: unknown,
  code: InstallationOperationStoreErrorCode,
): string | null {
  return value === undefined || value === null ? null : profileId(value, code);
}

function optionalBoundedText(
  value: unknown,
  maximumBytes: number,
  code: InstallationOperationStoreErrorCode,
): string | null {
  return value === undefined || value === null
    ? null
    : boundedText(value, maximumBytes, code);
}

/**
 * Beta.26 journals persisted only the source Profile and model-library
 * handles. This parser is intentionally internal/recovery-only; new IPC
 * callers must provide a catalog revision and never call this compatibility
 * boundary.
 */
export function parseBeta26PersistedRuntimeModelSelection(
  sourceProfileId: unknown,
  modelLibraryId: unknown,
): { sourceProfileId: string; modelLibraryId: string } {
  const parsedProfileId = optionalProfileId(
    sourceProfileId,
    "operation_corrupt",
  );
  const parsedModelLibraryId = optionalBoundedText(
    modelLibraryId,
    512,
    "operation_corrupt",
  );
  if (parsedProfileId === null || parsedModelLibraryId === null) {
    throw new InstallationOperationStoreError("operation_corrupt");
  }
  return {
    sourceProfileId: parsedProfileId,
    modelLibraryId: parsedModelLibraryId,
  };
}

function timestamp(
  value: unknown,
  code: InstallationOperationStoreErrorCode,
): string {
  if (typeof value !== "string") {
    throw new InstallationOperationStoreError(code);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new InstallationOperationStoreError(code);
  }
  return value;
}

function createTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InstallationOperationStoreError("invalid_operation");
  }
  return value.toISOString();
}

function revision(
  value: unknown,
  code: InstallationOperationStoreErrorCode,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new InstallationOperationStoreError(code);
  }
  return Number(value);
}

function normalizeOwner(owner: AgenteraRuntimeOwner): AgenteraRuntimeOwner {
  return {
    tenantId: uuid(owner?.tenantId, "invalid_operation"),
    ownerId: uuid(owner?.ownerId, "invalid_operation"),
    deviceInstallationId: uuid(
      owner?.deviceInstallationId,
      "invalid_operation",
    ),
  };
}

function normalizeTarget(
  target: InstallationOperationTarget,
): NormalizedTarget {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new InstallationOperationStoreError("invalid_operation");
  }
  if (target.kind === "claim") {
    if (
      Object.keys(target).some((key) => key !== "kind" && key !== "profileId")
    ) {
      throw new InstallationOperationStoreError("invalid_operation");
    }
    return {
      kind: "claim",
      profileId: profileId(target.profileId, "invalid_operation"),
      displayName: null,
      modelSourceProfileId: null,
      modelSourceModelId: null,
    };
  }
  if (target.kind !== "fresh") {
    throw new InstallationOperationStoreError("invalid_operation");
  }
  if (
    Object.keys(target).some(
      (key) =>
        ![
          "kind",
          "profileId",
          "displayName",
          "modelSourceProfileId",
          "modelSourceModelId",
        ].includes(key),
    )
  ) {
    throw new InstallationOperationStoreError("invalid_operation");
  }
  const modelSourceProfileId = optionalProfileId(
    target.modelSourceProfileId,
    "invalid_operation",
  );
  const modelSourceModelId = optionalBoundedText(
    target.modelSourceModelId,
    512,
    "invalid_operation",
  );
  if (modelSourceModelId !== null && modelSourceProfileId === null) {
    throw new InstallationOperationStoreError("invalid_operation");
  }
  return {
    kind: "fresh",
    profileId: profileId(target.profileId, "invalid_operation"),
    displayName: boundedText(target.displayName, 256, "invalid_operation"),
    modelSourceProfileId,
    modelSourceModelId,
  };
}

function phase(
  value: unknown,
  code: InstallationOperationStoreErrorCode,
): InstallationOperationPhase {
  if (
    value !== "prepared" &&
    value !== "profile_bound" &&
    value !== "profile_attached" &&
    value !== "projection_active" &&
    value !== "cloud_activated" &&
    value !== "committed" &&
    value !== "repair_required"
  ) {
    throw new InstallationOperationStoreError(code);
  }
  return value;
}

function parseRow(row: unknown): InstallationOperationRecord {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new InstallationOperationStoreError("operation_corrupt");
  }
  const value = row as InstallationOperationRow;
  const parsedPhase = phase(value.phase, "operation_corrupt");
  const runtimeProfileId =
    value.runtime_profile_id === null
      ? null
      : uuid(value.runtime_profile_id, "operation_corrupt");
  const retryCode =
    value.retry_code === null
      ? null
      : boundedText(value.retry_code, 128, "operation_corrupt");
  const targetKind = value.target_kind;
  const displayName =
    value.display_name === null
      ? null
      : boundedText(value.display_name, 256, "operation_corrupt");
  const hasPersistedModelSelection =
    value.model_source_profile_id !== null &&
    value.model_source_profile_id !== undefined;
  const hasPersistedModelHandle =
    hasPersistedModelSelection ||
    (value.model_source_model_id !== null &&
      value.model_source_model_id !== undefined);
  const parsedPersistedSelection = hasPersistedModelHandle
    ? parseBeta26PersistedRuntimeModelSelection(
        value.model_source_profile_id,
        value.model_source_model_id,
      )
    : null;
  const modelSourceProfileId =
    parsedPersistedSelection?.sourceProfileId ?? null;
  const modelSourceModelId = parsedPersistedSelection?.modelLibraryId ?? null;
  if (
    (targetKind !== "fresh" && targetKind !== "claim") ||
    (targetKind === "fresh" && displayName === null) ||
    (targetKind === "claim" &&
      (displayName !== null ||
        modelSourceProfileId !== null ||
        modelSourceModelId !== null)) ||
    (modelSourceModelId !== null && modelSourceProfileId === null) ||
    (parsedPhase === "prepared" && runtimeProfileId !== null) ||
    (parsedPhase !== "prepared" &&
      parsedPhase !== "repair_required" &&
      runtimeProfileId === null) ||
    (parsedPhase === "repair_required") !== (retryCode !== null) ||
    (retryCode !== null && !RETRY_CODE_PATTERN.test(retryCode))
  ) {
    throw new InstallationOperationStoreError("operation_corrupt");
  }
  return {
    operationId: uuid(value.operation_id, "operation_corrupt"),
    tenantId: uuid(value.tenant_id, "operation_corrupt"),
    ownerId: uuid(value.owner_id, "operation_corrupt"),
    deviceInstallationId: uuid(
      value.device_installation_id,
      "operation_corrupt",
    ),
    agentInstallationId: uuid(value.agent_installation_id, "operation_corrupt"),
    targetKind,
    profileId: profileId(value.target_profile_id, "operation_corrupt"),
    displayName,
    modelSourceProfileId,
    modelSourceModelId,
    runtimeProfileId,
    phase: parsedPhase,
    retryCode,
    revision: revision(value.revision, "operation_corrupt"),
    createdAt: timestamp(value.created_at, "operation_corrupt"),
    updatedAt: timestamp(value.updated_at, "operation_corrupt"),
  };
}

function sameTarget(
  record: InstallationOperationRecord,
  target: NormalizedTarget,
): boolean {
  return (
    record.targetKind === target.kind &&
    record.profileId === target.profileId &&
    record.displayName === target.displayName &&
    record.modelSourceProfileId === target.modelSourceProfileId &&
    record.modelSourceModelId === target.modelSourceModelId
  );
}

export class InstallationOperationStore {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly owner: AgenteraRuntimeOwner;
  private readonly now: () => Date;

  constructor(options: InstallationOperationStoreOptions) {
    this.database = options.database;
    this.owner = normalizeOwner(options.owner);
    this.now = options.now ?? (() => new Date());
  }

  begin(input: BeginInstallationOperationInput): InstallationOperationRecord {
    const operationId = uuid(input?.operationId, "invalid_operation");
    const agentInstallationId = uuid(
      input?.agentInstallationId,
      "invalid_operation",
    );
    const target = normalizeTarget(input?.target);
    const createdAt = createTimestamp(this.now);

    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO installation_operations (
             operation_id, tenant_id, owner_id, device_installation_id,
             agent_installation_id, target_kind, target_profile_id,
             display_name, model_source_profile_id, model_source_model_id,
             runtime_profile_id, phase, retry_code, revision,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
             'prepared', NULL, 1, ?, ?)`,
        )
        .run(
          operationId,
          this.owner.tenantId,
          this.owner.ownerId,
          this.owner.deviceInstallationId,
          agentInstallationId,
          target.kind,
          target.profileId,
          target.displayName,
          target.modelSourceProfileId,
          target.modelSourceModelId,
          createdAt,
          createdAt,
        );
      const existing = this.getOwned(operationId);
      if (
        !existing ||
        existing.agentInstallationId !== agentInstallationId ||
        !sameTarget(existing, target)
      ) {
        throw new InstallationOperationStoreError("operation_conflict");
      }
      this.database.sqlite.exec("COMMIT");
      return existing;
    } catch (error) {
      try {
        this.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the original bounded operation error.
      }
      if (error instanceof InstallationOperationStoreError) throw error;
      throw new InstallationOperationStoreError("operation_conflict");
    }
  }

  get(operationIdInput: string): InstallationOperationRecord | null {
    const operationId = uuid(operationIdInput, "invalid_operation");
    return this.getOwned(operationId);
  }

  listIncomplete(): InstallationOperationRecord[] {
    return this.database.sqlite
      .prepare(
        `SELECT ${ROW_COLUMNS}
         FROM installation_operations
         WHERE tenant_id = ? AND owner_id = ? AND device_installation_id = ?
           AND phase <> 'committed'
         ORDER BY created_at, operation_id`,
      )
      .all(
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      )
      .map(parseRow);
  }

  advance(
    input: AdvanceInstallationOperationInput,
  ): InstallationOperationRecord {
    const operationId = uuid(input?.operationId, "invalid_operation");
    const expectedRevision = revision(
      input?.expectedRevision,
      "invalid_operation",
    );
    const nextPhase = input?.phase;
    if (!Object.hasOwn(NEXT_PHASE, nextPhase)) {
      throw new InstallationOperationStoreError("invalid_operation");
    }
    const runtimeProfileId = uuid(input?.runtimeProfileId, "invalid_operation");
    const current = this.requireOwned(operationId);
    if (
      current.phase === nextPhase &&
      current.runtimeProfileId === runtimeProfileId
    ) {
      throw new InstallationOperationStoreError("revision_conflict");
    }
    if (
      current.phase !== NEXT_PHASE[nextPhase] ||
      (current.runtimeProfileId !== null &&
        current.runtimeProfileId !== runtimeProfileId)
    ) {
      throw new InstallationOperationStoreError("operation_conflict");
    }
    const result = this.database.sqlite
      .prepare(
        `UPDATE installation_operations
         SET phase = ?, runtime_profile_id = ?, retry_code = NULL,
           revision = revision + 1, updated_at = ?
         WHERE operation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ? AND revision = ? AND phase = ?`,
      )
      .run(
        nextPhase,
        runtimeProfileId,
        createTimestamp(this.now),
        operationId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
        expectedRevision,
        current.phase,
      );
    if (Number(result.changes) !== 1) {
      throw new InstallationOperationStoreError("revision_conflict");
    }
    return this.requireOwned(operationId);
  }

  markRepairRequired(input: {
    operationId: string;
    expectedRevision: number;
    retryCode: string;
  }): InstallationOperationRecord {
    const operationId = uuid(input?.operationId, "invalid_operation");
    const expectedRevision = revision(
      input?.expectedRevision,
      "invalid_operation",
    );
    if (
      typeof input?.retryCode !== "string" ||
      !RETRY_CODE_PATTERN.test(input.retryCode)
    ) {
      throw new InstallationOperationStoreError("invalid_operation");
    }
    const current = this.requireOwned(operationId);
    if (current.phase === "committed" || current.phase === "repair_required") {
      throw new InstallationOperationStoreError("operation_conflict");
    }
    const result = this.database.sqlite
      .prepare(
        `UPDATE installation_operations
         SET phase = 'repair_required', retry_code = ?,
           revision = revision + 1, updated_at = ?
         WHERE operation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ? AND revision = ? AND phase = ?`,
      )
      .run(
        input.retryCode,
        createTimestamp(this.now),
        operationId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
        expectedRevision,
        current.phase,
      );
    if (Number(result.changes) !== 1) {
      throw new InstallationOperationStoreError("revision_conflict");
    }
    return this.requireOwned(operationId);
  }

  commit(input: {
    operationId: string;
    expectedRevision: number;
  }): InstallationOperationRecord {
    const operationId = uuid(input?.operationId, "invalid_operation");
    const expectedRevision = revision(
      input?.expectedRevision,
      "invalid_operation",
    );
    const current = this.requireOwned(operationId);
    if (current.phase === "committed") return current;
    if (current.phase !== "cloud_activated") {
      throw new InstallationOperationStoreError("operation_conflict");
    }
    const result = this.database.sqlite
      .prepare(
        `UPDATE installation_operations
         SET phase = 'committed', retry_code = NULL,
           revision = revision + 1, updated_at = ?
         WHERE operation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ? AND revision = ?
           AND phase = 'cloud_activated'`,
      )
      .run(
        createTimestamp(this.now),
        operationId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
        expectedRevision,
      );
    if (Number(result.changes) !== 1) {
      throw new InstallationOperationStoreError("revision_conflict");
    }
    return this.requireOwned(operationId);
  }

  private getOwned(operationId: string): InstallationOperationRecord | null {
    const row = this.database.sqlite
      .prepare(
        `SELECT ${ROW_COLUMNS}
         FROM installation_operations
         WHERE operation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?`,
      )
      .get(
        operationId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      );
    return row === undefined ? null : parseRow(row);
  }

  private requireOwned(operationId: string): InstallationOperationRecord {
    const operation = this.getOwned(operationId);
    if (!operation) {
      throw new InstallationOperationStoreError("operation_required");
    }
    return operation;
  }
}
