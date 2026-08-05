import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type {
  CanonicalExperienceCandidate,
  ExperienceCandidateBundleV1,
  ExperienceCandidateLocalStatus,
  OrganizationExperienceCandidateImportReceipt,
  OrganizationExperienceCandidateLocalReceipt,
} from "../../shared/agentera-agent-control";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { AgenteraControlPlaneDatabase } from "./db";
import {
  EXPERIENCE_CANDIDATE_DLP_VERSION,
  canonicalizeExperienceCandidate,
  scanExperienceCandidate,
} from "./experience-candidate-contract";

export interface PrepareLocalOrganizationExperienceCandidate {
  id: string;
  agentInstallationId: string;
  organizationId: string;
  agentDefinitionId: string;
  sourceAgentVersionId: string;
  runtimeProfileId: string;
  skillName: string;
  sourceRelativePath: string;
  canonical: CanonicalExperienceCandidate;
}

export type RecordLocalOrganizationExperienceCandidateImport = Omit<
  OrganizationExperienceCandidateImportReceipt,
  "importedAt"
>;

export interface OrganizationExperienceCandidateStoreOptions {
  database: AgenteraControlPlaneDatabase;
  owner: AgenteraRuntimeOwner;
  now?: () => Date;
  randomUUID?: () => string;
}

export interface OrganizationExperienceCandidateMutationIntent {
  idempotencyKey: string;
  operation: "SUBMIT" | "REVIEW";
  candidateId: string;
  requestHash: string;
}

export type OrganizationExperienceCandidateStoreErrorCode =
  | "invalid_candidate"
  | "candidate_not_found"
  | "candidate_conflict"
  | "snapshot_invalid"
  | "mutation_conflict";

interface CandidateRow {
  id: unknown;
  agent_installation_id: unknown;
  organization_id: unknown;
  agent_definition_id: unknown;
  source_agent_version_id: unknown;
  skill_name: unknown;
  content_digest: unknown;
  snapshot_relative_path: unknown;
  status: unknown;
  cloud_candidate_id: unknown;
  last_error_code: unknown;
  created_at: unknown;
  updated_at: unknown;
  submitted_at: unknown;
}

interface ImportRow {
  candidate_id: unknown;
  organization_id: unknown;
  agent_definition_id: unknown;
  base_agent_version_id: unknown;
  candidate_content_digest: unknown;
  draft_id: unknown;
  imported_at: unknown;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export class OrganizationExperienceCandidateStoreError extends Error {
  readonly code: OrganizationExperienceCandidateStoreErrorCode;

  constructor(code: OrganizationExperienceCandidateStoreErrorCode) {
    super(`Organization ExperienceCandidate store failed: ${code}.`);
    this.name = "OrganizationExperienceCandidateStoreError";
    this.code = code;
  }
}

function storeError(
  code: OrganizationExperienceCandidateStoreErrorCode,
): never {
  throw new OrganizationExperienceCandidateStoreError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return storeError("invalid_candidate");
  }
  return value.toLowerCase();
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    return storeError("invalid_candidate");
  }
  return value;
}

function errorCode(value: unknown): string {
  if (typeof value !== "string" || !ERROR_CODE_PATTERN.test(value)) {
    return storeError("invalid_candidate");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    return storeError("invalid_candidate");
  }
  return value;
}

function nowTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return storeError("invalid_candidate");
  }
  return value.toISOString();
}

function sourceRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    return storeError("invalid_candidate");
  }
  const segments = value.split("/");
  if (
    (segments.length !== 2 && segments.length !== 3) ||
    segments[0] !== "skills" ||
    segments
      .slice(1)
      .some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.startsWith(".") ||
          Buffer.byteLength(segment, "utf8") > 255,
      )
  ) {
    return storeError("invalid_candidate");
  }
  return value;
}

