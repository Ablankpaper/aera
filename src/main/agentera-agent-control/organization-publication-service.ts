import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import type {
  AgentDraft,
  AgentDraftAssetKind,
  AgentDraftPublicationIdentity,
  AgenteraAgentControlContext,
  ConfirmOrganizationReviewInput,
  ConfirmOrganizationSubmissionInput,
  ConfirmOrganizationWithdrawalInput,
  ExperienceCandidateFinding,
  OrganizationAgentSubmissionList,
  OrganizationAgentSubmissionListItem,
  OrganizationAgentSubmissionSummary,
  PrepareOrganizationReviewInput,
  SubmissionReferenceConflictStage,
  SubmissionReferenceState,
} from "../../shared/agentera-agent-control";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { AgenteraControlPlaneDatabase } from "./db";
import type {
  OrganizationAgentSubmissionDetailRecord,
  OrganizationAgentSubmissionRecord,
  ReviewOrganizationAgentRequest,
  SubmitOrganizationAgentRequest,
} from "./client";
import { AgenteraAgentControlClientError } from "./client";
import { AgentDraftStoreError } from "./draft-store";
import {
  AgentManifestValidationError,
  canonicalizeEditableAgent,
  type CanonicalEditableAgent,
} from "./manifest";
import { OrganizationSubmissionReferenceStore } from "./organization-submission-reference-store";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_HANDLE_TTL_MS = 5 * 60 * 1000;

type OrganizationContext = Extract<
  AgenteraAgentControlContext,
  { scope: "ORGANIZATION" }
>;

interface TrustedLocalSubmissionReference {
  draftId: string;
  draftRevision: number;
}

class LocalSubmissionReferenceConflict extends Error {
  readonly stage: SubmissionReferenceConflictStage;
  readonly referenceRevision: number;

  constructor(
    stage: SubmissionReferenceConflictStage,
    referenceRevision: number,
  ) {
    super(`Organization submission reference conflict: ${stage}.`);
    this.name = "LocalSubmissionReferenceConflict";
    this.stage = stage;
    this.referenceRevision = referenceRevision;
  }
}

export interface OrganizationPublicationDraftStore {
  getDraft(id: string): AgentDraft;
  readAsset(id: string, path: string): Buffer;
  beginPublicationAttempt(
    id: string,
    revision: number,
  ): AgentDraftPublicationIdentity;
  recordPublishedRevision(input: {
    id: string;
    publishedRevision: number;
    definitionId: string;
    versionId: string;
  }): AgentDraft;
}

export interface OrganizationPublicationClient {
  submitOrganizationAgent(
    organizationId: string,
    body: SubmitOrganizationAgentRequest,
    idempotencyKey: string,
  ): Promise<OrganizationAgentSubmissionDetailRecord>;
  listOrganizationAgentSubmissions(organizationId: string): Promise<unknown[]>;
  getOrganizationAgentSubmission(
    organizationId: string,
    submissionId: string,
  ): Promise<OrganizationAgentSubmissionDetailRecord>;
  withdrawOrganizationAgentSubmission(
    organizationId: string,
    submissionId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<OrganizationAgentSubmissionDetailRecord>;
  reviewOrganizationAgentSubmission(
    organizationId: string,
    submissionId: string,
    body: ReviewOrganizationAgentRequest,
    idempotencyKey: string,
  ): Promise<OrganizationAgentSubmissionDetailRecord>;
}

export interface OrganizationPublicationServiceOptions {
  database: AgenteraControlPlaneDatabase;
  owner: AgenteraRuntimeOwner;
  drafts?: OrganizationPublicationDraftStore;
  client: OrganizationPublicationClient;
  getContext: () => AgenteraAgentControlContext;
  getActorUserId: () => string;
  isOnline: () => boolean;
  now?: () => Date;
  randomUUID?: () => string;
  handleTtlMs?: number;
}

export interface OrganizationSubmissionPreview {
  publicationHandle: string;
  draftId: string;
  revision: number;
  kind: "initial" | "next";
  definitionId: string | null;
  baseVersionId: string | null;
  contentDigest: string;
  assetCounts: Record<AgentDraftAssetKind, number>;
  totalBytes: number;
  expiresAt: string;
}

export interface OrganizationAgentSubmissionDetail {
  summary: OrganizationAgentSubmissionSummary;
  displayName: string | null;
  icon: {
    mediaType: "image/png" | "image/webp";
    dataBase64Url: string;
  } | null;
  manifest: OrganizationAgentSubmissionDetailRecord["manifest"];
  bundle: OrganizationAgentSubmissionDetailRecord["bundle"];
  manifestDigest: string;
  bundleDigest: string;
  assetCounts: Record<AgentDraftAssetKind, number>;
  totalBytes: number;
}

export interface OrganizationReviewPreview {
  reviewHandle: string | null;
  selfReview: boolean;
  decision: "approve" | "reject";
  reasonCode: string | null;
  safeNote: string | null;
  detail: OrganizationAgentSubmissionDetail;
  expiresAt: string | null;
}

export interface OrganizationWithdrawalPreview {
  withdrawalHandle: string;
  submission: OrganizationAgentSubmissionSummary;
  revision: number;
  contentDigest: string;
  expiresAt: string;
}

export class OrganizationPublicationServiceError extends Error {
  readonly code: string;
  readonly findings: readonly ExperienceCandidateFinding[];

