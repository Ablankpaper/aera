import type { SubmissionReferenceConflictStage } from "../../shared/agentera-agent-control";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { AgenteraControlPlaneDatabase } from "./db";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFLICT_STAGES: readonly SubmissionReferenceConflictStage[] = [
  "reference_shape",
  "content_digest",
  "definition",
  "published_version",
  "draft_publication",
  "compare_and_set",
];

export type OrganizationSubmissionReferenceStoreErrorCode =
  | "invalid_request"
  | "organization_submission_reference_conflict";

export class OrganizationSubmissionReferenceStoreError extends Error {
  readonly code: OrganizationSubmissionReferenceStoreErrorCode;

  constructor(code: OrganizationSubmissionReferenceStoreErrorCode) {
    super(`Organization submission reference failed: ${code}.`);
    this.name = "OrganizationSubmissionReferenceStoreError";
    this.code = code;
  }
}

export interface OrganizationSubmissionReferenceConflict {
  organizationId: string;
  submissionId: string;
  stage: SubmissionReferenceConflictStage;
  state: "quarantined" | "detached";
  referenceRevision: number;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
}

export interface QuarantineOrganizationSubmissionReferenceInput {
  organizationId: string;
  submissionId: string;
  stage: SubmissionReferenceConflictStage;
  referenceRevision: number;
}

export interface DetachOrganizationSubmissionReferenceInput {
  organizationId: string;
  submissionId: string;
  expectedReferenceRevision: number;
}

export interface OrganizationSubmissionReferenceStoreOptions {
  database: AgenteraControlPlaneDatabase;
  owner: AgenteraRuntimeOwner;
  now?: () => Date;
}

interface ActiveReferenceRow {
  local_draft_id?: unknown;
  local_draft_revision?: unknown;
  cloud_revision?: unknown;
}

interface ConflictRow {
  organization_id?: unknown;
  cloud_submission_id?: unknown;
  stage?: unknown;
  state?: unknown;
  reference_revision?: unknown;
  first_observed_at?: unknown;
  last_observed_at?: unknown;
  resolved_at?: unknown;
}

function storeError(
  code: OrganizationSubmissionReferenceStoreErrorCode,
): OrganizationSubmissionReferenceStoreError {
  return new OrganizationSubmissionReferenceStoreError(code);
}

function uuid(
  value: unknown,
  code: OrganizationSubmissionReferenceStoreErrorCode,
): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw storeError(code);
  }
  return value;
}

function positiveRevision(
  value: unknown,
  code: OrganizationSubmissionReferenceStoreErrorCode,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw storeError(code);
  }
  return Number(value);
}

function stage(
  value: unknown,
  code: OrganizationSubmissionReferenceStoreErrorCode,
): SubmissionReferenceConflictStage {
  if (
    typeof value !== "string" ||
    !CONFLICT_STAGES.includes(value as SubmissionReferenceConflictStage)
  ) {
    throw storeError(code);
  }
  return value as SubmissionReferenceConflictStage;
}

function timestamp(
  value: unknown,
  code: OrganizationSubmissionReferenceStoreErrorCode,
): string {
  if (typeof value !== "string") throw storeError(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw storeError(code);
  }
  return value;
}

function optionalTimestamp(
  value: unknown,
  code: OrganizationSubmissionReferenceStoreErrorCode,
): string | null {
  return value === null ? null : timestamp(value, code);
}

function currentTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw storeError("invalid_request");
  }
  return value.toISOString();
}

function parseConflict(
  row: ConflictRow,
): OrganizationSubmissionReferenceConflict {
  if (row.state !== "quarantined" && row.state !== "detached") {
    throw storeError("organization_submission_reference_conflict");
  }
  return {
    organizationId: uuid(
      row.organization_id,
      "organization_submission_reference_conflict",
    ),
    submissionId: uuid(
      row.cloud_submission_id,
      "organization_submission_reference_conflict",
    ),
    stage: stage(row.stage, "organization_submission_reference_conflict"),
    state: row.state,
    referenceRevision: positiveRevision(
      row.reference_revision,
      "organization_submission_reference_conflict",
    ),
    firstObservedAt: timestamp(
      row.first_observed_at,
      "organization_submission_reference_conflict",
    ),
    lastObservedAt: timestamp(
      row.last_observed_at,
      "organization_submission_reference_conflict",
    ),
    resolvedAt: optionalTimestamp(
      row.resolved_at,
      "organization_submission_reference_conflict",
    ),
  };
}