function status(value: unknown): ExperienceCandidateLocalStatus {
  if (
    value !== "PREPARED" &&
    value !== "UPLOAD_FAILED" &&
    value !== "SUBMITTED"
  ) {
    return storeError("invalid_candidate");
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(parent: string, child: string): boolean {
  const nested = relative(resolve(parent), resolve(child));
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function changes(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function decodeSnapshot(raw: Buffer): CanonicalExperienceCandidate {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return storeError("snapshot_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return storeError("snapshot_invalid");
  }
  if (
    !exactObject(parsed, ["schema_version", "skill_name", "assets"]) ||
    parsed.schema_version !== 1 ||
    typeof parsed.skill_name !== "string" ||
    !Array.isArray(parsed.assets)
  ) {
    return storeError("snapshot_invalid");
  }
  const assets: ExperienceCandidateBundleV1["assets"] = parsed.assets.map(
    (asset) => {
      if (
        !exactObject(asset, ["path", "media_type", "content"]) ||
        typeof asset.path !== "string" ||
        (asset.media_type !== "text/markdown" &&
          asset.media_type !== "text/plain") ||
        typeof asset.content !== "string"
      ) {
        return storeError("snapshot_invalid");
      }
      return {
        path: asset.path,
        mediaType: asset.media_type,
        content: asset.content,
      };
    },
  );
  try {
    const canonical = canonicalizeExperienceCandidate({
      schemaVersion: 1,
      skillName: parsed.skill_name,
      assets,
    });
    if (canonical.canonicalJson !== text) {
      return storeError("snapshot_invalid");
    }
    return canonical;
  } catch {
    return storeError("snapshot_invalid");
  }
}

export class OrganizationExperienceCandidateStore {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly tenantId: string;
  private readonly ownerId: string;
  private readonly deviceInstallationId: string;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(options: OrganizationExperienceCandidateStoreOptions) {
    this.database = options.database;
    this.tenantId = uuid(options.owner.tenantId);
    this.ownerId = uuid(options.owner.ownerId);
    this.deviceInstallationId = uuid(options.owner.deviceInstallationId);
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  prepare(
    input: PrepareLocalOrganizationExperienceCandidate,
  ): OrganizationExperienceCandidateLocalReceipt {
    const id = uuid(input.id);
    const installationId = uuid(input.agentInstallationId);
    const organizationId = uuid(input.organizationId);
    const definitionId = uuid(input.agentDefinitionId);
    const versionId = uuid(input.sourceAgentVersionId);
    const profileId = uuid(input.runtimeProfileId);
    const sourcePath = sourceRelativePath(input.sourceRelativePath);
    if (input.skillName !== input.canonical.bundle.skillName) {
      return storeError("invalid_candidate");
    }
    let canonical: CanonicalExperienceCandidate;
    try {
      canonical = canonicalizeExperienceCandidate(input.canonical.bundle);
    } catch {
      return storeError("invalid_candidate");
    }
    if (
      canonical.canonicalJson !== input.canonical.canonicalJson ||
      canonical.contentDigest !== input.canonical.contentDigest ||
      scanExperienceCandidate(canonical).length !== 0
    ) {
      return storeError("invalid_candidate");
    }
    const installation = this.database.sqlite
      .prepare(
        `SELECT agent_installation_id
         FROM local_agent_installations
         WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ? AND source_scope = 'ORGANIZATION'
           AND source_workspace_id IS NULL AND source_organization_id = ?
           AND definition_id = ? AND selected_version_id = ?
           AND runtime_profile_id = ? AND status = 'active'`,
      )
      .get(
        installationId,
        this.tenantId,
        this.ownerId,
        this.deviceInstallationId,
        organizationId,
        definitionId,
        versionId,
        profileId,
      );
    if (!installation) return storeError("invalid_candidate");

    const snapshotRelativePath = this.snapshotRelativePath(organizationId, id);
    const partition = join(
      this.database.paths.candidatesPath,
      this.tenantId,
      this.ownerId,
      this.deviceInstallationId,
      organizationId,
    );
    const destination = join(partition, id);
    const staging = join(partition, `.staging-${uuid(this.randomUUID())}`);
    if (existsSync(destination) || existsSync(staging)) {
      return storeError("candidate_conflict");
    }
    mkdirSync(partition, { recursive: true, mode: 0o700 });
    mkdirSync(staging, { mode: 0o700 });
    let moved = false;
    try {
      const stagedSnapshot = join(staging, "candidate.json");
      writeFileSync(stagedSnapshot, canonical.canonicalJson, {
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(stagedSnapshot, 0o600);
      const verified = readFileSync(stagedSnapshot);
      if (
        verified.toString("utf8") !== canonical.canonicalJson ||
        sha256(verified) !== canonical.contentDigest
      ) {
        return storeError("snapshot_invalid");
      }
      renameSync(staging, destination);
      moved = true;
      const createdAt = nowTimestamp(this.now);
      this.database.sqlite
        .prepare(
          `INSERT INTO local_organization_experience_candidates (
             id, tenant_id, owner_id, device_installation_id,
             agent_installation_id, organization_id, agent_definition_id,
             source_agent_version_id, runtime_profile_id, skill_name,
             source_relative_path, content_digest, dlp_contract_version,
             snapshot_relative_path, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?)`,
        )
        .run(
          id,
          this.tenantId,
          this.ownerId,
          this.deviceInstallationId,
          installationId,
          organizationId,
          definitionId,
          versionId,
          profileId,
          input.skillName,
          sourcePath,
          canonical.contentDigest,
          EXPERIENCE_CANDIDATE_DLP_VERSION,
          snapshotRelativePath,
          createdAt,
          createdAt,
        );
      return this.get(id);
    } catch (error) {
      if (error instanceof OrganizationExperienceCandidateStoreError) {
        throw error;
      }
      return storeError(moved ? "candidate_conflict" : "snapshot_invalid");
    } finally {
      if (!this.hasCandidate(id)) {
        rmSync(moved ? destination : staging, { recursive: true, force: true });
      }
    }
  }

  listForOrganization(
    organizationIdInput: string,
  ): OrganizationExperienceCandidateLocalReceipt[] {
    const organizationId = uuid(organizationIdInput);
    const rows = this.database.sqlite
      .prepare(
        `SELECT * FROM local_organization_experience_candidates
         WHERE tenant_id = ? AND owner_id = ? AND device_installation_id = ?
           AND organization_id = ?
         ORDER BY created_at DESC, id`,
      )
      .all(
        this.tenantId,
        this.ownerId,
        this.deviceInstallationId,
        organizationId,
      ) as CandidateRow[];
    return rows.map((row) => this.toCandidate(row));
  }

  get(idInput: string): OrganizationExperienceCandidateLocalReceipt {
    return this.toCandidate(this.getRow(uuid(idInput)));
  }

  readSnapshot(idInput: string): CanonicalExperienceCandidate {
    const id = uuid(idInput);
    const row = this.getRow(id);
    const organizationId = uuid(row.organization_id);
    const expectedRelative = this.snapshotRelativePath(organizationId, id);
    if (row.snapshot_relative_path !== expectedRelative) {
      return storeError("snapshot_invalid");
    }
    const path = join(
      this.database.paths.candidatesPath,
      ...expectedRelative.split("/"),
    );
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        return storeError("snapshot_invalid");
      }
      const canonicalRoot = realpathSync.native(
        this.database.paths.candidatesPath,
      );
      const canonicalPath = realpathSync.native(path);
      if (!isInside(canonicalRoot, canonicalPath)) {
        return storeError("snapshot_invalid");
      }
      const raw = readFileSync(canonicalPath);
      if (sha256(raw) !== digest(row.content_digest)) {
        return storeError("snapshot_invalid");
      }
      return decodeSnapshot(raw);
    } catch (error) {
      if (error instanceof OrganizationExperienceCandidateStoreError) {
        throw error;
      }
      return storeError("snapshot_invalid");
    }
  }

  markUploadFailed(
    idInput: string,
    errorCodeInput: string,
  ): OrganizationExperienceCandidateLocalReceipt {
    return this.markRetryState(idInput, "UPLOAD_FAILED", errorCodeInput);
  }

  markPreparedWithError(
    idInput: string,
    errorCodeInput: string,
  ): OrganizationExperienceCandidateLocalReceipt {
    return this.markRetryState(idInput, "PREPARED", errorCodeInput);
  }

  markSubmitted(
    idInput: string,
    cloudCandidateIdInput: string,
  ): OrganizationExperienceCandidateLocalReceipt {
    const id = uuid(idInput);
    const cloudCandidateId = uuid(cloudCandidateIdInput);
    const current = this.get(id);
    if (current.status === "SUBMITTED") {
      if (current.cloudCandidateId !== cloudCandidateId) {
        return storeError("candidate_conflict");
      }
      this.removeSnapshot(current.organizationId, id);
      return current;
    }
    const submittedAt = nowTimestamp(this.now);
    const result = this.database.sqlite
      .prepare(
        `UPDATE local_organization_experience_candidates
         SET status = 'SUBMITTED', cloud_candidate_id = ?, last_error_code = NULL,
             submitted_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?
           AND status IN ('PREPARED', 'UPLOAD_FAILED')`,
      )
      .run(
        cloudCandidateId,
        submittedAt,
        submittedAt,
        id,
        this.tenantId,
        this.ownerId,
        this.deviceInstallationId,
      );
    if (changes(result) !== 1) return storeError("candidate_conflict");
    const candidate = this.get(id);
    this.removeSnapshot(candidate.organizationId, id);
    return candidate;
  }

  findImport(
    organizationIdInput: string,
    candidateIdInput: string,
  ): OrganizationExperienceCandidateImportReceipt | null {
    const organizationId = uuid(organizationIdInput);
    const candidateId = uuid(candidateIdInput);
    const row = this.database.sqlite
      .prepare(
        `SELECT candidate_id, organization_id, agent_definition_id,
                base_agent_version_id, candidate_content_digest,
                draft_id, imported_at
         FROM local_organization_experience_candidate_imports
         WHERE tenant_id = ? AND owner_id = ? AND device_installation_id = ?
           AND organization_id = ? AND candidate_id = ?`,
      )
      .get(
        this.tenantId,
        this.ownerId,
        this.deviceInstallationId,
        organizationId,
        candidateId,
      ) as ImportRow | undefined;
    if (!row) return null;
    return {
      candidateId: uuid(row.candidate_id),
      organizationId: uuid(row.organization_id),
      agentDefinitionId: uuid(row.agent_definition_id),
      baseAgentVersionId: uuid(row.base_agent_version_id),
      candidateContentDigest: digest(row.candidate_content_digest),
      draftId: uuid(row.draft_id),
      importedAt: timestamp(row.imported_at),
    };
  }

  recordImportInCurrentTransaction(
    input: RecordLocalOrganizationExperienceCandidateImport,
  ): OrganizationExperienceCandidateImportReceipt {
    const candidateId = uuid(input.candidateId);
    const organizationId = uuid(input.organizationId);
    const definitionId = uuid(input.agentDefinitionId);
    const baseVersionId = uuid(input.baseAgentVersionId);
    const candidateContentDigest = digest(input.candidateContentDigest);
    const draftId = uuid(input.draftId);
    const draft = this.database.sqlite
      .prepare(
        `SELECT id FROM agent_drafts
         WHERE id = ? AND tenant_id = ? AND owner_id = ?
           AND target_scope = 'ORGANIZATION' AND workspace_id IS NULL
           AND organization_id = ? AND source_agent_definition_id = ?
           AND base_agent_version_id = ?`,
      )
      .get(
        draftId,
        this.tenantId,
        this.ownerId,
        organizationId,
        definitionId,
        baseVersionId,
      );
    if (!draft) return storeError("candidate_conflict");

    const existing = this.findImport(organizationId, candidateId);
    if (existing !== null) {
      if (
        existing.agentDefinitionId === definitionId &&
        existing.baseAgentVersionId === baseVersionId &&
        existing.candidateContentDigest === candidateContentDigest &&
        existing.draftId === draftId
      ) {
        return existing;
      }
      return storeError("candidate_conflict");
    }

    const importedAt = nowTimestamp(this.now);
    try {
      const inserted = this.database.sqlite
        .prepare(
          `INSERT INTO local_organization_experience_candidate_imports (
             tenant_id, owner_id, device_installation_id, organization_id,
             candidate_id, agent_definition_id, base_agent_version_id,
             candidate_content_digest, draft_id, imported_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.tenantId,
          this.ownerId,
          this.deviceInstallationId,
          organizationId,
          candidateId,
          definitionId,
          baseVersionId,
          candidateContentDigest,
          draftId,
          importedAt,
        );
      if (changes(inserted) !== 1) return storeError("candidate_conflict");
    } catch (error) {
      if (error instanceof OrganizationExperienceCandidateStoreError) {
        throw error;
      }
      return storeError("candidate_conflict");
    }
    const recorded = this.findImport(organizationId, candidateId);
    if (recorded === null) return storeError("candidate_conflict");
    return recorded;
  }

  getOrCreateMutationIntent(
    operation: "SUBMIT" | "REVIEW",
    candidateIdInput: string,
    requestHashInput: string,
  ): OrganizationExperienceCandidateMutationIntent {
    const candidateId = uuid(candidateIdInput);
    const requestHash = digest(requestHashInput);
    if (operation === "SUBMIT") this.get(candidateId);
    const recordType =
      operation === "SUBMIT"
        ? "organization_experience_candidate_submit"
        : "organization_experience_candidate_review";
    const rows = this.database.sqlite
      .prepare(
        `SELECT id, payload_json FROM pending_sanitized_records
         WHERE tenant_id = ? AND owner_id = ? AND device_installation_id = ?
           AND record_type = ? ORDER BY created_at, id`,
      )
      .all(
        this.tenantId,
        this.ownerId,
        this.deviceInstallationId,
        recordType,
      ) as Array<{ id?: unknown; payload_json?: unknown }>;
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        return storeError("mutation_conflict");
      }
      if (
        !exactObject(payload, ["candidateId", "requestHash"]) ||
        payload.candidateId !== candidateId
      ) {
        continue;
      }
      if (payload.requestHash !== requestHash) {
        return storeError("mutation_conflict");
      }
      return {
        idempotencyKey: uuid(row.id),
        operation,
        candidateId,
        requestHash,
      };
    }
    const idempotencyKey = uuid(this.randomUUID());
    const createdAt = nowTimestamp(this.now);
    try {
      this.database.sqlite
        .prepare(
          `INSERT INTO pending_sanitized_records (
             id, tenant_id, owner_id, device_installation_id, record_type,
             payload_json, attempt_count, next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
        )
        .run(
          idempotencyKey,
          this.tenantId,
          this.ownerId,
          this.deviceInstallationId,
          recordType,
          JSON.stringify({ candidateId, requestHash }),
          createdAt,
          createdAt,
        );
    } catch {
      return storeError("mutation_conflict");
    }
    return { idempotencyKey, operation, candidateId, requestHash };
  }

  completeMutationIntent(idempotencyKeyInput: string): void {
    const idempotencyKey = uuid(idempotencyKeyInput);
    this.database.sqlite
      .prepare(
        `DELETE FROM pending_sanitized_records
         WHERE id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?
           AND record_type IN (
             'organization_experience_candidate_submit',
             'organization_experience_candidate_review'
           )`,
      )
      .run(
        idempotencyKey,
        this.tenantId,
        this.ownerId,
        this.deviceInstallationId,
      );
  }

  private markRetryState(
    idInput: string,
    nextStatus: "PREPARED" | "UPLOAD_FAILED",
    errorCodeInput: string,
  ): OrganizationExperienceCandidateLocalReceipt {
    const id = uuid(idInput);
    const code = errorCode(errorCodeInput);
    const current = this.get(id);
    if (current.status === "SUBMITTED") {
      return storeError("candidate_conflict");
    }
    const updatedAt = nowTimestamp(this.now);
    const result = this.database.sqlite
      .prepare(
        `UPDATE local_organization_experience_candidates
         SET status = ?, last_error_code = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?
           AND status IN ('PREPARED', 'UPLOAD_FAILED')`,
      )
      .run(
        nextStatus,
        code,
        updatedAt,
        id,
        this.tenantId,
        this.ownerId,
        this.deviceInstallationId,
      );
    if (changes(result) !== 1) return storeError("candidate_conflict");
    return this.get(id);
  }

  private toCandidate(
    row: CandidateRow,
  ): OrganizationExperienceCandidateLocalReceipt {
    return {
      id: uuid(row.id),
      agentInstallationId: uuid(row.agent_installation_id),
      organizationId: uuid(row.organization_id),
      agentDefinitionId: uuid(row.agent_definition_id),
      sourceAgentVersionId: uuid(row.source_agent_version_id),
      skillName:
        typeof row.skill_name === "string" && row.skill_name.length > 0
          ? row.skill_name
          : storeError("invalid_candidate"),
      contentDigest: digest(row.content_digest),
      status: status(row.status),
      cloudCandidateId: nullableUuid(row.cloud_candidate_id),
      lastErrorCode:
        row.last_error_code === null ? null : errorCode(row.last_error_code),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      submittedAt:
        row.submitted_at === null ? null : timestamp(row.submitted_at),
    };
  }

  private getRow(id: string): CandidateRow {
    const row = this.database.sqlite
      .prepare(
        `SELECT * FROM local_organization_experience_candidates
         WHERE id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?`,
      )
      .get(id, this.tenantId, this.ownerId, this.deviceInstallationId) as
      | CandidateRow
      | undefined;
    if (!row) return storeError("candidate_not_found");
    return row;
  }

  private hasCandidate(id: string): boolean {
    return Boolean(
      this.database.sqlite
        .prepare(
          `SELECT id FROM local_organization_experience_candidates
           WHERE id = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ?`,
        )
        .get(id, this.tenantId, this.ownerId, this.deviceInstallationId),
    );
  }

  private snapshotRelativePath(organizationId: string, id: string): string {
    return [
      this.tenantId,
      this.ownerId,
      this.deviceInstallationId,
      organizationId,
      id,
      "candidate.json",
    ].join("/");
  }

  private removeSnapshot(organizationId: string, id: string): void {
    const expectedRelative = this.snapshotRelativePath(organizationId, id);
    const destination = join(
      this.database.paths.candidatesPath,
      ...expectedRelative.split("/").slice(0, -1),
    );
    if (!isInside(this.database.paths.candidatesPath, destination)) return;
    try {
      rmSync(destination, { recursive: true, force: true });
    } catch {
      // Cloud acceptance is committed; cleanup remains best effort.
    }
  }
}