  constructor(
    code: string,
    findings: readonly ExperienceCandidateFinding[] = [],
  ) {
    super(`Organization Agent publication failed: ${code}.`);
    this.name = "OrganizationPublicationServiceError";
    this.code = code;
    this.findings = findings.map((finding) => ({ ...finding }));
  }
}

interface PreparedSubmission {
  contextKey: string;
  draftId: string;
  draftRevision: number;
  sourceDefinitionId: string | null;
  baseVersionId: string | null;
  displayName: string;
  iconMediaType: "image/png" | "image/webp" | null;
  iconDataBase64: string | null;
  canonical: CanonicalEditableAgent;
  request: SubmitOrganizationAgentRequest;
  expiresAt: number;
}

interface PreparedReview {
  contextKey: string;
  submissionId: string;
  submissionRevision: number;
  submittedByUserId: string;
  contentDigest: string;
  decision: "approve" | "reject";
  reasonCode: string | null;
  safeNote: string | null;
  expiresAt: number;
}

interface PreparedWithdrawal {
  contextKey: string;
  submissionId: string;
  submissionRevision: number;
  submittedByUserId: string;
  contentDigest: string;
  expiresAt: number;
}

function codedError(
  code: string,
  findings: readonly ExperienceCandidateFinding[] = [],
): OrganizationPublicationServiceError {
  return new OrganizationPublicationServiceError(code, findings);
}

function requireCanonicalUuid(
  value: unknown,
  code = "invalid_request",
): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw codedError(code);
  }
  return value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

function requireDigest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw codedError("verification_failed");
  }
  return value;
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) sorted[key] = sortedJsonValue(child);
    }
    return sorted;
  }
  return value;
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(
    JSON.stringify(sortedJsonValue(value))
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029"),
    "utf8",
  );
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function combinedDigest(manifest: Buffer, bundle: Buffer): string {
  return createHash("sha256")
    .update(manifest)
    .update(Buffer.from([0]))
    .update(bundle)
    .digest("hex");
}

function assetCountsFromManifest(
  manifest: OrganizationAgentSubmissionDetailRecord["manifest"],
): Record<AgentDraftAssetKind, number> {
  const counts = { skill: 0, sop: 0, knowledge: 0 };
  for (const asset of manifest.assets) counts[asset.kind] += 1;
  return counts;
}

function totalBundleBytes(
  bundle: OrganizationAgentSubmissionDetailRecord["bundle"],
): number {
  return bundle.assets.reduce(
    (total, asset) => total + Buffer.byteLength(asset.content, "utf8"),
    0,
  );
}

function safeFindings(
  error: AgenteraAgentControlClientError,
): ExperienceCandidateFinding[] {
  return error.findings.map((finding) => ({
    code: finding.code,
    path: finding.path,
    line: finding.line ?? null,
  }));
}

function serviceError(error: unknown): OrganizationPublicationServiceError {
  if (error instanceof OrganizationPublicationServiceError) return error;
  if (error instanceof AgenteraAgentControlClientError) {
    return codedError(error.code, safeFindings(error));
  }
  if (error instanceof AgentDraftStoreError) return codedError(error.code);
  if (error instanceof AgentManifestValidationError) {
    if (error.code === "secret_detected") {
      return codedError("organization_publication_dlp_blocked", [
        { code: "secret_detected", path: "agent", line: null },
      ]);
    }
    return codedError(error.code);
  }
  return codedError("operation_failed");
}

function reviewSummary(
  review: OrganizationAgentSubmissionRecord["review"],
): OrganizationAgentSubmissionSummary["review"] {
  if (review === null) return null;
  return {
    id: review.id,
    reviewerUserId: review.reviewer_user_id,
    decision: review.decision,
    reasonCode: review.reason_code,
    safeNote: review.safe_note,
    organizationPolicySnapshotId: review.organization_policy_snapshot_id,
    organizationPolicyVersion: review.organization_policy_version,
    reviewedContentDigest: review.reviewed_content_digest,
    reviewedAt: review.reviewed_at,
  };
}

function summaryFromRecord(
  value: OrganizationAgentSubmissionRecord,
  localReference: TrustedLocalSubmissionReference | null = null,
): OrganizationAgentSubmissionSummary {
  return {
    id: value.id,
    organizationId: value.organization_id,
    kind: value.kind,
    definitionId: value.definition_id,
    baseVersionId: value.base_version_id,
    publishedVersionId: value.published_version_id,
    localDraftId: localReference?.draftId ?? null,
    localDraftRevision: localReference?.draftRevision ?? null,
    submittedByUserId: value.submitted_by_user_id,
    contentDigest: value.content_digest,
    status: value.status,
    revision: value.revision,
    submittedAt: value.submitted_at,
    terminalAt: value.terminal_at,
    review: reviewSummary(value.review),
  };
}

function listItemFromRecord(
  value: OrganizationAgentSubmissionRecord,
  referenceState: SubmissionReferenceState,
): OrganizationAgentSubmissionListItem {
  const localReference =
    referenceState.kind === "verified"
      ? {
          draftId: referenceState.draftId,
          draftRevision: referenceState.draftRevision,
        }
      : null;
  return {
    ...summaryFromRecord(value, localReference),
    referenceState,
  };
}

function localReferenceFromState(
  state: SubmissionReferenceState,
): TrustedLocalSubmissionReference | null {
  return state.kind === "verified"
    ? { draftId: state.draftId, draftRevision: state.draftRevision }
    : null;
}

const ORGANIZATION_SUBMISSION_RECORD_FIELDS = [
  "base_version_id",
  "content_digest",
  "definition_id",
  "id",
  "kind",
  "organization_id",
  "published_version_id",
  "review",
  "revision",
  "status",
  "submitted_at",
  "submitted_by_user_id",
  "terminal_at",
  "updated_at",
] as const;