export class OrganizationSubmissionReferenceStore {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly tenantId: string;
  private readonly ownerId: string;
  private readonly now: () => Date;

  constructor(options: OrganizationSubmissionReferenceStoreOptions) {
    this.database = options.database;
    this.tenantId = uuid(options.owner?.tenantId, "invalid_request");
    this.ownerId = uuid(options.owner?.ownerId, "invalid_request");
    uuid(options.owner?.deviceInstallationId, "invalid_request");
    this.now = options.now ?? (() => new Date());
  }

  get(
    organizationIdValue: string,
    submissionIdValue: string,
  ): OrganizationSubmissionReferenceConflict | null {
    const organizationId = uuid(organizationIdValue, "invalid_request");
    const submissionId = uuid(submissionIdValue, "invalid_request");
    const row = this.database.sqlite
      .prepare(
        `SELECT organization_id, cloud_submission_id, stage, state,
                reference_revision, first_observed_at, last_observed_at,
                resolved_at
         FROM organization_agent_submission_ref_conflicts
         WHERE tenant_id = ? AND owner_id = ?
           AND organization_id = ? AND cloud_submission_id = ?`,
      )
      .get(this.tenantId, this.ownerId, organizationId, submissionId) as
      | ConflictRow
      | undefined;
    return row === undefined ? null : parseConflict(row);
  }

