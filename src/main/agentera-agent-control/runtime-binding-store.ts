import { randomUUID as nodeRandomUUID } from "node:crypto";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { SessionModelOverride } from "../../shared/model-override";
import type { CreateRuntimeBindingRecordRequest } from "./client";
import type { AgenteraControlPlaneDatabase } from "./db";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BINDING_FIELDS = [
  "id",
  "conversationKey",
  "hermesSessionId",
  "tenantId",
  "ownerScope",
  "ownerId",
  "deviceId",
  "agentDefinitionId",
  "agentVersionId",
  "agentInstallationId",
  "runtimeProfileId",
  "runtimeVersion",
  "modelRoute",
  "policySnapshotId",
  "officialReleaseRevisionId",
  "toolPermissionDigest",
  "publishedBaseDigest",
  "localAdaptiveStateRevision",
  "createdAt",
] as const;
const LEGACY_BINDING_FIELDS = BINDING_FIELDS.filter(
  (field) => field !== "officialReleaseRevisionId",
);
const PRE_MODEL_BINDING_FIELDS = BINDING_FIELDS.filter(
  (field) => field !== "modelRoute",
);
const PRE_MODEL_LEGACY_BINDING_FIELDS = PRE_MODEL_BINDING_FIELDS.filter(
  (field) => field !== "officialReleaseRevisionId",
);
const CLOUD_FIELDS = [
  "binding_id",
  "agent_installation_id",
  "agent_version_id",
  "runtime_profile_id",
  "runtime_version",
  "policy_snapshot_id",
  "tool_permission_digest",
] as const;
const OFFICIAL_CLOUD_FIELDS = [
  ...CLOUD_FIELDS,
  "official_release_revision_id",
] as const;

export interface LocalRuntimeBinding {
  id: string;
  conversationKey: string;
  hermesSessionId: string | null;
  tenantId: string;
  ownerScope: "USER";
  ownerId: string;
  deviceId: string;
  agentDefinitionId: string;
  agentVersionId: string;
  agentInstallationId: string;
  runtimeProfileId: string;
  runtimeVersion: string;
  modelRoute: SessionModelOverride | null;
  policySnapshotId: string;
  officialReleaseRevisionId: string | null;
  toolPermissionDigest: string;
  publishedBaseDigest: string;
  localAdaptiveStateRevision: string;
  createdAt: string;
}

export type CreateLocalRuntimeBindingInput = Omit<
  LocalRuntimeBinding,
  | "id"
  | "hermesSessionId"
  | "localAdaptiveStateRevision"
  | "createdAt"
  | "modelRoute"
> & { modelRoute: SessionModelOverride };

export interface PendingRuntimeBindingCloudRecord {
  id: string;
  body: CreateRuntimeBindingRecordRequest;
  attemptCount: number;
  nextAttemptAt: string | null;
}

export interface RuntimeBindingRecordClient {
  recordRuntimeBinding(
    body: CreateRuntimeBindingRecordRequest,
    idempotencyKey: string,
  ): Promise<unknown>;
}

export type RuntimeBindingStoreErrorCode =
  | "invalid_binding"
  | "binding_conflict"
  | "binding_required"
  | "binding_corrupt";

export class RuntimeBindingStoreError extends Error {
  readonly code: RuntimeBindingStoreErrorCode;

  constructor(code: RuntimeBindingStoreErrorCode) {
    super(`Aera RuntimeBinding failed: ${code}.`);
    this.name = "RuntimeBindingStoreError";
    this.code = code;
  }
}

export interface RuntimeBindingStoreOptions {
  database: AgenteraControlPlaneDatabase;
  owner: AgenteraRuntimeOwner;
  now?: () => Date;
  randomUUID?: () => string;
}

interface BindingRow {
  id?: unknown;
  conversation_key?: unknown;
  hermes_session_id?: unknown;
  binding_json?: unknown;
  created_at?: unknown;
}

interface PendingRow {
  id?: unknown;
  payload_json?: unknown;
  attempt_count?: unknown;
  next_attempt_at?: unknown;
}

function exactKeys(value: object, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function uuid(value: unknown, error: RuntimeBindingStoreErrorCode): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RuntimeBindingStoreError(error);
  }
  return value.toLowerCase();
}

