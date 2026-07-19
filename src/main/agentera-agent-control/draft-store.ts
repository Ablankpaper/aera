import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import type {
  AgentDraft,
  AgentDraftAssetInput,
  AgentDraftAssetMetadata,
  AgentDraftDetail,
  AgentDraftIcon,
  AgentDraftPublicationIdentity,
  CreateAgentDraftInput,
  UpdateAgentDraftInput,
} from "../../shared/agentera-agent-control";
import type { AgenteraControlPlaneDatabase } from "./db";
import {
  canonicalizeEditableAgent,
  decodeEditableAgentManifest,
  normalizeAgentAssetPath,
  readValidatedAgentAssetFile,
  validateAgentIcon,
} from "./manifest";

export type AgentDraftStoreErrorCode =
  | "draft_not_found"
  | "draft_conflict"
  | "invalid_draft";

export class AgentDraftStoreError extends Error {
  readonly code: AgentDraftStoreErrorCode;

  constructor(code: AgentDraftStoreErrorCode) {
    super(`AgentEra Agent draft operation failed: ${code}.`);
    this.name = "AgentDraftStoreError";
    this.code = code;
  }
}

export interface AgentDraftStoreOptions {
  database: AgenteraControlPlaneDatabase;
  now?: () => Date;
  randomUUID?: () => string;
  writeFile?: (path: string, content: Buffer) => void;
}

interface DraftRow {
  id: unknown;
  source_agent_definition_id: unknown;
  base_agent_version_id: unknown;
  display_name: unknown;
  icon_media_type: unknown;
  icon_data_base64: unknown;
  manifest_json: unknown;
  revision: unknown;
  publication_attempt_revision: unknown;
  publication_attempted_at: unknown;
  publication_error_code: unknown;
  publication_error_summary: unknown;
  published_definition_id: unknown;
  published_version_id: unknown;
  published_revision: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface AssetRow {
  path: unknown;
  revision: unknown;
  kind: unknown;
  media_type: unknown;
  size_bytes: unknown;
  sha256: unknown;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function requireUuid(value: unknown): string {
  if (!validUuid(value)) throw new AgentDraftStoreError("invalid_draft");
  return value.toLowerCase();
}

function nullableUuid(value: unknown): string | null {
  if (value === null) return null;
  return requireUuid(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function nowTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AgentDraftStoreError("invalid_draft");
  }
  return value.toISOString();
}

function validateDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > 128 ||
    /[\0\r\n]/.test(value)
  ) {
    throw new AgentDraftStoreError("invalid_draft");
  }
  return value;
}

function normalizeIcon(icon: AgentDraftIcon | null): AgentDraftIcon | null {
  if (icon === null) return null;
  if (
    typeof icon !== "object" ||
    Array.isArray(icon) ||
    Object.keys(icon).length !== 2 ||
    !Object.hasOwn(icon, "mediaType") ||
    !Object.hasOwn(icon, "dataBase64") ||
    (icon.mediaType !== "image/png" && icon.mediaType !== "image/webp") ||
    typeof icon.dataBase64 !== "string"
  ) {
    throw new AgentDraftStoreError("invalid_draft");
  }
  const bytes = Buffer.from(icon.dataBase64, "base64");
  if (bytes.toString("base64") !== icon.dataBase64) {
    throw new AgentDraftStoreError("invalid_draft");
  }
  validateAgentIcon(icon.mediaType, bytes);
  return { mediaType: icon.mediaType, dataBase64: icon.dataBase64 };
}

function changes(result: { changes: number | bigint }): number {
  const value = Number(result.changes);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentDraftStoreError("invalid_draft");
  }
  return value;
}

