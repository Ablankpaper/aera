import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  AgenteraAgentControlContext,
  ExperienceCandidateBundleV1,
  ExperienceCandidateDetail,
  ExperienceCandidateFinding,
  ExperienceCandidatePreview,
  ExperienceCandidateSummary,
  PrepareExperienceCandidateInput,
  ReviewExperienceCandidateInput,
  SubmitExperienceCandidateInput,
} from "../../shared/agentera-agent-control";
import {
  AgenteraAgentControlClientError,
  type AgenteraAgentControlClient,
  type CloudExperienceCandidateBundle,
  type CloudExperienceCandidateDetail,
  type CloudExperienceCandidateFinding,
  type CloudExperienceCandidateReview,
  type CloudExperienceCandidateSummary,
  type ReviewExperienceCandidateRequest,
  type SubmitExperienceCandidateRequest,
} from "./client";
import {
  canonicalizeExperienceCandidate,
  scanExperienceCandidate,
} from "./experience-candidate-contract";
import {
  ExperienceCandidateStoreError,
  type ExperienceCandidateStore,
  type LocalExperienceCandidate,
} from "./experience-candidate-store";
import {
  HermesSkillCandidateSourceError,
  type EligibleExperienceSkill,
  type HermesSkillCandidateSource,
} from "./hermes-skill-candidate-source";
import type { LocalAgentInstallation } from "./installation-manager";

export type {
  PrepareExperienceCandidateInput,
  ReviewExperienceCandidateInput,
  SubmitExperienceCandidateInput,
} from "../../shared/agentera-agent-control";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TRANSIENT_CLIENT_CODES = new Set([
  "network_unavailable",
  "request_timeout",
  "response_too_large",
  "invalid_response",
  "request_failed",
  "service_unavailable",
]);
const DETERMINISTIC_CLIENT_CODES = new Set([
  "invalid_request",
  "invalid_experience_candidate",
  "candidate_dlp_blocked",
  "candidate_already_reviewed",
  "idempotency_conflict",
  "definition_archived",
  "workspace_forbidden",
  "not_found",
  "workspace_archived",
  "workspace_owner_unavailable",
]);

export interface ExperienceCandidateServiceOptions {
  client: AgenteraAgentControlClient;
  store: ExperienceCandidateStore;
  source: HermesSkillCandidateSource;
  getInstallation: (id: string) => LocalAgentInstallation;
  resolveProfilePath: (profileId: string) => string;
  getContext: () => AgenteraAgentControlContext;
  getAuthState: () => AgenteraAuthPublicState;
  now?: () => Date;
  randomUUID?: () => string;
}

export type ExperienceCandidateServiceErrorCode =
  | "invalid_request"
  | "sign_in_required"
  | "online_required"
  | "workspace_forbidden"
  | "candidate_source_ineligible"
  | "candidate_dlp_blocked"
  | "candidate_not_found"
  | "candidate_conflict"
  | "cloud_unavailable"
  | "verification_failed"
  | "invalid_experience_candidate"
  | "candidate_already_reviewed"
  | "idempotency_conflict"
  | "definition_archived"
  | "not_found"
  | "workspace_archived"
  | "workspace_owner_unavailable";

export class ExperienceCandidateServiceError extends Error {
  readonly code: ExperienceCandidateServiceErrorCode;
  readonly findings: readonly ExperienceCandidateFinding[];

  constructor(
    code: ExperienceCandidateServiceErrorCode,
    findings: readonly ExperienceCandidateFinding[] = [],
  ) {
    super(`ExperienceCandidate operation failed: ${code}.`);
    this.name = "ExperienceCandidateServiceError";
    this.code = code;
    this.findings = findings.map((finding) => ({
      code: finding.code,
      path: finding.path,
      line: finding.line,
    }));
  }
}

function serviceError(
  code: ExperienceCandidateServiceErrorCode,
  findings: readonly ExperienceCandidateFinding[] = [],
): never {
  throw new ExperienceCandidateServiceError(code, findings);
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return serviceError("invalid_request");
  }
  return value.toLowerCase();
}