function digest(value: unknown, error: RuntimeBindingStoreErrorCode): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new RuntimeBindingStoreError(error);
  }
  return value;
}

function boundedText(
  value: unknown,
  maximum: number,
  error: RuntimeBindingStoreErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\0\r\n]/.test(value)
  ) {
    throw new RuntimeBindingStoreError(error);
  }
  return value;
}

function modelRoute(
  value: unknown,
  error: RuntimeBindingStoreErrorCode,
): SessionModelOverride {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeBindingStoreError(error);
  }
  if (!exactKeys(value, ["provider", "model", "baseUrl"])) {
    throw new RuntimeBindingStoreError(error);
  }
  const record = value as Record<string, unknown>;
  const provider = boundedText(record.provider, 128, error).trim();
  const model = boundedText(record.model, 512, error).trim();
  if (
    !provider ||
    provider.toLowerCase() === "auto" ||
    !model ||
    typeof record.baseUrl !== "string" ||
    Buffer.byteLength(record.baseUrl, "utf8") > 2_048 ||
    /[\0\r\n]/.test(record.baseUrl)
  ) {
    throw new RuntimeBindingStoreError(error);
  }
  return { provider, model, baseUrl: record.baseUrl.trim() };
}

function isoTimestamp(
  value: unknown,
  error: RuntimeBindingStoreErrorCode,
): string {
  if (typeof value !== "string") throw new RuntimeBindingStoreError(error);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RuntimeBindingStoreError(error);
  }
  return value;
}

function createTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RuntimeBindingStoreError("invalid_binding");
  }
  return value.toISOString();
}

function normalizeInput(
  input: CreateLocalRuntimeBindingInput,
): CreateLocalRuntimeBindingInput {
  if (
    input === null ||
    typeof input !== "object" ||
    !exactKeys(input, [
      "conversationKey",
      "tenantId",
      "ownerScope",
      "ownerId",
      "deviceId",
      "agentDefinitionId",
      "agentVersionId",
      "agentInstallationId",
      "runtimeProfileId",
      "runtimeVersion",
      "modelRoute",
      "policySnapshotId",
      "officialReleaseRevisionId",
      "toolPermissionDigest",
      "publishedBaseDigest",
    ]) ||
    input.ownerScope !== "USER"
  ) {
    throw new RuntimeBindingStoreError("invalid_binding");
  }
  return {
    conversationKey: boundedText(input.conversationKey, 256, "invalid_binding"),
    tenantId: uuid(input.tenantId, "invalid_binding"),
    ownerScope: "USER",
    ownerId: uuid(input.ownerId, "invalid_binding"),
    deviceId: uuid(input.deviceId, "invalid_binding"),
    agentDefinitionId: uuid(input.agentDefinitionId, "invalid_binding"),
    agentVersionId: uuid(input.agentVersionId, "invalid_binding"),
    agentInstallationId: uuid(input.agentInstallationId, "invalid_binding"),
    runtimeProfileId: uuid(input.runtimeProfileId, "invalid_binding"),
    runtimeVersion: boundedText(input.runtimeVersion, 128, "invalid_binding"),
    modelRoute: modelRoute(input.modelRoute, "invalid_binding"),
    policySnapshotId: uuid(input.policySnapshotId, "invalid_binding"),
    officialReleaseRevisionId:
      input.officialReleaseRevisionId === null
        ? null
        : uuid(input.officialReleaseRevisionId, "invalid_binding"),
    toolPermissionDigest: digest(input.toolPermissionDigest, "invalid_binding"),
    publishedBaseDigest: digest(input.publishedBaseDigest, "invalid_binding"),
  };
}