  quarantine(
    input: QuarantineOrganizationSubmissionReferenceInput,
  ): OrganizationSubmissionReferenceConflict {
    const organizationId = uuid(input?.organizationId, "invalid_request");
    const submissionId = uuid(input?.submissionId, "invalid_request");
    const conflictStage = stage(input?.stage, "invalid_request");
    const referenceRevision = positiveRevision(
      input?.referenceRevision,
      "invalid_request",
    );
    const observedAt = currentTimestamp(this.now);

    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const reference = this.activeReference(organizationId, submissionId);
      if (reference.cloudRevision !== referenceRevision) {
        throw storeError("organization_submission_reference_conflict");
      }
      this.database.sqlite
        .prepare(
          `INSERT INTO organization_agent_submission_ref_conflicts (
             tenant_id, owner_id, organization_id, cloud_submission_id,
             stage, state, reference_revision,
             first_observed_at, last_observed_at, resolved_at
           ) VALUES (?, ?, ?, ?, ?, 'quarantined', ?, ?, ?, NULL)
           ON CONFLICT(
             tenant_id, owner_id, organization_id, cloud_submission_id
           ) DO UPDATE SET
             stage = excluded.stage,
             state = 'quarantined',
             reference_revision = excluded.reference_revision,
             last_observed_at = excluded.last_observed_at,
             resolved_at = NULL`,
        )
        .run(
          this.tenantId,
          this.ownerId,
          organizationId,
          submissionId,
          conflictStage,
          referenceRevision,
          observedAt,
          observedAt,
        );
      this.database.sqlite.exec("COMMIT");
    } catch (error) {
      this.rollback();
      if (error instanceof OrganizationSubmissionReferenceStoreError) {
        throw error;
      }
      throw storeError("organization_submission_reference_conflict");
    }
    const result = this.get(organizationId, submissionId);
    if (result === null) {
      throw storeError("organization_submission_reference_conflict");
    }
    return result;
  }

  clear(organizationIdValue: string, submissionIdValue: string): boolean {
    const organizationId = uuid(organizationIdValue, "invalid_request");
    const submissionId = uuid(submissionIdValue, "invalid_request");
    const result = this.database.sqlite
      .prepare(
        `DELETE FROM organization_agent_submission_ref_conflicts
         WHERE tenant_id = ? AND owner_id = ?
           AND organization_id = ? AND cloud_submission_id = ?
           AND state = 'quarantined'`,
      )
      .run(this.tenantId, this.ownerId, organizationId, submissionId);
    return Number(result.changes) === 1;
  }

  detach(
    input: DetachOrganizationSubmissionReferenceInput,
  ): OrganizationSubmissionReferenceConflict {
    const organizationId = uuid(input?.organizationId, "invalid_request");
    const submissionId = uuid(input?.submissionId, "invalid_request");
    const expectedReferenceRevision = positiveRevision(
      input?.expectedReferenceRevision,
      "invalid_request",
    );
    const resolvedAt = currentTimestamp(this.now);

    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const reference = this.activeReference(organizationId, submissionId);
      const conflict = this.get(organizationId, submissionId);
      if (
        conflict === null ||
        conflict.state !== "quarantined" ||
        conflict.referenceRevision !== expectedReferenceRevision ||
        reference.cloudRevision !== expectedReferenceRevision
      ) {
        throw storeError("organization_submission_reference_conflict");
      }
      const archived = this.database.sqlite
        .prepare(
          `UPDATE organization_agent_submission_ref_conflicts
           SET state = 'detached', last_observed_at = ?, resolved_at = ?
           WHERE tenant_id = ? AND owner_id = ?
             AND organization_id = ? AND cloud_submission_id = ?
             AND state = 'quarantined' AND reference_revision = ?`,
        )
        .run(
          resolvedAt,
          resolvedAt,
          this.tenantId,
          this.ownerId,
          organizationId,
          submissionId,
          expectedReferenceRevision,
        );
      const deleted = this.database.sqlite
        .prepare(
          `DELETE FROM organization_agent_submission_refs
           WHERE local_draft_id = ? AND local_draft_revision = ?
             AND organization_id = ? AND cloud_submission_id = ?
             AND cloud_revision = ?`,
        )
        .run(
          reference.draftId,
          reference.draftRevision,
          organizationId,
          submissionId,
          expectedReferenceRevision,
        );
      if (Number(archived.changes) !== 1 || Number(deleted.changes) !== 1) {
        throw storeError("organization_submission_reference_conflict");
      }
      this.database.sqlite.exec("COMMIT");
    } catch (error) {
      this.rollback();
      if (error instanceof OrganizationSubmissionReferenceStoreError) {
        throw error;
      }
      throw storeError("organization_submission_reference_conflict");
    }
    const result = this.get(organizationId, submissionId);
    if (result === null || result.state !== "detached") {
      throw storeError("organization_submission_reference_conflict");
    }
    return result;
  }

  private activeReference(
    organizationId: string,
    submissionId: string,
  ): { draftId: string; draftRevision: number; cloudRevision: number } {
    const row = this.database.sqlite
      .prepare(
        `SELECT reference.local_draft_id, reference.local_draft_revision,
                reference.cloud_revision
         FROM organization_agent_submission_refs AS reference
         INNER JOIN agent_drafts AS draft
           ON draft.id = reference.local_draft_id
          AND draft.tenant_id = ?
          AND draft.owner_id = ?
          AND draft.target_scope = 'ORGANIZATION'
          AND draft.organization_id = ?
         WHERE reference.organization_id = ?
           AND reference.cloud_submission_id = ?`,
      )
      .get(
        this.tenantId,
        this.ownerId,
        organizationId,
        organizationId,
        submissionId,
      ) as ActiveReferenceRow | undefined;
    if (row === undefined) {
      throw storeError("organization_submission_reference_conflict");
    }
    return {
      draftId: uuid(
        row.local_draft_id,
        "organization_submission_reference_conflict",
      ),
      draftRevision: positiveRevision(
        row.local_draft_revision,
        "organization_submission_reference_conflict",
      ),
      cloudRevision: positiveRevision(
        row.cloud_revision,
        "organization_submission_reference_conflict",
      ),
    };
  }

  private rollback(): void {
    try {
      this.database.sqlite.exec("ROLLBACK");
    } catch {
      // Preserve the bounded store error from the failed operation.
    }
  }
}