function boundedSafeNote(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 240 &&
    !/[\r\n\0]/.test(value)
  );
}

function toCloudBundle(
  bundle: ExperienceCandidateBundleV1,
): CloudExperienceCandidateBundle {
  return {
    schema_version: 1,
    skill_name: bundle.skillName,
    assets: bundle.assets.map((asset) => ({
      path: asset.path,
      media_type: asset.mediaType,
      content: asset.content,
    })),
  };
}

function fromCloudBundle(
  bundle: CloudExperienceCandidateBundle,
): ExperienceCandidateBundleV1 {
  return {
    schemaVersion: 1,
    skillName: bundle.skill_name,
    assets: bundle.assets.map((asset) => ({
      path: asset.path,
      mediaType: asset.media_type,
      content: asset.content,
    })),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cloudFindings(
  findings: readonly CloudExperienceCandidateFinding[],
): ExperienceCandidateFinding[] {
  return findings.map((finding) => ({
    code: finding.code,
    path: finding.path,
    line: finding.line ?? null,
  }));
}

function reviewStatus(
  review: CloudExperienceCandidateReview | undefined,
): "PENDING_REVIEW" | "APPROVED" | "REJECTED" {
  return review?.decision ?? "PENDING_REVIEW";
}

function localSummary(
  local: LocalExperienceCandidate,
): ExperienceCandidateSummary {
  return {
    localCandidateId: local.id,
    cloudCandidateId: local.cloudCandidateId,
    agentDefinitionId: local.agentDefinitionId,
    sourceAgentVersionId: local.sourceAgentVersionId,
    skillName: local.skillName,
    contentDigest: local.contentDigest,
    localStatus: local.status,
    reviewStatus: null,
    lastErrorCode: local.lastErrorCode,
    createdAt: local.createdAt,
    reviewedAt: null,
  };
}

function mergedSummary(
  cloud: CloudExperienceCandidateSummary,
  local: LocalExperienceCandidate | null,
): ExperienceCandidateSummary {
  return {
    localCandidateId: local?.id ?? null,
    cloudCandidateId: cloud.id,
    agentDefinitionId: cloud.agent_definition_id,
    sourceAgentVersionId: cloud.source_agent_version_id,
    skillName: cloud.skill_name,
    contentDigest: cloud.content_digest,
    localStatus: local?.status ?? null,
    reviewStatus: reviewStatus(cloud.review),
    lastErrorCode: local?.lastErrorCode ?? null,
    createdAt: cloud.created_at,
    reviewedAt: cloud.review?.reviewed_at ?? null,
  };
}

function cloudDetail(
  cloud: CloudExperienceCandidateDetail,
  local: LocalExperienceCandidate | null,
): ExperienceCandidateDetail {
  return {
    ...mergedSummary(cloud, local),
    bundle: fromCloudBundle(cloud.bundle),
    decisionReasonCode: cloud.review?.reason_code ?? null,
    safeNote: cloud.review?.safe_note ?? null,
  };
}

function matchesLocalCandidate(
  cloud: CloudExperienceCandidateSummary,
  local: LocalExperienceCandidate,
): boolean {
  return (
    cloud.workspace_id === local.workspaceId &&
    cloud.agent_definition_id === local.agentDefinitionId &&
    cloud.source_agent_version_id === local.sourceAgentVersionId &&
    cloud.skill_name === local.skillName &&
    cloud.content_digest === local.contentDigest
  );
}

function mapStoreError(error: ExperienceCandidateStoreError): never {
  if (error.code === "candidate_not_found") {
    return serviceError("candidate_not_found");
  }
  if (
    error.code === "candidate_conflict" ||
    error.code === "mutation_conflict"
  ) {
    return serviceError("candidate_conflict");
  }
  return serviceError("invalid_request");
}

function mapClientError(error: AgenteraAgentControlClientError): never {
  if (error.code === "session_revoked") return serviceError("sign_in_required");
  if (TRANSIENT_CLIENT_CODES.has(error.code) || error.status >= 500) {
    return serviceError("cloud_unavailable");
  }
  if (error.code === "candidate_dlp_blocked") {
    return serviceError("candidate_dlp_blocked", cloudFindings(error.findings));
  }
  if (DETERMINISTIC_CLIENT_CODES.has(error.code)) {
    return serviceError(error.code as ExperienceCandidateServiceErrorCode);
  }
  return serviceError("cloud_unavailable");
}

export class ExperienceCandidateService {
  private readonly options: ExperienceCandidateServiceOptions;
  private readonly randomUUID: () => string;

  constructor(options: ExperienceCandidateServiceOptions) {
    this.options = options;
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  listEligibleSkills(installationId: string): EligibleExperienceSkill[] {
    this.assertLocalAccess();
    const { profilePath } = this.resolveEligibleInstallation(
      requireUuid(installationId),
    );
    try {
      return this.options.source.listEligible(profilePath).map((skill) => ({
        skillName: skill.skillName,
        description: skill.description,
      }));
    } catch (error) {
      if (error instanceof HermesSkillCandidateSourceError) {
        return serviceError("candidate_source_ineligible");
      }
      return serviceError("candidate_source_ineligible");
    }
  }

  prepare(input: PrepareExperienceCandidateInput): ExperienceCandidatePreview {
    this.assertLocalAccess();
    if (
      input === null ||
      typeof input !== "object" ||
      !SKILL_NAME_PATTERN.test(input.skillName)
    ) {
      return serviceError("invalid_request");
    }
    const { installation, context, profilePath } =
      this.resolveEligibleInstallation(requireUuid(input.installationId));
    let read;
    try {
      read = this.options.source.readCandidate(profilePath, input.skillName);
    } catch {
      return serviceError("candidate_source_ineligible");
    }
    let canonical;
    try {
      canonical = canonicalizeExperienceCandidate(read.bundle);
    } catch {
      return serviceError("candidate_source_ineligible");
    }
    const findings = scanExperienceCandidate(canonical);
    if (findings.length > 0) {
      return serviceError("candidate_dlp_blocked", findings);
    }
    let local: LocalExperienceCandidate;
    try {
      local = this.options.store.prepare({
        id: requireUuid(this.randomUUID()),
        agentInstallationId: installation.agentInstallationId,
        workspaceId: context.workspaceId,
        agentDefinitionId: installation.definitionId,
        sourceAgentVersionId: installation.selectedVersionId,
        runtimeProfileId: installation.runtimeProfileId!,
        skillName: canonical.bundle.skillName,
        sourceRelativePath: read.sourceRelativePath,
        canonical,
      });
    } catch (error) {
      if (error instanceof ExperienceCandidateStoreError)
        return mapStoreError(error);
      return serviceError("candidate_conflict");
    }
    const assets = canonical.bundle.assets.map((asset) => ({
      path: asset.path,
      mediaType: asset.mediaType,
      sizeBytes: Buffer.byteLength(asset.content, "utf8"),
    }));
    return {
      localCandidateId: local.id,
      installationId: local.agentInstallationId,
      sourceAgentVersionId: local.sourceAgentVersionId,
      skillName: local.skillName,
      assets,
      fileCount: assets.length,
      totalBytes: assets.reduce((total, asset) => total + asset.sizeBytes, 0),
      contentDigest: local.contentDigest,
      findings: [],
    };
  }

  async submit(
    input: SubmitExperienceCandidateInput,
  ): Promise<ExperienceCandidateSummary> {
    if (
      input === null ||
      typeof input !== "object" ||
      input.confirmation !== "submit-selected-skill"
    ) {
      return serviceError("invalid_request");
    }
    const context = this.requireOnlineWorkspace();
    const candidateId = requireUuid(input.candidateId);
    let local: LocalExperienceCandidate;
    let canonical;
    try {
      local = this.options.store.get(candidateId);
      if (
        local.workspaceId !== context.workspaceId ||
        local.status === "SUBMITTED"
      ) {
        return serviceError("candidate_conflict");
      }
      canonical = this.options.store.readSnapshot(candidateId);
    } catch (error) {
      if (error instanceof ExperienceCandidateServiceError) throw error;
      if (error instanceof ExperienceCandidateStoreError)
        return mapStoreError(error);
      return serviceError("candidate_conflict");
    }
    const request: SubmitExperienceCandidateRequest = {
      source_version_id: local.sourceAgentVersionId,
      bundle: toCloudBundle(canonical.bundle),
      content_digest: canonical.contentDigest,
    };
    const requestHash = sha256(JSON.stringify(request));
    let intent;
    try {
      intent = this.options.store.getOrCreateMutationIntent(
        "SUBMIT",
        candidateId,
        requestHash,
      );
    } catch (error) {
      if (error instanceof ExperienceCandidateStoreError)
        return mapStoreError(error);
      return serviceError("candidate_conflict");
    }
    let cloud: CloudExperienceCandidateDetail;
    try {
      cloud = await this.options.client.submitExperienceCandidate(
        context.workspaceId,
        local.agentDefinitionId,
        request,
        intent.idempotencyKey,
      );
      this.assertSubmittedCloudMatches(cloud, local, canonical.bundle);
    } catch (error) {
      if (error instanceof ExperienceCandidateServiceError) {
        this.markAmbiguousSubmission(local.id);
        throw error;
      }
      if (error instanceof AgenteraAgentControlClientError) {
        if (TRANSIENT_CLIENT_CODES.has(error.code) || error.status >= 500) {
          this.markAmbiguousSubmission(local.id);
          return mapClientError(error);
        }
        this.options.store.completeMutationIntent(intent.idempotencyKey);
        this.markDeterministicSubmission(local.id, error.code);
        return mapClientError(error);
      }
      this.markAmbiguousSubmission(local.id);
      return serviceError("cloud_unavailable");
    }
    let submitted: LocalExperienceCandidate;
    try {
      submitted = this.options.store.markSubmitted(local.id, cloud.id);
      this.options.store.completeMutationIntent(intent.idempotencyKey);
    } catch (error) {
      if (error instanceof ExperienceCandidateStoreError)
        return mapStoreError(error);
      return serviceError("candidate_conflict");
    }
    return mergedSummary(cloud, submitted);
  }

  async listMine(): Promise<ExperienceCandidateSummary[]> {
    const context = this.requireWorkspaceContext();
    this.assertLocalAccess();
    const locals = this.options.store.listForContext(context.workspaceId);
    if (!this.online()) return locals.map(localSummary);
    let clouds: CloudExperienceCandidateSummary[];
    try {
      clouds = await this.options.client.listOwnExperienceCandidates(
        context.workspaceId,
      );
    } catch {
      return locals.map(localSummary);
    }
    const localByCloud = new Map(
      locals
        .filter((candidate) => candidate.cloudCandidateId !== null)
        .map((candidate) => [candidate.cloudCandidateId!, candidate]),
    );
    const merged: ExperienceCandidateSummary[] = [];
    const consumed = new Set<string>();
    for (const cloud of clouds) {
      const local = localByCloud.get(cloud.id) ?? null;
      if (local !== null && !matchesLocalCandidate(cloud, local)) continue;
      if (local !== null) consumed.add(local.id);
      merged.push(mergedSummary(cloud, local));
    }
    for (const local of locals) {
      if (!consumed.has(local.id)) merged.push(localSummary(local));
    }
    return merged;
  }

  async listReviewQueue(): Promise<ExperienceCandidateSummary[]> {
    const context = this.requireReviewer();
    try {
      const candidates =
        await this.options.client.listWorkspaceExperienceCandidates(
          context.workspaceId,
        );
      return candidates.map((candidate) => mergedSummary(candidate, null));
    } catch (error) {
      if (error instanceof AgenteraAgentControlClientError)
        return mapClientError(error);
      return serviceError("cloud_unavailable");
    }
  }

  async get(candidateIdInput: string): Promise<ExperienceCandidateDetail> {
    const context = this.requireOnlineWorkspace();
    const candidateId = requireUuid(candidateIdInput);
    try {
      const candidate = await this.options.client.getExperienceCandidate(
        context.workspaceId,
        candidateId,
      );
      const local = this.localForCloud(context.workspaceId, candidate.id);
      return cloudDetail(candidate, local);
    } catch (error) {
      if (error instanceof AgenteraAgentControlClientError)
        return mapClientError(error);
      return serviceError("cloud_unavailable");
    }
  }

  async review(
    input: ReviewExperienceCandidateInput,
  ): Promise<ExperienceCandidateDetail> {
    const context = this.requireReviewer();
    const candidateId = requireUuid(input.candidateId);
    const request = this.reviewRequest(input);
    const requestHash = sha256(JSON.stringify(request));
    let intent;
    try {
      intent = this.options.store.getOrCreateMutationIntent(
        "REVIEW",
        candidateId,
        requestHash,
      );
    } catch (error) {
      if (
        error instanceof ExperienceCandidateStoreError &&
        error.code === "mutation_conflict"
      ) {
        return this.adoptTerminalReview(context.workspaceId, candidateId);
      }
      if (error instanceof ExperienceCandidateStoreError)
        return mapStoreError(error);
      return serviceError("candidate_conflict");
    }
    try {
      const reviewed = await this.options.client.reviewExperienceCandidate(
        context.workspaceId,
        candidateId,
        request,
        intent.idempotencyKey,
      );
      if (
        reviewed.id !== candidateId ||
        reviewed.workspace_id !== context.workspaceId ||
        reviewed.review?.decision !== input.decision
      ) {
        return serviceError("verification_failed");
      }
      this.options.store.completeMutationIntent(intent.idempotencyKey);
      return cloudDetail(
        reviewed,
        this.localForCloud(context.workspaceId, reviewed.id),
      );
    } catch (error) {
      if (error instanceof ExperienceCandidateServiceError) throw error;
      if (error instanceof AgenteraAgentControlClientError) {
        if (error.code === "candidate_already_reviewed") {
          this.options.store.completeMutationIntent(intent.idempotencyKey);
          return this.adoptTerminalReview(context.workspaceId, candidateId);
        }
        if (!TRANSIENT_CLIENT_CODES.has(error.code) && error.status < 500) {
          this.options.store.completeMutationIntent(intent.idempotencyKey);
        }
        return mapClientError(error);
      }
      return serviceError("cloud_unavailable");
    }
  }

  private assertLocalAccess(): void {
    const state = this.options.getAuthState();
    if (state.status !== "authenticated" && state.status !== "offline") {
      return serviceError("sign_in_required");
    }
  }

  private online(): boolean {
    const state = this.options.getAuthState();
    return state.status === "authenticated" && state.cloudAvailable;
  }

  private requireWorkspaceContext(): Extract<
    AgenteraAgentControlContext,
    { scope: "WORKSPACE" }
  > {
    const context = this.options.getContext();
    if (
      context.scope !== "WORKSPACE" ||
      !UUID_PATTERN.test(context.workspaceId) ||
      (context.role !== "owner" &&
        context.role !== "admin" &&
        context.role !== "member")
    ) {
      return serviceError("workspace_forbidden");
    }
    return {
      scope: "WORKSPACE",
      workspaceId: context.workspaceId.toLowerCase(),
      role: context.role,
    };
  }

  private requireOnlineWorkspace(): Extract<
    AgenteraAgentControlContext,
    { scope: "WORKSPACE" }
  > {
    this.assertLocalAccess();
    const context = this.requireWorkspaceContext();
    if (!this.online()) return serviceError("online_required");
    return context;
  }

  private requireReviewer(): Extract<
    AgenteraAgentControlContext,
    { scope: "WORKSPACE" }
  > {
    const context = this.requireOnlineWorkspace();
    if (context.role === "member") return serviceError("workspace_forbidden");
    return context;
  }

  private resolveEligibleInstallation(installationId: string): {
    installation: LocalAgentInstallation;
    context: Extract<AgenteraAgentControlContext, { scope: "WORKSPACE" }>;
    profilePath: string;
  } {
    const context = this.requireWorkspaceContext();
    let installation: LocalAgentInstallation;
    try {
      installation = this.options.getInstallation(installationId);
    } catch {
      return serviceError("candidate_source_ineligible");
    }
    if (
      installation.agentInstallationId !== installationId ||
      installation.status !== "active" ||
      installation.sourceScope !== "WORKSPACE" ||
      installation.sourceWorkspaceId !== context.workspaceId ||
      installation.runtimeProfileId === null
    ) {
      return serviceError("candidate_source_ineligible");
    }
    let profilePath: string;
    try {
      profilePath = this.options.resolveProfilePath(
        installation.runtimeProfileId,
      );
    } catch {
      return serviceError("candidate_source_ineligible");
    }
    if (typeof profilePath !== "string" || profilePath.length === 0) {
      return serviceError("candidate_source_ineligible");
    }
    return { installation, context, profilePath };
  }

  private assertSubmittedCloudMatches(
    cloud: CloudExperienceCandidateDetail,
    local: LocalExperienceCandidate,
    bundle: ExperienceCandidateBundleV1,
  ): void {
    if (
      cloud.workspace_id !== local.workspaceId ||
      cloud.agent_definition_id !== local.agentDefinitionId ||
      cloud.source_agent_version_id !== local.sourceAgentVersionId ||
      cloud.skill_name !== local.skillName ||
      cloud.content_digest !== local.contentDigest ||
      JSON.stringify(fromCloudBundle(cloud.bundle)) !== JSON.stringify(bundle)
    ) {
      return serviceError("verification_failed");
    }
  }

  private markAmbiguousSubmission(candidateId: string): void {
    try {
      this.options.store.markUploadFailed(candidateId, "cloud_unavailable");
    } catch {
      // The original error remains authoritative; snapshot bytes are untouched.
    }
  }

  private markDeterministicSubmission(candidateId: string, code: string): void {
    const bounded = /^[a-z][a-z0-9_]{0,63}$/.test(code)
      ? code
      : "request_failed";
    try {
      this.options.store.markPreparedWithError(candidateId, bounded);
    } catch {
      // The deterministic cloud response remains authoritative.
    }
  }

  private localForCloud(
    workspaceId: string,
    cloudCandidateId: string,
  ): LocalExperienceCandidate | null {
    return (
      this.options.store
        .listForContext(workspaceId)
        .find((candidate) => candidate.cloudCandidateId === cloudCandidateId) ??
      null
    );
  }

  private reviewRequest(
    input: ReviewExperienceCandidateInput,
  ): ReviewExperienceCandidateRequest {
    if (input.decision === "APPROVED") {
      if (input.reasonCode !== null || input.safeNote !== null) {
        return serviceError("invalid_request");
      }
      return { decision: "APPROVED" };
    }
    if (
      input.decision !== "REJECTED" ||
      typeof input.reasonCode !== "string" ||
      !REASON_CODE_PATTERN.test(input.reasonCode) ||
      (input.safeNote !== null && !boundedSafeNote(input.safeNote))
    ) {
      return serviceError("invalid_request");
    }
    return {
      decision: "REJECTED",
      reason_code: input.reasonCode,
      ...(input.safeNote === null ? {} : { safe_note: input.safeNote }),
    };
  }

  private async adoptTerminalReview(
    workspaceId: string,
    candidateId: string,
  ): Promise<ExperienceCandidateDetail> {
    try {
      const current = await this.options.client.getExperienceCandidate(
        workspaceId,
        candidateId,
      );
      if (current.review === undefined)
        return serviceError("candidate_conflict");
      return cloudDetail(current, this.localForCloud(workspaceId, current.id));
    } catch (error) {
      if (error instanceof ExperienceCandidateServiceError) throw error;
      if (error instanceof AgenteraAgentControlClientError)
        return mapClientError(error);
      return serviceError("cloud_unavailable");
    }
  }
}