function parseBinding(value: unknown): LocalRuntimeBinding {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (!exactKeys(value, BINDING_FIELDS) &&
      !exactKeys(value, LEGACY_BINDING_FIELDS) &&
      !exactKeys(value, PRE_MODEL_BINDING_FIELDS) &&
      !exactKeys(value, PRE_MODEL_LEGACY_BINDING_FIELDS))
  ) {
    throw new RuntimeBindingStoreError("binding_corrupt");
  }
  const record = value as Record<string, unknown>;
  if (record.ownerScope !== "USER") {
    throw new RuntimeBindingStoreError("binding_corrupt");
  }
  return {
    id: uuid(record.id, "binding_corrupt"),
    conversationKey: boundedText(
      record.conversationKey,
      256,
      "binding_corrupt",
    ),
    hermesSessionId:
      record.hermesSessionId === null
        ? null
        : boundedText(record.hermesSessionId, 512, "binding_corrupt"),
    tenantId: uuid(record.tenantId, "binding_corrupt"),
    ownerScope: "USER",
    ownerId: uuid(record.ownerId, "binding_corrupt"),
    deviceId: uuid(record.deviceId, "binding_corrupt"),
    agentDefinitionId: uuid(record.agentDefinitionId, "binding_corrupt"),
    agentVersionId: uuid(record.agentVersionId, "binding_corrupt"),
    agentInstallationId: uuid(record.agentInstallationId, "binding_corrupt"),
    runtimeProfileId: uuid(record.runtimeProfileId, "binding_corrupt"),
    runtimeVersion: boundedText(record.runtimeVersion, 128, "binding_corrupt"),
    modelRoute: Object.hasOwn(record, "modelRoute")
      ? modelRoute(record.modelRoute, "binding_corrupt")
      : null,
    policySnapshotId: uuid(record.policySnapshotId, "binding_corrupt"),
    officialReleaseRevisionId: Object.hasOwn(
      record,
      "officialReleaseRevisionId",
    )
      ? record.officialReleaseRevisionId === null
        ? null
        : uuid(record.officialReleaseRevisionId, "binding_corrupt")
      : null,
    toolPermissionDigest: digest(
      record.toolPermissionDigest,
      "binding_corrupt",
    ),
    publishedBaseDigest: digest(record.publishedBaseDigest, "binding_corrupt"),
    localAdaptiveStateRevision: uuid(
      record.localAdaptiveStateRevision,
      "binding_corrupt",
    ),
    createdAt: isoTimestamp(record.createdAt, "binding_corrupt"),
  };
}

function parseRow(row: BindingRow | undefined): LocalRuntimeBinding | null {
  if (!row) return null;
  if (typeof row.binding_json !== "string") {
    throw new RuntimeBindingStoreError("binding_corrupt");
  }
  let binding: LocalRuntimeBinding;
  try {
    binding = parseBinding(JSON.parse(row.binding_json));
  } catch (error) {
    if (error instanceof RuntimeBindingStoreError) throw error;
    throw new RuntimeBindingStoreError("binding_corrupt");
  }
  if (
    row.id !== binding.id ||
    row.conversation_key !== binding.conversationKey ||
    row.hermes_session_id !== binding.hermesSessionId ||
    row.created_at !== binding.createdAt
  ) {
    throw new RuntimeBindingStoreError("binding_corrupt");
  }
  return binding;
}

function cloudBody(
  binding: LocalRuntimeBinding,
): CreateRuntimeBindingRecordRequest {
  return {
    binding_id: binding.id,
    agent_installation_id: binding.agentInstallationId,
    agent_version_id: binding.agentVersionId,
    runtime_profile_id: binding.runtimeProfileId,
    runtime_version: binding.runtimeVersion,
    policy_snapshot_id: binding.policySnapshotId,
    tool_permission_digest: binding.toolPermissionDigest,
    ...(binding.officialReleaseRevisionId === null
      ? {}
      : {
          official_release_revision_id: binding.officialReleaseRevisionId,
        }),
  };
}

function parseCloudBody(value: unknown): CreateRuntimeBindingRecordRequest {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (!exactKeys(value, CLOUD_FIELDS) &&
      !exactKeys(value, OFFICIAL_CLOUD_FIELDS))
  ) {
    throw new RuntimeBindingStoreError("binding_corrupt");
  }
  const record = value as Record<string, unknown>;
  return {
    binding_id: uuid(record.binding_id, "binding_corrupt"),
    agent_installation_id: uuid(
      record.agent_installation_id,
      "binding_corrupt",
    ),
    agent_version_id: uuid(record.agent_version_id, "binding_corrupt"),
    runtime_profile_id: uuid(record.runtime_profile_id, "binding_corrupt"),
    runtime_version: boundedText(
      record.runtime_version,
      128,
      "binding_corrupt",
    ),
    policy_snapshot_id: uuid(record.policy_snapshot_id, "binding_corrupt"),
    tool_permission_digest: digest(
      record.tool_permission_digest,
      "binding_corrupt",
    ),
    ...(Object.hasOwn(record, "official_release_revision_id")
      ? {
          official_release_revision_id: uuid(
            record.official_release_revision_id,
            "binding_corrupt",
          ),
        }
      : {}),
  };
}