function hasExactSubmissionRecordFields(
  value: unknown,
): value is OrganizationAgentSubmissionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === ORGANIZATION_SUBMISSION_RECORD_FIELDS.length &&
    ORGANIZATION_SUBMISSION_RECORD_FIELDS.every((field) =>
      Object.hasOwn(value, field),
    )
  );
}

function submissionIssueId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && UUID_PATTERN.test(id) ? id : null;
}

function hasTrustedOrganizationIdentity(
  value: unknown,
  organizationId: string,
): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { organization_id?: unknown }).organization_id === organizationId
  );
}

function validateSubmissionRecord(
  value: OrganizationAgentSubmissionRecord,
  organizationId: string,
  expectedSubmissionId?: string,
): void {
  if (
    requireCanonicalUuid(value.organization_id, "verification_failed") !==
      organizationId ||
    (expectedSubmissionId !== undefined && value.id !== expectedSubmissionId)
  ) {
    throw codedError("verification_failed");
  }
  requireCanonicalUuid(value.id, "verification_failed");
  requireCanonicalUuid(value.definition_id, "verification_failed");
  requireCanonicalUuid(value.submitted_by_user_id, "verification_failed");
  if (value.base_version_id !== null) {
    requireCanonicalUuid(value.base_version_id, "verification_failed");
  }
  if (value.published_version_id !== null) {
    requireCanonicalUuid(value.published_version_id, "verification_failed");
  }
  requireDigest(value.content_digest);
  if (
    (value.kind !== "initial" && value.kind !== "next") ||
    (value.kind === "initial" && value.base_version_id !== null) ||
    (value.kind === "next" && value.base_version_id === null) ||
    (value.status === "approved") !== (value.published_version_id !== null) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isCanonicalTimestamp(value.submitted_at) ||
    !isCanonicalTimestamp(value.updated_at)
  ) {
    throw codedError("verification_failed");
  }
  const terminal = value.status !== "pending";
  if (
    (terminal && !isCanonicalTimestamp(value.terminal_at)) ||
    (!terminal && value.terminal_at !== null) ||
    (value.status === "pending" && value.review !== null) ||
    ((value.status === "withdrawn" || value.status === "superseded") &&
      value.review !== null)
  ) {
    throw codedError("verification_failed");
  }
  if (value.status === "approved" || value.status === "rejected") {
    const review = value.review;
    if (
      review === null ||
      requireCanonicalUuid(review.id, "verification_failed").length === 0 ||
      requireCanonicalUuid(review.reviewer_user_id, "verification_failed")
        .length === 0 ||
      requireCanonicalUuid(
        review.organization_policy_snapshot_id,
        "verification_failed",
      ).length === 0 ||
      !Number.isSafeInteger(review.organization_policy_version) ||
      review.organization_policy_version < 1 ||
      review.reviewed_content_digest !== value.content_digest ||
      !isCanonicalTimestamp(review.reviewed_at) ||
      (value.status === "approved" && review.decision !== "approve") ||
      (value.status === "rejected" && review.decision !== "reject")
    ) {
      throw codedError("verification_failed");
    }
  }
}

function validateListSubmissionRecord(
  value: unknown,
  organizationId: string,
): asserts value is OrganizationAgentSubmissionRecord {
  if (!hasExactSubmissionRecordFields(value)) {
    throw codedError("verification_failed");
  }
  validateSubmissionRecord(value, organizationId);
}

function validateSubmissionDetail(
  value: OrganizationAgentSubmissionDetailRecord,
  organizationId: string,
  expectedSubmissionId?: string,
): void {
  validateSubmissionRecord(value, organizationId, expectedSubmissionId);
  const manifestBytes = canonicalJsonBytes(value.manifest);
  const bundleBytes = canonicalJsonBytes(value.bundle);
  if (
    sha256(manifestBytes) !== requireDigest(value.manifest_digest) ||
    sha256(bundleBytes) !== requireDigest(value.bundle_digest) ||
    combinedDigest(manifestBytes, bundleBytes) !== value.content_digest
  ) {
    throw codedError("verification_failed");
  }
  const hasIconType = value.icon_media_type !== undefined;
  const hasIconData = value.icon_data !== undefined;
  if (
    hasIconType !== hasIconData ||
    (hasIconType &&
      value.icon_media_type !== "image/png" &&
      value.icon_media_type !== "image/webp")
  ) {
    throw codedError("verification_failed");
  }
}

function publicDetail(
  value: OrganizationAgentSubmissionDetailRecord,
  localReference: TrustedLocalSubmissionReference | null = null,
): OrganizationAgentSubmissionDetail {
  return {
    summary: summaryFromRecord(value, localReference),
    displayName: value.display_name ?? null,
    icon:
      value.icon_media_type === undefined
        ? null
        : {
            mediaType: value.icon_media_type,
            dataBase64Url: value.icon_data as string,
          },
    manifest: sortedJsonValue(value.manifest) as typeof value.manifest,
    bundle: sortedJsonValue(value.bundle) as typeof value.bundle,
    manifestDigest: value.manifest_digest,
    bundleDigest: value.bundle_digest,
    assetCounts: assetCountsFromManifest(value.manifest),
    totalBytes: totalBundleBytes(value.bundle),
  };
}

function terminalConflict(
  value: OrganizationAgentSubmissionRecord,
): OrganizationPublicationServiceError {
  return codedError(
    value.status === "superseded"
      ? "organization_submission_superseded"
      : "organization_submission_conflict",
  );
}