function rollback(database: AgenteraControlPlaneDatabase): void {
  try {
    database.sqlite.exec("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}

function assetContentByNormalizedPath(
  assets: readonly AgentDraftAssetInput[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const asset of assets) {
    result.set(normalizeAgentAssetPath(asset.path), asset.content);
  }
  return result;
}

export class AgentDraftStore {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly writeFile: (path: string, content: Buffer) => void;

  constructor(options: AgentDraftStoreOptions) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.writeFile =
      options.writeFile ??
      ((path, content) => {
        writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      });
  }

  createDraft(input: CreateAgentDraftInput): AgentDraft {
    const id = requireUuid(this.randomUUID());
    const displayName = validateDisplayName(input.displayName);
    const sourceDefinitionId = nullableUuid(input.sourceAgentDefinitionId);
    const baseVersionId = nullableUuid(input.baseAgentVersionId);
    const icon = normalizeIcon(input.icon);
    const canonical = canonicalizeEditableAgent(input.manifest, input.assets);
    const timestamp = nowTimestamp(this.now);
    const revision = 1;
    const materialized = this.materializeRevision(
      id,
      revision,
      canonical.assets,
      assetContentByNormalizedPath(input.assets),
    );
    try {
      this.database.sqlite.exec("BEGIN IMMEDIATE");
      this.database.sqlite
        .prepare(
          `INSERT INTO agent_drafts (
             id, source_agent_definition_id, base_agent_version_id,
             display_name, icon_media_type, icon_data_base64, manifest_json,
             revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          sourceDefinitionId,
          baseVersionId,
          displayName,
          icon?.mediaType ?? null,
          icon?.dataBase64 ?? null,
          JSON.stringify(canonical.normalizedManifest),
          revision,
          timestamp,
          timestamp,
        );
      this.insertAssetRows(id, revision, canonical.assets);
      this.database.sqlite.exec("COMMIT");
    } catch (error) {
      rollback(this.database);
      rmSync(materialized, { recursive: true, force: true });
      throw error;
    }
    return this.getDraft(id);
  }

  updateDraft(input: UpdateAgentDraftInput): AgentDraft {
    const id = requireUuid(input.id);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      throw new AgentDraftStoreError("invalid_draft");
    }
    const current = this.getDraft(id);
    if (current.revision !== input.expectedRevision) {
      throw new AgentDraftStoreError("draft_conflict");
    }
    const displayName = validateDisplayName(input.displayName);
    const icon = normalizeIcon(input.icon);
    const canonical = canonicalizeEditableAgent(input.manifest, input.assets);
    const revision = current.revision + 1;
    const timestamp = nowTimestamp(this.now);
    const materialized = this.materializeRevision(
      id,
      revision,
      canonical.assets,
      assetContentByNormalizedPath(input.assets),
    );
    try {
      this.database.sqlite.exec("BEGIN IMMEDIATE");
      const updated = this.database.sqlite
        .prepare(
          `UPDATE agent_drafts
           SET display_name = ?, icon_media_type = ?, icon_data_base64 = ?,
               manifest_json = ?, revision = revision + 1, updated_at = ?,
               publication_attempt_revision = NULL,
               publication_attempted_at = NULL,
               publication_idempotency_key = NULL,
               publication_error_code = NULL,
               publication_error_summary = NULL
           WHERE id = ? AND revision = ?`,
        )
        .run(
          displayName,
          icon?.mediaType ?? null,
          icon?.dataBase64 ?? null,
          JSON.stringify(canonical.normalizedManifest),
          timestamp,
          id,
          current.revision,
        );
      if (changes(updated) !== 1) {
        throw new AgentDraftStoreError("draft_conflict");
      }
      this.database.sqlite
        .prepare("DELETE FROM draft_assets WHERE draft_id = ?")
        .run(id);
      this.insertAssetRows(id, revision, canonical.assets);
      this.database.sqlite.exec("COMMIT");
    } catch (error) {
      rollback(this.database);
      rmSync(materialized, { recursive: true, force: true });
      throw error;
    }
    return this.getDraft(id);
  }

  listDrafts(): AgentDraft[] {
    const rows = this.database.sqlite
      .prepare("SELECT id FROM agent_drafts ORDER BY updated_at DESC, id ASC")
      .all() as Array<{ id?: unknown }>;
    return rows.map((row) => this.getDraft(requireUuid(row.id)));
  }

  getDraft(idInput: string): AgentDraft {
    const id = requireUuid(idInput);
    const row = this.database.sqlite
      .prepare("SELECT * FROM agent_drafts WHERE id = ?")
      .get(id) as DraftRow | undefined;
    if (!row) throw new AgentDraftStoreError("draft_not_found");
    return this.toDraft(row);
  }

  getDraftDetail(idInput: string): AgentDraftDetail {
    const draft = this.getDraft(idInput);
    return {
      ...draft,
      editableAssets: draft.manifest.assets.map(({ path }) => ({
        path,
        content: this.readAsset(draft.id, path).toString("utf8"),
      })),
    };
  }

  deleteDraft(idInput: string): void {
    const id = requireUuid(idInput);
    const result = this.database.sqlite
      .prepare("DELETE FROM agent_drafts WHERE id = ?")
      .run(id);
    if (changes(result) !== 1) {
      throw new AgentDraftStoreError("draft_not_found");
    }
    rmSync(join(this.database.paths.draftsPath, id), {
      recursive: true,
      force: true,
    });
  }

  readAsset(idInput: string, pathInput: string): Buffer {
    const draft = this.getDraft(idInput);
    const path = normalizeAgentAssetPath(pathInput);
    const metadata = draft.assets.find((asset) => asset.path === path);
    if (!metadata) throw new AgentDraftStoreError("invalid_draft");
    const revisionRoot = this.revisionPath(draft.id, draft.revision);
    const content = readValidatedAgentAssetFile(revisionRoot, path);
    if (
      content.length !== metadata.sizeBytes ||
      nodeCreateSha256(content) !== metadata.sha256
    ) {
      throw new AgentDraftStoreError("invalid_draft");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new AgentDraftStoreError("invalid_draft");
    }
    return content;
  }

  beginPublicationAttempt(
    idInput: string,
    revision: number,
  ): AgentDraftPublicationIdentity {
    const draft = this.getDraft(idInput);
    if (!Number.isSafeInteger(revision) || revision !== draft.revision) {
      throw new AgentDraftStoreError("draft_conflict");
    }
    const existing = this.database.sqlite
      .prepare(
        `SELECT publication_attempt_revision AS revision,
                publication_attempted_at AS attempted_at,
                publication_idempotency_key AS idempotency_key
         FROM agent_drafts WHERE id = ?`,
      )
      .get(draft.id) as
      | {
          revision?: unknown;
          attempted_at?: unknown;
          idempotency_key?: unknown;
        }
      | undefined;
    if (
      existing?.revision === revision &&
      canonicalTimestamp(existing.attempted_at) &&
      validUuid(existing.idempotency_key)
    ) {
      const attemptedAt = nowTimestamp(this.now);
      const refreshed = this.database.sqlite
        .prepare(
          `UPDATE agent_drafts
           SET publication_attempted_at = ?, publication_error_code = NULL,
               publication_error_summary = NULL
           WHERE id = ? AND revision = ? AND publication_attempt_revision = ?`,
        )
        .run(attemptedAt, draft.id, revision, revision);
      if (changes(refreshed) !== 1) {
        throw new AgentDraftStoreError("draft_conflict");
      }
      return {
        revision,
        attemptedAt,
        idempotencyKey: existing.idempotency_key,
      };
    }

    const idempotencyKey = requireUuid(this.randomUUID());
    const attemptedAt = nowTimestamp(this.now);
    const result = this.database.sqlite
      .prepare(
        `UPDATE agent_drafts
         SET publication_attempt_revision = ?, publication_attempted_at = ?,
             publication_idempotency_key = ?, publication_error_code = NULL,
             publication_error_summary = NULL
         WHERE id = ? AND revision = ?`,
      )
      .run(revision, attemptedAt, idempotencyKey, draft.id, revision);
    if (changes(result) !== 1) {
      throw new AgentDraftStoreError("draft_conflict");
    }
    return { revision, attemptedAt, idempotencyKey };
  }

  recordPublicationFailure(
    idInput: string,
    revision: number,
    errorCode: string,
    errorSummary: string,
  ): void {
    const id = requireUuid(idInput);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !ERROR_CODE_PATTERN.test(errorCode) ||
      typeof errorSummary !== "string" ||
      errorSummary.length === 0 ||
      Buffer.byteLength(errorSummary, "utf8") > 256 ||
      /[\0\r\n]/.test(errorSummary)
    ) {
      throw new Error("AgentEra publication error summary must be bounded.");
    }
    const result = this.database.sqlite
      .prepare(
        `UPDATE agent_drafts
         SET publication_error_code = ?, publication_error_summary = ?
         WHERE id = ? AND revision = ? AND publication_attempt_revision = ?`,
      )
      .run(errorCode, errorSummary, id, revision, revision);
    if (changes(result) !== 1) {
      throw new AgentDraftStoreError("draft_conflict");
    }
  }

  markPublished(
    idInput: string,
    revision: number,
    definitionIdInput: string,
    versionIdInput: string,
  ): AgentDraft {
    const id = requireUuid(idInput);
    const definitionId = requireUuid(definitionIdInput);
    const versionId = requireUuid(versionIdInput);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new AgentDraftStoreError("invalid_draft");
    }
    const updatedAt = nowTimestamp(this.now);
    const result = this.database.sqlite
      .prepare(
        `UPDATE agent_drafts
         SET source_agent_definition_id = ?, base_agent_version_id = ?,
             published_definition_id = ?, published_version_id = ?,
             published_revision = ?, publication_error_code = NULL,
             publication_error_summary = NULL, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        definitionId,
        versionId,
        definitionId,
        versionId,
        revision,
        updatedAt,
        id,
        revision,
      );
    if (changes(result) !== 1) {
      throw new AgentDraftStoreError("draft_conflict");
    }
    return this.getDraft(id);
  }

  private revisionPath(id: string, revision: number): string {
    return join(
      this.database.paths.draftsPath,
      id,
      "revisions",
      String(revision),
    );
  }

  private materializeRevision(
    id: string,
    revision: number,
    metadata: readonly AgentDraftAssetMetadata[],
    contentByPath: ReadonlyMap<string, string>,
  ): string {
    const revisionsRoot = join(this.database.paths.draftsPath, id, "revisions");
    mkdirSync(revisionsRoot, { recursive: true, mode: 0o700 });
    const staging = join(
      revisionsRoot,
      `.staging-${requireUuid(this.randomUUID())}`,
    );
    const destination = this.revisionPath(id, revision);
    mkdirSync(staging, { mode: 0o700 });
    let moved = false;
    try {
      for (const asset of metadata) {
        const content = contentByPath.get(asset.path);
        if (content === undefined) {
          throw new AgentDraftStoreError("invalid_draft");
        }
        const path = join(staging, ...asset.path.split("/"));
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.writeFile(path, Buffer.from(content, "utf8"));
      }
      renameSync(staging, destination);
      moved = true;
      return destination;
    } catch (error) {
      rmSync(moved ? destination : staging, { recursive: true, force: true });
      throw error;
    }
  }

  private insertAssetRows(
    id: string,
    revision: number,
    assets: readonly AgentDraftAssetMetadata[],
  ): void {
    const statement = this.database.sqlite.prepare(
      `INSERT INTO draft_assets (
         draft_id, path, revision, kind, media_type, size_bytes, sha256
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const asset of assets) {
      statement.run(
        id,
        asset.path,
        revision,
        asset.kind,
        asset.mediaType,
        asset.sizeBytes,
        asset.sha256,
      );
    }
  }

  private toDraft(row: DraftRow): AgentDraft {
    const id = requireUuid(row.id);
    const revision = Number(row.revision);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !canonicalTimestamp(row.created_at) ||
      !canonicalTimestamp(row.updated_at) ||
      typeof row.manifest_json !== "string"
    ) {
      throw new AgentDraftStoreError("invalid_draft");
    }
    const icon = this.readIcon(row.icon_media_type, row.icon_data_base64);
    const assets = this.readAssetMetadata(id, revision);
    return {
      id,
      sourceAgentDefinitionId: nullableUuid(row.source_agent_definition_id),
      baseAgentVersionId: nullableUuid(row.base_agent_version_id),
      displayName: validateDisplayName(row.display_name),
      icon,
      manifest: decodeEditableAgentManifest(
        Buffer.from(row.manifest_json, "utf8"),
      ),
      assets,
      revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastPublicationAttempt: this.readPublicationAttempt(row),
      publishedRevision: this.readPublishedRevision(row),
    };
  }

  private readIcon(
    mediaType: unknown,
    dataBase64: unknown,
  ): AgentDraftIcon | null {
    if (mediaType === null && dataBase64 === null) return null;
    if (
      (mediaType !== "image/png" && mediaType !== "image/webp") ||
      typeof dataBase64 !== "string"
    ) {
      throw new AgentDraftStoreError("invalid_draft");
    }
    return normalizeIcon({ mediaType, dataBase64 });
  }

  private readAssetMetadata(
    id: string,
    revision: number,
  ): AgentDraftAssetMetadata[] {
    const rows = this.database.sqlite
      .prepare(
        `SELECT path, revision, kind, media_type, size_bytes, sha256
         FROM draft_assets WHERE draft_id = ? ORDER BY path`,
      )
      .all(id) as AssetRow[];
    return rows.map((row) => {
      const sizeBytes = Number(row.size_bytes);
      if (
        row.revision !== revision ||
        typeof row.path !== "string" ||
        normalizeAgentAssetPath(row.path) !== row.path ||
        (row.kind !== "skill" &&
          row.kind !== "sop" &&
          row.kind !== "knowledge") ||
        (row.media_type !== "text/markdown" &&
          row.media_type !== "text/plain") ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 0 ||
        typeof row.sha256 !== "string" ||
        !SHA256_PATTERN.test(row.sha256)
      ) {
        throw new AgentDraftStoreError("invalid_draft");
      }
      return {
        path: row.path,
        kind: row.kind,
        mediaType: row.media_type,
        sizeBytes,
        sha256: row.sha256,
      };
    });
  }

  private readPublicationAttempt(
    row: DraftRow,
  ): AgentDraft["lastPublicationAttempt"] {
    if (
      row.publication_attempt_revision === null &&
      row.publication_attempted_at === null &&
      row.publication_error_code === null &&
      row.publication_error_summary === null
    ) {
      return null;
    }
    const revision = Number(row.publication_attempt_revision);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !canonicalTimestamp(row.publication_attempted_at) ||
      (row.publication_error_code !== null &&
        (typeof row.publication_error_code !== "string" ||
          !ERROR_CODE_PATTERN.test(row.publication_error_code))) ||
      (row.publication_error_summary !== null &&
        (typeof row.publication_error_summary !== "string" ||
          Buffer.byteLength(row.publication_error_summary, "utf8") > 256))
    ) {
      throw new AgentDraftStoreError("invalid_draft");
    }
    return {
      revision,
      attemptedAt: row.publication_attempted_at,
      errorCode: row.publication_error_code,
      errorSummary: row.publication_error_summary,
    };
  }

  private readPublishedRevision(
    row: DraftRow,
  ): AgentDraft["publishedRevision"] {
    if (
      row.published_revision === null &&
      row.published_definition_id === null &&
      row.published_version_id === null
    ) {
      return null;
    }
    const revision = Number(row.published_revision);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !validUuid(row.published_definition_id) ||
      !validUuid(row.published_version_id)
    ) {
      throw new AgentDraftStoreError("invalid_draft");
    }
    return {
      revision,
      definitionId: row.published_definition_id,
      versionId: row.published_version_id,
    };
  }
}

function nodeCreateSha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