function immutableInputOf(
  binding: LocalRuntimeBinding,
): Omit<
  LocalRuntimeBinding,
  "id" | "hermesSessionId" | "localAdaptiveStateRevision" | "createdAt"
> {
  return {
    conversationKey: binding.conversationKey,
    tenantId: binding.tenantId,
    ownerScope: binding.ownerScope,
    ownerId: binding.ownerId,
    deviceId: binding.deviceId,
    agentDefinitionId: binding.agentDefinitionId,
    agentVersionId: binding.agentVersionId,
    agentInstallationId: binding.agentInstallationId,
    runtimeProfileId: binding.runtimeProfileId,
    runtimeVersion: binding.runtimeVersion,
    modelRoute: binding.modelRoute,
    policySnapshotId: binding.policySnapshotId,
    officialReleaseRevisionId: binding.officialReleaseRevisionId,
    toolPermissionDigest: binding.toolPermissionDigest,
    publishedBaseDigest: binding.publishedBaseDigest,
  };
}

function matchesImmutableInput(
  binding: LocalRuntimeBinding,
  input: CreateLocalRuntimeBindingInput,
): boolean {
  const existing = immutableInputOf(binding);
  return (
    JSON.stringify(
      existing.modelRoute === null
        ? { ...existing, modelRoute: input.modelRoute }
        : existing,
    ) === JSON.stringify(input)
  );
}

export class RuntimeBindingStore {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly tenantId: string;
  private readonly ownerId: string;
  private readonly deviceInstallationId: string;

  constructor(options: RuntimeBindingStoreOptions) {
    this.database = options.database;
    this.tenantId = uuid(options.owner.tenantId, "invalid_binding");
    this.ownerId = uuid(options.owner.ownerId, "invalid_binding");
    this.deviceInstallationId = uuid(
      options.owner.deviceInstallationId,
      "invalid_binding",
    );
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  getOrCreateForConversation(
    inputValue: CreateLocalRuntimeBindingInput,
  ): LocalRuntimeBinding {
    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const binding = this.getOrCreateForConversationInTransaction(inputValue);
      this.database.sqlite.exec("COMMIT");
      return binding;
    } catch (error) {
      try {
        this.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the primary SQLite or validation failure.
      }
      throw error;
    }
  }