export class OrganizationPublicationService {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly drafts: OrganizationPublicationDraftStore | null;
  private readonly client: OrganizationPublicationClient;
  private readonly referenceStore: OrganizationSubmissionReferenceStore;
  private readonly getContext: () => AgenteraAgentControlContext;
  private readonly getActorUserId: () => string;
  private readonly isOnline: () => boolean;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly handleTtlMs: number;
  private readonly submissions = new Map<string, PreparedSubmission>();
  private readonly reviews = new Map<string, PreparedReview>();
  private readonly withdrawals = new Map<string, PreparedWithdrawal>();

  constructor(options: OrganizationPublicationServiceOptions) {
    if (
      typeof options.getContext !== "function" ||
      typeof options.getActorUserId !== "function" ||
      typeof options.isOnline !== "function"
    ) {
      throw new Error("Organization publication service is misconfigured.");
    }
    const ttl = options.handleTtlMs ?? DEFAULT_HANDLE_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 30 * 60 * 1000) {
      throw new Error("Organization publication handle TTL is invalid.");
    }
    this.database = options.database;
    this.drafts = options.drafts ?? null;
    this.client = options.client;
    this.getContext = options.getContext;
    this.getActorUserId = options.getActorUserId;
    this.isOnline = options.isOnline;
    this.now = options.now ?? (() => new Date());
    this.referenceStore = new OrganizationSubmissionReferenceStore({
      database: options.database,
      owner: options.owner,
      now: this.now,
    });
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.handleTtlMs = ttl;
  }

  prepareSubmission(draftIdInput: string): OrganizationSubmissionPreview {
    try {
      const context = this.publisherContext();
      const actor = this.actorUserId();
      const draftId = requireCanonicalUuid(draftIdInput);
      const prepared = this.readPreparedDraft(draftId);
      const handle = this.newHandle(this.submissions);
      const expiresAt = this.nowMilliseconds() + this.handleTtlMs;
      this.submissions.set(handle, {
        contextKey: this.contextKey(context, actor),
        ...prepared,
        expiresAt,
      });
      const assetCounts = { skill: 0, sop: 0, knowledge: 0 };
      for (const asset of prepared.canonical.assets)
        assetCounts[asset.kind] += 1;
      return {
        publicationHandle: handle,
        draftId: prepared.draftId,
        revision: prepared.draftRevision,
        kind:
          prepared.sourceDefinitionId === null &&
          prepared.baseVersionId === null
            ? "initial"
            : "next",
        definitionId: prepared.sourceDefinitionId,
        baseVersionId: prepared.baseVersionId,
        contentDigest: prepared.canonical.contentDigest,
        assetCounts,
        totalBytes: prepared.canonical.assets.reduce(
          (total, asset) => total + asset.sizeBytes,
          0,
        ),
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      throw serviceError(error);
    }
  }

  async submitPrepared(
    input: ConfirmOrganizationSubmissionInput,
  ): Promise<OrganizationAgentSubmissionSummary> {
    let prepared: PreparedSubmission;
    try {
      prepared = this.consumeHandle(this.submissions, input?.publicationHandle);
      if (input.confirmation !== "submit-organization-agent") {
        throw codedError("conflict");
      }
      const context = this.publisherContext();
      const actor = this.actorUserId();
      this.assertOnline();
      const current = this.readPreparedDraft(prepared.draftId);
      if (!this.samePreparedSubmission(prepared, current)) {
        throw codedError("draft_conflict");
      }
      const attempt = this.requireDrafts().beginPublicationAttempt(
        prepared.draftId,
        prepared.draftRevision,
      );
      const response = await this.client.submitOrganizationAgent(
        context.organizationId,
        prepared.request,
        attempt.idempotencyKey,
      );
      validateSubmissionDetail(response, context.organizationId);
      this.assertSubmittedResponse(response, prepared, actor);
      this.recordSubmissionReference(response, prepared);
      const localReference = localReferenceFromState(
        this.referenceStateForRecord(response),
      );
      return summaryFromRecord(response, localReference);
    } catch (error) {
      throw serviceError(error);
    }
  }

  async listSubmissionList(): Promise<OrganizationAgentSubmissionList> {
    try {
      const context = this.historyContext();
      this.assertOnline();
      const values = await this.client.listOrganizationAgentSubmissions(
        context.organizationId,
      );
      const submissions: OrganizationAgentSubmissionListItem[] = [];
      const issues: OrganizationAgentSubmissionList["issues"] = [];
      for (const value of values) {
        if (!hasTrustedOrganizationIdentity(value, context.organizationId)) {
          throw codedError("verification_failed");
        }
        try {
          validateListSubmissionRecord(value, context.organizationId);
        } catch (error) {
          if (
            error instanceof OrganizationPublicationServiceError &&
            error.code === "verification_failed"
          ) {
            issues.push({
              submissionId: submissionIssueId(value),
              code: "cloud_record_invalid",
            });
            continue;
          }
          throw error;
        }
        submissions.push(
          listItemFromRecord(value, this.referenceStateForRecord(value)),
        );
      }
      return { submissions, issues };
    } catch (error) {
      throw serviceError(error);
    }
  }

  async listSubmissions(): Promise<OrganizationAgentSubmissionSummary[]> {
    return (await this.listSubmissionList()).submissions;
  }

  async getSubmission(
    submissionIdInput: string,
  ): Promise<OrganizationAgentSubmissionDetail> {
    try {
      const context = this.historyContext();
      const submissionId = requireCanonicalUuid(submissionIdInput);
      this.assertOnline();
      const value = await this.client.getOrganizationAgentSubmission(
        context.organizationId,
        submissionId,
      );
      validateSubmissionDetail(value, context.organizationId, submissionId);
      const localReference = localReferenceFromState(
        this.referenceStateForRecord(value),
      );
      return publicDetail(value, localReference);
    } catch (error) {
      throw serviceError(error);
    }
  }

  async prepareReview(
    input: PrepareOrganizationReviewInput,
  ): Promise<OrganizationReviewPreview> {
    try {
      const context = this.publisherContext();
      const actor = this.actorUserId();
      const command = this.validateReviewInput(input);
      this.assertOnline();
      const value = await this.client.getOrganizationAgentSubmission(
        context.organizationId,
        command.submissionId,
      );
      validateSubmissionDetail(
        value,
        context.organizationId,
        command.submissionId,
      );
      if (value.status !== "pending") throw terminalConflict(value);
      const localReference = localReferenceFromState(
        this.referenceStateForRecord(value),
      );
      const handle = this.newHandle(this.reviews);
      const expiresAt = this.nowMilliseconds() + this.handleTtlMs;
      this.reviews.set(handle, {
        contextKey: this.contextKey(context, actor),
        submissionId: value.id,
        submissionRevision: value.revision,
        submittedByUserId: value.submitted_by_user_id,
        contentDigest: value.content_digest,
        decision: command.decision,
        reasonCode: command.reasonCode,
        safeNote: command.safeNote,
        expiresAt,
      });
      return {
        reviewHandle: handle,
        selfReview: value.submitted_by_user_id === actor,
        decision: command.decision,
        reasonCode: command.reasonCode,
        safeNote: command.safeNote,
        detail: publicDetail(value, localReference),
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      throw serviceError(error);
    }
  }

  async reviewPrepared(
    input: ConfirmOrganizationReviewInput,
  ): Promise<OrganizationAgentSubmissionSummary> {
    try {
      const prepared = this.consumeHandle(this.reviews, input?.reviewHandle);
      const expectedConfirmation =
        prepared.decision === "approve"
          ? "approve-organization-agent"
          : "reject-organization-agent";
      if (input.confirmation !== expectedConfirmation) {
        throw codedError("conflict");
      }
      const context = this.publisherContext();
      const actor = this.actorUserId();
      this.assertOnline();
      const current = await this.client.getOrganizationAgentSubmission(
        context.organizationId,
        prepared.submissionId,
      );
      validateSubmissionDetail(
        current,
        context.organizationId,
        prepared.submissionId,
      );
      if (current.status !== "pending") throw terminalConflict(current);
      if (
        current.revision !== prepared.submissionRevision ||
        current.content_digest !== prepared.contentDigest ||
        current.submitted_by_user_id !== prepared.submittedByUserId
      ) {
        throw codedError("conflict");
      }
      const body: ReviewOrganizationAgentRequest =
        prepared.decision === "approve"
          ? {
              expected_revision: prepared.submissionRevision,
              decision: "approve",
            }
          : {
              expected_revision: prepared.submissionRevision,
              decision: "reject",
              reason_code: prepared.reasonCode as string,
              ...(prepared.safeNote === null
                ? {}
                : { safe_note: prepared.safeNote }),
            };
      const response = await this.client.reviewOrganizationAgentSubmission(
        context.organizationId,
        prepared.submissionId,
        body,
        this.newIdempotencyKey(),
      );
      validateSubmissionDetail(
        response,
        context.organizationId,
        prepared.submissionId,
      );
      const expectedStatus =
        prepared.decision === "approve" ? "approved" : "rejected";
      if (
        response.status !== expectedStatus ||
        response.content_digest !== prepared.contentDigest ||
        response.review?.reviewer_user_id !== actor
      ) {
        throw codedError("verification_failed");
      }
      const localReference = localReferenceFromState(
        this.referenceStateForRecord(response),
      );
      return summaryFromRecord(response, localReference);
    } catch (error) {
      throw serviceError(error);
    }
  }

  async prepareWithdrawal(
    submissionIdInput: string,
  ): Promise<OrganizationWithdrawalPreview> {
    try {
      const context = this.publisherContext();
      const actor = this.actorUserId();
      const submissionId = requireCanonicalUuid(submissionIdInput);
      this.assertOnline();
      const value = await this.client.getOrganizationAgentSubmission(
        context.organizationId,
        submissionId,
      );
      validateSubmissionDetail(value, context.organizationId, submissionId);
      if (value.status !== "pending") throw terminalConflict(value);
      if (value.submitted_by_user_id !== actor) {
        throw codedError("organization_agent_forbidden");
      }
      const handle = this.newHandle(this.withdrawals);
      const expiresAt = this.nowMilliseconds() + this.handleTtlMs;
      this.withdrawals.set(handle, {
        contextKey: this.contextKey(context, actor),
        submissionId,
        submissionRevision: value.revision,
        submittedByUserId: value.submitted_by_user_id,
        contentDigest: value.content_digest,
        expiresAt,
      });
      const localReference = localReferenceFromState(
        this.referenceStateForRecord(value),
      );
      return {
        withdrawalHandle: handle,
        submission: summaryFromRecord(value, localReference),
        revision: value.revision,
        contentDigest: value.content_digest,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      throw serviceError(error);
    }
  }

  async confirmWithdrawal(
    input: ConfirmOrganizationWithdrawalInput,
  ): Promise<OrganizationAgentSubmissionSummary> {
    try {
      const prepared = this.consumeHandle(
        this.withdrawals,
        input?.withdrawalHandle,
      );
      if (input.confirmation !== "withdraw-organization-agent") {
        throw codedError("conflict");
      }
      const context = this.publisherContext();
      const actor = this.actorUserId();
      this.assertOnline();
      const current = await this.client.getOrganizationAgentSubmission(
        context.organizationId,
        prepared.submissionId,
      );
      validateSubmissionDetail(
        current,
        context.organizationId,
        prepared.submissionId,
      );
      if (current.status !== "pending") throw terminalConflict(current);
      if (
        current.revision !== prepared.submissionRevision ||
        current.content_digest !== prepared.contentDigest ||
        current.submitted_by_user_id !== prepared.submittedByUserId
      ) {
        throw codedError("conflict");
      }
      if (current.submitted_by_user_id !== actor) {
        throw codedError("organization_agent_forbidden");
      }
      const response = await this.client.withdrawOrganizationAgentSubmission(
        context.organizationId,
        prepared.submissionId,
        prepared.submissionRevision,
        this.newIdempotencyKey(),
      );
      validateSubmissionDetail(
        response,
        context.organizationId,
        prepared.submissionId,
      );
      if (
        response.status !== "withdrawn" ||
        response.content_digest !== prepared.contentDigest
      ) {
        throw codedError("verification_failed");
      }
      const localReference = localReferenceFromState(
        this.referenceStateForRecord(response),
      );
      return summaryFromRecord(response, localReference);
    } catch (error) {
      throw serviceError(error);
    }
  }

  invalidate(): void {
    this.submissions.clear();
    this.reviews.clear();
    this.withdrawals.clear();
  }

  private publisherContext(): OrganizationContext {
    const context = this.organizationContext();
    if (context.role !== "owner" && context.role !== "admin") {
      throw codedError("organization_agent_forbidden");
    }
    return context;
  }

  private historyContext(): OrganizationContext {
    const context = this.organizationContext();
    if (context.role === "member") {
      throw codedError("organization_agent_forbidden");
    }
    return context;
  }

  private organizationContext(): OrganizationContext {
    const context = this.getContext();
    if (
      context.scope !== "ORGANIZATION" ||
      (context.role !== "owner" &&
        context.role !== "admin" &&
        context.role !== "auditor" &&
        context.role !== "member")
    ) {
      throw codedError("organization_agent_forbidden");
    }
    return {
      scope: "ORGANIZATION",
      organizationId: requireCanonicalUuid(context.organizationId),
      role: context.role,
    };
  }

  private actorUserId(): string {
    return requireCanonicalUuid(this.getActorUserId());
  }

  private contextKey(context: OrganizationContext, actor: string): string {
    return [context.scope, context.organizationId, context.role, actor].join(
      "\0",
    );
  }

  private currentContextKey(): string {
    return this.contextKey(this.organizationContext(), this.actorUserId());
  }

  private nowMilliseconds(): number {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw codedError("operation_failed");
    }
    return value.getTime();
  }

  private assertOnline(): void {
    if (!this.isOnline()) throw codedError("online_required");
  }

  private newHandle<T>(map: Map<string, T>): string {
    const value = requireCanonicalUuid(this.randomUUID(), "operation_failed");
    if (map.has(value)) throw codedError("conflict");
    return value;
  }

  private newIdempotencyKey(): string {
    return requireCanonicalUuid(this.randomUUID(), "operation_failed");
  }

  private consumeHandle<T extends { contextKey: string; expiresAt: number }>(
    map: Map<string, T>,
    handleInput: unknown,
  ): T {
    const handle =
      typeof handleInput === "string" && UUID_PATTERN.test(handleInput)
        ? handleInput
        : "";
    const value = map.get(handle);
    map.delete(handle);
    let currentKey: string | null = null;
    try {
      currentKey = this.currentContextKey();
    } catch {
      // A context which is no longer Organization is still a stale handle.
    }
    if (
      value === undefined ||
      value.expiresAt <= this.nowMilliseconds() ||
      currentKey === null ||
      value.contextKey !== currentKey
    ) {
      throw codedError("conflict");
    }
    return value;
  }

  private readPreparedDraft(
    draftId: string,
  ): Omit<PreparedSubmission, "contextKey" | "expiresAt"> {
    const drafts = this.requireDrafts();
    const draft = drafts.getDraft(draftId);
    if (
      (draft.sourceAgentDefinitionId === null) !==
      (draft.baseAgentVersionId === null)
    ) {
      throw codedError("invalid_request");
    }
    const sourceDefinitionId =
      draft.sourceAgentDefinitionId === null
        ? null
        : requireCanonicalUuid(draft.sourceAgentDefinitionId);
    const baseVersionId =
      draft.baseAgentVersionId === null
        ? null
        : requireCanonicalUuid(draft.baseAgentVersionId);
    if (
      draft.displayName.length < 1 ||
      draft.displayName.length > 100 ||
      /[\r\n\0]/.test(draft.displayName)
    ) {
      throw codedError("invalid_request");
    }
    const canonical = canonicalizeEditableAgent(
      draft.manifest,
      draft.manifest.assets.map(({ path }) => ({
        path,
        content: drafts.readAsset(draft.id, path).toString("utf8"),
      })),
    );
    const manifest = JSON.parse(
      canonical.manifestBytes.toString("utf8"),
    ) as SubmitOrganizationAgentRequest["manifest"];
    const bundle = JSON.parse(
      canonical.bundleBytes.toString("utf8"),
    ) as SubmitOrganizationAgentRequest["bundle"];
    const request: SubmitOrganizationAgentRequest =
      sourceDefinitionId === null && baseVersionId === null
        ? {
            kind: "initial",
            display_name: draft.displayName,
            manifest,
            bundle,
            ...(draft.icon === null
              ? {}
              : {
                  icon_media_type: draft.icon.mediaType,
                  icon_data: Buffer.from(
                    draft.icon.dataBase64,
                    "base64",
                  ).toString("base64url"),
                }),
          }
        : {
            kind: "next",
            definition_id: sourceDefinitionId as string,
            base_version_id: baseVersionId as string,
            manifest,
            bundle,
          };
    return {
      draftId: draft.id,
      draftRevision: draft.revision,
      sourceDefinitionId,
      baseVersionId,
      displayName: draft.displayName,
      iconMediaType: draft.icon?.mediaType ?? null,
      iconDataBase64: draft.icon?.dataBase64 ?? null,
      canonical,
      request,
    };
  }

  private samePreparedSubmission(
    left: PreparedSubmission,
    right: Omit<PreparedSubmission, "contextKey" | "expiresAt">,
  ): boolean {
    return (
      left.draftId === right.draftId &&
      left.draftRevision === right.draftRevision &&
      left.sourceDefinitionId === right.sourceDefinitionId &&
      left.baseVersionId === right.baseVersionId &&
      left.displayName === right.displayName &&
      left.iconMediaType === right.iconMediaType &&
      left.iconDataBase64 === right.iconDataBase64 &&
      left.canonical.contentDigest === right.canonical.contentDigest &&
      left.canonical.manifestBytes.equals(right.canonical.manifestBytes) &&
      left.canonical.bundleBytes.equals(right.canonical.bundleBytes)
    );
  }

  private requireDrafts(): OrganizationPublicationDraftStore {
    if (this.drafts === null) {
      throw codedError("organization_agent_forbidden");
    }
    return this.drafts;
  }

  private assertSubmittedResponse(
    response: OrganizationAgentSubmissionDetailRecord,
    prepared: PreparedSubmission,
    actor: string,
  ): void {
    const expectedKind =
      prepared.sourceDefinitionId === null ? "initial" : "next";
    if (
      response.kind !== expectedKind ||
      response.base_version_id !== prepared.baseVersionId ||
      response.submitted_by_user_id !== actor ||
      response.content_digest !== prepared.canonical.contentDigest ||
      response.manifest_digest !== prepared.canonical.manifestDigest ||
      response.bundle_digest !== prepared.canonical.bundleDigest ||
      response.status !== "pending" ||
      (prepared.sourceDefinitionId !== null &&
        response.definition_id !== prepared.sourceDefinitionId) ||
      (expectedKind === "initial" &&
        response.display_name !== prepared.displayName)
    ) {
      throw codedError("verification_failed");
    }
  }

  private validateReviewInput(input: PrepareOrganizationReviewInput): {
    submissionId: string;
    decision: "approve" | "reject";
    reasonCode: string | null;
    safeNote: string | null;
  } {
    const submissionId = requireCanonicalUuid(input?.submissionId);
    if (input.decision === "approve") {
      if (input.reasonCode !== null || input.safeNote !== null) {
        throw codedError("invalid_request");
      }
      return {
        submissionId,
        decision: "approve",
        reasonCode: null,
        safeNote: null,
      };
    }
    if (
      input.decision !== "reject" ||
      typeof input.reasonCode !== "string" ||
      !REASON_CODE_PATTERN.test(input.reasonCode) ||
      (input.safeNote !== null &&
        (typeof input.safeNote !== "string" ||
          input.safeNote.length < 1 ||
          input.safeNote.length > 500 ||
          /[\r\n\0]/.test(input.safeNote)))
    ) {
      throw codedError("invalid_request");
    }
    return {
      submissionId,
      decision: "reject",
      reasonCode: input.reasonCode,
      safeNote: input.safeNote,
    };
  }

  private recordSubmissionReference(
    response: OrganizationAgentSubmissionDetailRecord,
    prepared: PreparedSubmission,
  ): void {
    const existing = this.database.sqlite
      .prepare(
        `SELECT cloud_submission_id, content_digest
         FROM organization_agent_submission_refs
         WHERE local_draft_id = ? AND local_draft_revision = ?
           AND organization_id = ?`,
      )
      .get(
        prepared.draftId,
        prepared.draftRevision,
        response.organization_id,
      ) as
      | { cloud_submission_id?: unknown; content_digest?: unknown }
      | undefined;
    if (
      existing !== undefined &&
      (existing.cloud_submission_id !== response.id ||
        existing.content_digest !== response.content_digest)
    ) {
      throw codedError("conflict");
    }
    const verifiedAt = new Date(this.nowMilliseconds()).toISOString();
    this.database.sqlite
      .prepare(
        `INSERT INTO organization_agent_submission_refs (
           local_draft_id, local_draft_revision, organization_id,
           cloud_submission_id, content_digest, cloud_status, cloud_revision,
           submitted_at, last_verified_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_draft_id, local_draft_revision, organization_id)
         DO UPDATE SET cloud_status = excluded.cloud_status,
                       cloud_revision = excluded.cloud_revision,
                       last_verified_at = excluded.last_verified_at`,
      )
      .run(
        prepared.draftId,
        prepared.draftRevision,
        response.organization_id,
        response.id,
        response.content_digest,
        response.status,
        response.revision,
        response.submitted_at,
        verifiedAt,
      );
  }

  private referenceStateForRecord(
    response: OrganizationAgentSubmissionRecord,
  ): SubmissionReferenceState {
    try {
      return this.reconcileSubmissionReference(response);
    } catch (error) {
      if (!(error instanceof LocalSubmissionReferenceConflict)) throw error;
      this.referenceStore.quarantine({
        organizationId: response.organization_id,
        submissionId: response.id,
        stage: error.stage,
        referenceRevision: error.referenceRevision,
      });
      return { kind: "quarantined", stage: error.stage };
    }
  }

  private reconcileSubmissionReference(
    response: OrganizationAgentSubmissionRecord,
  ): SubmissionReferenceState {
    const reference = this.readSubmissionReference(response);
    if (reference === null || this.drafts === null) {
      return { kind: "remote_only" };
    }
    const referenceRevision = this.referenceRevision(reference.cloud_revision);
    if (
      typeof reference.local_draft_id !== "string" ||
      !UUID_PATTERN.test(reference.local_draft_id)
    ) {
      return { kind: "remote_only" };
    }

    let draft: AgentDraft;
    try {
      draft = this.drafts.getDraft(reference.local_draft_id);
    } catch (error) {
      if (
        error instanceof AgentDraftStoreError &&
        (error.code === "draft_not_found" || error.code === "invalid_draft")
      ) {
        return { kind: "remote_only" };
      }
      throw new LocalSubmissionReferenceConflict(
        "draft_publication",
        referenceRevision,
      );
    }

    const draftRevision = this.localDraftRevision(
      reference.local_draft_revision,
      referenceRevision,
    );
    if (
      typeof reference.content_digest !== "string" ||
      !DIGEST_PATTERN.test(reference.content_digest)
    ) {
      throw new LocalSubmissionReferenceConflict(
        "reference_shape",
        referenceRevision,
      );
    }
    if (reference.content_digest !== response.content_digest) {
      throw new LocalSubmissionReferenceConflict(
        "content_digest",
        referenceRevision,
      );
    }
    if (
      draft.sourceAgentDefinitionId !== null &&
      draft.sourceAgentDefinitionId !== response.definition_id
    ) {
      throw new LocalSubmissionReferenceConflict(
        "definition",
        referenceRevision,
      );
    }
    if (
      response.status === "approved" &&
      draft.publishedRevision?.revision === draftRevision &&
      (draft.publishedRevision.definitionId !== response.definition_id ||
        draft.publishedRevision.versionId !== response.published_version_id)
    ) {
      throw new LocalSubmissionReferenceConflict(
        "published_version",
        referenceRevision,
      );
    }

    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readSubmissionReference(response);
      if (
        current === null ||
        current.local_draft_id !== reference.local_draft_id ||
        current.local_draft_revision !== reference.local_draft_revision ||
        current.content_digest !== reference.content_digest ||
        current.cloud_revision !== reference.cloud_revision
      ) {
        throw new LocalSubmissionReferenceConflict(
          "compare_and_set",
          referenceRevision,
        );
      }
      if (response.status === "approved") {
        if (response.published_version_id === null) {
          throw codedError("verification_failed");
        }
        try {
          this.drafts.recordPublishedRevision({
            id: reference.local_draft_id,
            publishedRevision: draftRevision,
            definitionId: response.definition_id,
            versionId: response.published_version_id,
          });
        } catch {
          throw new LocalSubmissionReferenceConflict(
            "draft_publication",
            referenceRevision,
          );
        }
      }
      const result = this.database.sqlite
        .prepare(
          `UPDATE organization_agent_submission_refs
           SET cloud_status = ?, cloud_revision = ?, last_verified_at = ?
           WHERE local_draft_id = ? AND local_draft_revision = ?
             AND organization_id = ? AND cloud_submission_id = ?
             AND content_digest = ? AND cloud_revision = ?`,
        )
        .run(
          response.status,
          response.revision,
          new Date(this.nowMilliseconds()).toISOString(),
          reference.local_draft_id,
          draftRevision,
          response.organization_id,
          response.id,
          response.content_digest,
          referenceRevision,
        );
      if (Number(result.changes) !== 1) {
        throw new LocalSubmissionReferenceConflict(
          "compare_and_set",
          referenceRevision,
        );
      }
      this.database.sqlite.exec("COMMIT");
    } catch (error) {
      try {
        this.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the bounded reconciliation error.
      }
      throw error;
    }
    this.referenceStore.clear(response.organization_id, response.id);
    return {
      kind: "verified",
      draftId: reference.local_draft_id,
      draftRevision,
    };
  }

  private readSubmissionReference(
    response: OrganizationAgentSubmissionRecord,
  ): {
    local_draft_id?: unknown;
    local_draft_revision?: unknown;
    content_digest?: unknown;
    cloud_revision?: unknown;
  } | null {
    const row = this.database.sqlite
      .prepare(
        `SELECT local_draft_id, local_draft_revision,
                content_digest, cloud_revision
         FROM organization_agent_submission_refs
         WHERE organization_id = ? AND cloud_submission_id = ?`,
      )
      .get(response.organization_id, response.id) as
      | {
          local_draft_id?: unknown;
          local_draft_revision?: unknown;
          content_digest?: unknown;
          cloud_revision?: unknown;
        }
      | undefined;
    return row ?? null;
  }

  private referenceRevision(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
      throw codedError("organization_submission_conflict");
    }
    return Number(value);
  }

  private localDraftRevision(
    value: unknown,
    referenceRevision: number,
  ): number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
      throw new LocalSubmissionReferenceConflict(
        "reference_shape",
        referenceRevision,
      );
    }
    return Number(value);
  }
}