  getOrCreateForConversationInTransaction(
    inputValue: CreateLocalRuntimeBindingInput,
  ): LocalRuntimeBinding {
    const input = normalizeInput(inputValue);
    if (
      input.tenantId !== this.tenantId ||
      input.ownerId !== this.ownerId ||
      input.deviceId !== this.deviceInstallationId
    ) {
      throw new RuntimeBindingStoreError("binding_conflict");
    }
    const existing = this.getByConversationKey(input.conversationKey);
    if (existing) {
      if (!matchesImmutableInput(existing, input)) {
        throw new RuntimeBindingStoreError("binding_conflict");
      }
      return existing;
    }

    const binding: LocalRuntimeBinding = {
      id: uuid(this.randomUUID(), "invalid_binding"),
      ...input,
      hermesSessionId: null,
      localAdaptiveStateRevision: uuid(this.randomUUID(), "invalid_binding"),
      createdAt: createTimestamp(this.now),
    };
    const pendingBody = cloudBody(binding);
    try {
      this.database.sqlite
        .prepare(
          `INSERT INTO runtime_bindings (
             id, tenant_id, owner_id, device_installation_id,
             conversation_key, hermes_session_id, binding_json, created_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          binding.id,
          this.tenantId,
          this.ownerId,
          this.deviceInstallationId,
          binding.conversationKey,
          JSON.stringify(binding),
          binding.createdAt,
        );
      this.database.sqlite
        .prepare(
          `INSERT INTO pending_sanitized_records (
             id, tenant_id, owner_id, device_installation_id,
             record_type, payload_json, attempt_count, next_attempt_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'runtime_binding', ?, 0, NULL, ?, ?)`,
        )
        .run(
          binding.id,
          this.tenantId,
          this.ownerId,
          this.deviceInstallationId,
          JSON.stringify(pendingBody),
          binding.createdAt,
          binding.createdAt,
        );
    } catch {
      throw new RuntimeBindingStoreError("binding_conflict");
    }
    return parseBinding(binding);
  }

  getByConversationKey(
    conversationKeyValue: string,
  ): LocalRuntimeBinding | null {
    const conversationKey = boundedText(
      conversationKeyValue,
      256,
      "invalid_binding",
    );
    return parseRow(
      this.database.sqlite
        .prepare(
          `SELECT id, conversation_key, hermes_session_id, binding_json, created_at
           FROM runtime_bindings
           WHERE conversation_key = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ?`,
        )
        .get(
          conversationKey,
          this.tenantId,
          this.ownerId,
          this.deviceInstallationId,
        ) as BindingRow | undefined,
    );
  }

  getByHermesSessionId(sessionIdValue: string): LocalRuntimeBinding | null {
    const sessionId = boundedText(sessionIdValue, 512, "invalid_binding");
    return parseRow(
      this.database.sqlite
        .prepare(
          `SELECT id, conversation_key, hermes_session_id, binding_json, created_at
           FROM runtime_bindings
           WHERE hermes_session_id = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ?`,
        )
        .get(
          sessionId,
          this.tenantId,
          this.ownerId,
          this.deviceInstallationId,
        ) as BindingRow | undefined,
    );
  }

  getById(bindingIdValue: string): LocalRuntimeBinding | null {
    const bindingId = uuid(bindingIdValue, "invalid_binding");
    return parseRow(
      this.database.sqlite
        .prepare(
          `SELECT id, conversation_key, hermes_session_id, binding_json, created_at
           FROM runtime_bindings
           WHERE id = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ?`,
        )
        .get(
          bindingId,
          this.tenantId,
          this.ownerId,
          this.deviceInstallationId,
        ) as BindingRow | undefined,
    );
  }

  listForInstallation(agentInstallationIdValue: string): LocalRuntimeBinding[] {
    const agentInstallationId = uuid(
      agentInstallationIdValue,
      "invalid_binding",
    );
    return (
      this.database.sqlite
        .prepare(
          `SELECT id, conversation_key, hermes_session_id, binding_json, created_at
           FROM runtime_bindings
           WHERE tenant_id = ? AND owner_id = ?
             AND device_installation_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(
          this.tenantId,
          this.ownerId,
          this.deviceInstallationId,
        ) as BindingRow[]
    )
      .map((row) => parseRow(row))
      .filter(
        (binding): binding is LocalRuntimeBinding =>
          binding !== null &&
          binding.agentInstallationId === agentInstallationId,
      );
  }

  attachHermesSession(
    bindingIdValue: string,
    sessionIdValue: string,
  ): LocalRuntimeBinding {
    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const binding = this.attachHermesSessionInTransaction(
        bindingIdValue,
        sessionIdValue,
      );
      this.database.sqlite.exec("COMMIT");
      return binding;
    } catch (error) {
      try {
        this.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the primary SQLite or validation failure.
      }
      throw error;
    }
  }

  attachHermesSessionInTransaction(
    bindingIdValue: string,
    sessionIdValue: string,
  ): LocalRuntimeBinding {
    const bindingId = uuid(bindingIdValue, "invalid_binding");
    const sessionId = boundedText(sessionIdValue, 512, "invalid_binding");
    const current = this.getById(bindingId);
    if (!current) throw new RuntimeBindingStoreError("binding_required");
    if (current.hermesSessionId === sessionId) return current;
    if (current.hermesSessionId !== null) {
      throw new RuntimeBindingStoreError("binding_conflict");
    }
    const updated = { ...current, hermesSessionId: sessionId };
    let result;
    try {
      result = this.database.sqlite
        .prepare(
          `UPDATE runtime_bindings
           SET hermes_session_id = ?, binding_json = ?
           WHERE id = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ? AND hermes_session_id IS NULL`,
        )
        .run(
          sessionId,
          JSON.stringify(updated),
          bindingId,
          this.tenantId,
          this.ownerId,
          this.deviceInstallationId,
        );
    } catch {
      throw new RuntimeBindingStoreError("binding_conflict");
    }
    if (Number(result.changes) !== 1) {
      const raced = this.getById(bindingId);
      if (raced?.hermesSessionId === sessionId) return raced;
      throw new RuntimeBindingStoreError("binding_conflict");
    }
    return this.getById(bindingId) ?? updated;
  }

  resolveInstalledResume(
    conversationKeyValue: string,
    sessionIdValue: string,
  ): LocalRuntimeBinding {
    const conversationKey = boundedText(
      conversationKeyValue,
      256,
      "invalid_binding",
    );
    const sessionBinding = this.getByHermesSessionId(sessionIdValue);
    if (!sessionBinding) {
      throw new RuntimeBindingStoreError("binding_required");
    }
    const conversationBinding = this.getByConversationKey(conversationKey);
    if (conversationBinding && conversationBinding.id !== sessionBinding.id) {
      throw new RuntimeBindingStoreError("binding_conflict");
    }
    return sessionBinding;
  }

  listPendingCloudRecords(): PendingRuntimeBindingCloudRecord[] {
    const rows = this.database.sqlite
      .prepare(
        `SELECT id, payload_json, attempt_count, next_attempt_at
         FROM pending_sanitized_records
         WHERE record_type = 'runtime_binding' AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?
         ORDER BY created_at ASC`,
      )
      .all(
        this.tenantId,
        this.ownerId,
        this.deviceInstallationId,
      ) as PendingRow[];
    return rows.map((row) => {
      if (
        typeof row.payload_json !== "string" ||
        !Number.isSafeInteger(row.attempt_count) ||
        (row.attempt_count as number) < 0 ||
        (row.next_attempt_at !== null &&
          typeof row.next_attempt_at !== "string")
      ) {
        throw new RuntimeBindingStoreError("binding_corrupt");
      }
      const id = uuid(row.id, "binding_corrupt");
      let body: CreateRuntimeBindingRecordRequest;
      try {
        body = parseCloudBody(JSON.parse(row.payload_json));
      } catch (error) {
        if (error instanceof RuntimeBindingStoreError) throw error;
        throw new RuntimeBindingStoreError("binding_corrupt");
      }
      if (body.binding_id !== id) {
        throw new RuntimeBindingStoreError("binding_corrupt");
      }
      return {
        id,
        body,
        attemptCount: row.attempt_count as number,
        nextAttemptAt:
          row.next_attempt_at === null
            ? null
            : isoTimestamp(row.next_attempt_at, "binding_corrupt"),
      };
    });
  }

  async retryPendingCloudRecords(
    client: RuntimeBindingRecordClient,
  ): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    for (const record of this.listPendingCloudRecords()) {
      try {
        await client.recordRuntimeBinding(record.body, record.id);
        const result = this.database.sqlite
          .prepare(
            `DELETE FROM pending_sanitized_records
             WHERE id = ? AND tenant_id = ? AND owner_id = ?
               AND device_installation_id = ? AND record_type = 'runtime_binding'`,
          )
          .run(
            record.id,
            this.tenantId,
            this.ownerId,
            this.deviceInstallationId,
          );
        if (Number(result.changes) !== 1) {
          throw new RuntimeBindingStoreError("binding_conflict");
        }
        delivered += 1;
      } catch {
        const updatedAt = createTimestamp(this.now);
        const backoffSeconds = Math.min(
          3600,
          2 ** Math.min(record.attemptCount, 10),
        );
        const nextAttemptAt = new Date(
          Date.parse(updatedAt) + backoffSeconds * 1000,
        ).toISOString();
        this.database.sqlite
          .prepare(
            `UPDATE pending_sanitized_records
             SET attempt_count = attempt_count + 1,
                 next_attempt_at = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ? AND owner_id = ?
               AND device_installation_id = ? AND record_type = 'runtime_binding'`,
          )
          .run(
            nextAttemptAt,
            updatedAt,
            record.id,
            this.tenantId,
            this.ownerId,
            this.deviceInstallationId,
          );
        failed += 1;
      }
    }
    return { delivered, failed };
  }
}
