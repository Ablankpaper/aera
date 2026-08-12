import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  AgentDraftDetail,
  AgenteraAgentControlContext,
  ConfirmOrganizationExperienceCandidateImportInput,
  ExperienceCandidateBundleV1,
  ExperienceCandidateFinding,
  OrganizationExperienceCandidateDetail,
  OrganizationExperienceCandidateImportPreview,
  OrganizationExperienceCandidatePreview,
  OrganizationExperienceCandidateSummary,
  ReviewOrganizationExperienceCandidateInput,
  SubmitOrganizationExperienceCandidateInput,
} from "../../shared/agentera-agent-control";
import {
  AgenteraAgentControlClientError,
  type AgenteraAgentControlClient,
  type CloudExperienceCandidateBundle,
  type CloudExperienceCandidateFinding,
  type CloudExperienceCandidateReview,
  type CloudOrganizationExperienceCandidateDetail,
  type CloudOrganizationExperienceCandidateSummary,
  type ReviewExperienceCandidateRequest,
  type SubmitOrganizationExperienceCandidateRequest,
} from "./client";
import {
  EXPERIENCE_CANDIDATE_DLP_VERSION,
  canonicalizeExperienceCandidate,
  scanExperienceCandidate,
} from "./experience-candidate-contract";
import {
  OrganizationExperienceCandidateStoreError,
  type OrganizationExperienceCandidateStore,
} from "./organization-experience-candidate-store";
import {
  HermesSkillCandidateSourceError,
  type EligibleExperienceSkill,
  type HermesSkillCandidateSource,
} from "./hermes-skill-candidate-source";
import type { LocalAgentInstallation } from "./installation-manager";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TRANSIENT_CODES = new Set([
  "network_unavailable",
  "request_timeout",
  "response_too_large",
  "invalid_response",
  "request_failed",
  "service_unavailable",
]);

export interface OrganizationExperienceCandidateImportOrchestrator {
  prepare(
    organizationId: string,
    candidateId: string,
  ): Promise<OrganizationExperienceCandidateImportPreview>;
  confirm(
    organizationId: string,
    input: ConfirmOrganizationExperienceCandidateImportInput,
  ): Promise<AgentDraftDetail>;
  clearPreparedImports(): void;
}

export interface OrganizationExperienceCandidateServiceOptions {
  client: AgenteraAgentControlClient;
  store: OrganizationExperienceCandidateStore;
  source: HermesSkillCandidateSource;
  getInstallation: (id: string) => LocalAgentInstallation;
  resolveProfilePath: (
    runtimeProfileId: string,
    agentInstallationId: string,
  ) => string;
  getContext: () => AgenteraAgentControlContext;
  getAuthState: () => AgenteraAuthPublicState;
  importer: OrganizationExperienceCandidateImportOrchestrator;
  now?: () => Date;
  randomUUID?: () => string;
}

export type OrganizationExperienceCandidateServiceErrorCode =
  | "invalid_request"
  | "sign_in_required"
  | "online_required"
  | "organization_agent_forbidden"
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
  | "organization_agent_not_found"
  | "organization_archived";

export class OrganizationExperienceCandidateServiceError extends Error {
  readonly code: OrganizationExperienceCandidateServiceErrorCode;
  readonly findings: readonly ExperienceCandidateFinding[];

  constructor(
    code: OrganizationExperienceCandidateServiceErrorCode,
    findings: readonly ExperienceCandidateFinding[] = [],
  ) {
    super(`Organization ExperienceCandidate operation failed: ${code}.`);
    this.name = "OrganizationExperienceCandidateServiceError";
    this.code = code;
    this.findings = findings.map((finding) => ({ ...finding }));
  }
}

function serviceError(
  code: OrganizationExperienceCandidateServiceErrorCode,
  findings: readonly ExperienceCandidateFinding[] = [],
): never {
  throw new OrganizationExperienceCandidateServiceError(code, findings);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return serviceError("invalid_request");
  }
  return value.toLowerCase();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

function findings(
  value: readonly CloudExperienceCandidateFinding[],
): ExperienceCandidateFinding[] {
  return value.map((finding) => ({
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

function boundedSafeNote(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 240 &&
    !/[\r\n\0]/.test(value)
  );
}

export class OrganizationExperienceCandidateService {
  private readonly options: OrganizationExperienceCandidateServiceOptions;
  private readonly randomUUID: () => string;
  private readonly candidateHandles = new Map<string, string>();
  private readonly reviewHandles = new Map<string, string>();

  constructor(options: OrganizationExperienceCandidateServiceOptions) {
    this.options = options;
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  listEligibleSkills(installationIdInput: string): EligibleExperienceSkill[] {
    this.assertLocalAccess();
    const { profilePath } = this.resolveEligibleInstallation(
      uuid(installationIdInput),
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

  prepare(input: {
    installationId: string;
    skillName: string;
  }): OrganizationExperienceCandidatePreview {
    this.assertLocalAccess();
    if (
      input === null ||
      typeof input !== "object" ||
      !SKILL_NAME_PATTERN.test(input.skillName)
    ) {
      return serviceError("invalid_request");
    }
    const { installation, context, profilePath } =
      this.resolveEligibleInstallation(uuid(input.installationId));
    let read;
    try {
      read = this.options.source.readCandidate(profilePath, input.skillName);
      if (read.provenance.kind !== "agent-created") {
        return serviceError("candidate_source_ineligible");
      }
    } catch {
      return serviceError("candidate_source_ineligible");
    }
    let canonical;
    try {
      canonical = canonicalizeExperienceCandidate(read.bundle);
    } catch {
      return serviceError("candidate_source_ineligible");
    }
    const localFindings = scanExperienceCandidate(canonical);
    if (localFindings.length > 0) {
      return serviceError("candidate_dlp_blocked", localFindings);
    }
    const localId = uuid(this.randomUUID());
    let local;
    try {
      local = this.options.store.prepare({
        id: localId,
        agentInstallationId: installation.agentInstallationId,
        organizationId: context.organizationId,
        agentDefinitionId: installation.definitionId,
        sourceAgentVersionId: installation.selectedVersionId,
        runtimeProfileId: installation.runtimeProfileId!,
        skillName: canonical.bundle.skillName,
        sourceRelativePath: read.sourceRelativePath,
        canonical,
      });
    } catch (error) {
      return this.mapStoreError(error);
    }
    const candidateHandle = uuid(this.randomUUID());
    this.candidateHandles.set(candidateHandle, local.id);
    const assets = canonical.bundle.assets.map((asset) => ({
      path: asset.path,
      mediaType: asset.mediaType,
      sizeBytes: Buffer.byteLength(asset.content, "utf8"),
    }));
    return {
      candidateHandle,
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
    input: SubmitOrganizationExperienceCandidateInput,
  ): Promise<OrganizationExperienceCandidateSummary> {
    if (
      input === null ||
      typeof input !== "object" ||
      input.confirmation !== "submit-selected-organization-skill"
    ) {
      return serviceError("invalid_request");
    }
    const context = this.requireOnlineOrganization();
    const handle = uuid(input.candidateHandle);
    const localId = this.candidateHandles.get(handle);
    if (!localId) return serviceError("candidate_not_found");
    let local;
    let canonical;
    try {
      local = this.options.store.get(localId);
      if (
        local.organizationId !== context.organizationId ||
        local.status === "SUBMITTED"
      ) {
        return serviceError("candidate_conflict");
      }
      canonical = this.options.store.readSnapshot(localId);
    } catch (error) {
      return this.mapStoreError(error);
    }
    const request: SubmitOrganizationExperienceCandidateRequest = {
      source_version_id: local.sourceAgentVersionId,
      skill_name: local.skillName,
      schema_version: 1,
      dlp_contract_version: EXPERIENCE_CANDIDATE_DLP_VERSION,
      bundle: toCloudBundle(canonical.bundle),
    };
    const intent = this.options.store.getOrCreateMutationIntent(
      "SUBMIT",
      local.id,
      sha256(JSON.stringify(request)),
    );
    let cloud: CloudOrganizationExperienceCandidateDetail;
    try {
      cloud = await this.options.client.submitOrganizationExperienceCandidate(
        context.organizationId,
        local.agentDefinitionId,
        request,
        intent.idempotencyKey,
      );
      if (!this.matches(cloud, local, canonical.bundle)) {
        return serviceError("verification_failed");
      }
    } catch (error) {
      if (error instanceof OrganizationExperienceCandidateServiceError) {
        this.markAmbiguous(local.id);
        throw error;
      }
      if (error instanceof AgenteraAgentControlClientError) {
        if (TRANSIENT_CODES.has(error.code) || error.status >= 500) {
          this.markAmbiguous(local.id);
        } else {
          this.options.store.completeMutationIntent(intent.idempotencyKey);
          this.markDeterministic(local.id, error.code);
        }
        return this.mapClientError(error);
      }
      this.markAmbiguous(local.id);
      return serviceError("cloud_unavailable");
    }
    const submitted = this.options.store.markSubmitted(local.id, cloud.id);
    this.options.store.completeMutationIntent(intent.idempotencyKey);
    return this.mergedSummary(cloud, submitted, handle, null);
  }

  async listMine(): Promise<OrganizationExperienceCandidateSummary[]> {
    const context = this.requireContributorContext();
    this.assertLocalAccess();
    const locals = this.options.store.listForOrganization(
      context.organizationId,
    );
    if (!this.online()) {
      return locals.map((local) => this.localSummary(local));
    }
    try {
      const clouds =
        await this.options.client.listOwnOrganizationExperienceCandidates(
          context.organizationId,
        );
      return [
        ...clouds.map((cloud) => {
          const local = locals.find(
            (candidate) => candidate.cloudCandidateId === cloud.id,
          );
          return this.mergedSummary(
            cloud,
            local ?? null,
            local ? this.handleForLocal(local.id) : null,
            null,
          );
        }),
        ...locals
          .filter(
            (local) =>
              !clouds.some((cloud) => cloud.id === local.cloudCandidateId),
          )
          .map((local) => this.localSummary(local)),
      ];
    } catch {
      return locals.map((local) => this.localSummary(local));
    }
  }

  async listReviewQueue(): Promise<OrganizationExperienceCandidateSummary[]> {
    const context = this.requireReviewReader();
    const canReview = context.role === "owner" || context.role === "admin";
    try {
      const clouds =
        await this.options.client.listOrganizationExperienceCandidates(
          context.organizationId,
        );
      return clouds.map((cloud) => {
        const reviewHandle =
          canReview && cloud.review === undefined
            ? uuid(this.randomUUID())
            : null;
        if (reviewHandle) this.reviewHandles.set(reviewHandle, cloud.id);
        return this.mergedSummary(cloud, null, null, reviewHandle);
      });
    } catch (error) {
      if (error instanceof AgenteraAgentControlClientError) {
        return this.mapClientError(error);
      }
      return serviceError("cloud_unavailable");
    }
  }

  async get(
    candidateIdInput: string,
  ): Promise<OrganizationExperienceCandidateDetail> {
    const context = this.requireOnlineOrganization();
    const candidateId = uuid(candidateIdInput);
    try {
      const cloud =
        await this.options.client.getOrganizationExperienceCandidate(
          context.organizationId,
          candidateId,
        );
      return this.cloudDetail(cloud);
    } catch (error) {
      if (error instanceof AgenteraAgentControlClientError) {
        return this.mapClientError(error);
      }
      return serviceError("cloud_unavailable");
    }
  }

  async review(
    input: ReviewOrganizationExperienceCandidateInput,
  ): Promise<OrganizationExperienceCandidateDetail> {
    const context = this.requireReviewer();
    const handle = uuid(input.reviewHandle);
    const candidateId = this.reviewHandles.get(handle);
    if (!candidateId) return serviceError("candidate_not_found");
    const request = this.reviewRequest(input);
    const intent = this.options.store.getOrCreateMutationIntent(
      "REVIEW",
      candidateId,
      sha256(JSON.stringify(request)),
    );
    try {
      const cloud =
        await this.options.client.reviewOrganizationExperienceCandidate(
          context.organizationId,
          candidateId,
          request,
          intent.idempotencyKey,
        );
      this.options.store.completeMutationIntent(intent.idempotencyKey);
      this.reviewHandles.delete(handle);
      return this.cloudDetail(cloud);
    } catch (error) {
      if (error instanceof AgenteraAgentControlClientError) {
        if (!TRANSIENT_CODES.has(error.code) && error.status < 500) {
          this.options.store.completeMutationIntent(intent.idempotencyKey);
        }
        return this.mapClientError(error);
      }
      return serviceError("cloud_unavailable");
    }
  }

  async prepareImport(
    candidateIdInput: string,
  ): Promise<OrganizationExperienceCandidateImportPreview> {
    const context = this.requireReviewer();
    return this.options.importer.prepare(
      context.organizationId,
      uuid(candidateIdInput),
    );
  }

  async confirmImport(
    input: ConfirmOrganizationExperienceCandidateImportInput,
  ): Promise<AgentDraftDetail> {
    const context = this.requireReviewer();
    return this.options.importer.confirm(context.organizationId, input);
  }

  clearPrepared(): void {
    this.candidateHandles.clear();
    this.reviewHandles.clear();
    this.options.importer.clearPreparedImports();
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

  private requireOrganizationContext(): Extract<
    AgenteraAgentControlContext,
    { scope: "ORGANIZATION" }
  > {
    const context = this.options.getContext();
    if (
      context.scope !== "ORGANIZATION" ||
      !UUID_PATTERN.test(context.organizationId)
    ) {
      return serviceError("organization_agent_forbidden");
    }
    return { ...context, organizationId: context.organizationId.toLowerCase() };
  }

  private requireContributorContext(): Extract<
    AgenteraAgentControlContext,
    { scope: "ORGANIZATION" }
  > {
    const context = this.requireOrganizationContext();
    if (context.role === "auditor") {
      return serviceError("organization_agent_forbidden");
    }
    return context;
  }

  private requireOnlineOrganization(): Extract<
    AgenteraAgentControlContext,
    { scope: "ORGANIZATION" }
  > {
    this.assertLocalAccess();
    const context = this.requireOrganizationContext();
    if (!this.online()) return serviceError("online_required");
    return context;
  }

  private requireReviewer(): Extract<
    AgenteraAgentControlContext,
    { scope: "ORGANIZATION" }
  > {
    const context = this.requireOnlineOrganization();
    if (context.role !== "owner" && context.role !== "admin") {
      return serviceError("organization_agent_forbidden");
    }
    return context;
  }

  private requireReviewReader(): Extract<
    AgenteraAgentControlContext,
    { scope: "ORGANIZATION" }
  > {
    const context = this.requireOnlineOrganization();
    if (context.role === "member") {
      return serviceError("organization_agent_forbidden");
    }
    return context;
  }

  private resolveEligibleInstallation(installationId: string): {
    installation: LocalAgentInstallation;
    context: Extract<AgenteraAgentControlContext, { scope: "ORGANIZATION" }>;
    profilePath: string;
  } {
    const context = this.requireContributorContext();
    let installation: LocalAgentInstallation;
    try {
      installation = this.options.getInstallation(installationId);
    } catch {
      return serviceError("candidate_source_ineligible");
    }
    if (
      installation.agentInstallationId !== installationId ||
      installation.status !== "active" ||
      installation.sourceScope !== "ORGANIZATION" ||
      installation.sourceWorkspaceId !== null ||
      installation.sourceOrganizationId !== context.organizationId ||
      installation.runtimeProfileId === null
    ) {
      return serviceError("candidate_source_ineligible");
    }
    try {
      const profilePath = this.options.resolveProfilePath(
        installation.runtimeProfileId,
        installation.agentInstallationId,
      );
      if (!profilePath) return serviceError("candidate_source_ineligible");
      return { installation, context, profilePath };
    } catch {
      return serviceError("candidate_source_ineligible");
    }
  }

  private mapStoreError(error: unknown): never {
    if (error instanceof OrganizationExperienceCandidateStoreError) {
      if (error.code === "candidate_not_found") {
        return serviceError("candidate_not_found");
      }
      if (
        error.code === "candidate_conflict" ||
        error.code === "mutation_conflict"
      ) {
        return serviceError("candidate_conflict");
      }
    }
    return serviceError("invalid_request");
  }

  private mapClientError(error: AgenteraAgentControlClientError): never {
    if (error.code === "session_revoked")
      return serviceError("sign_in_required");
    if (TRANSIENT_CODES.has(error.code) || error.status >= 500) {
      return serviceError("cloud_unavailable");
    }
    if (error.code === "candidate_dlp_blocked") {
      return serviceError("candidate_dlp_blocked", findings(error.findings));
    }
    const allowed = new Set<OrganizationExperienceCandidateServiceErrorCode>([
      "invalid_request",
      "invalid_experience_candidate",
      "candidate_already_reviewed",
      "idempotency_conflict",
      "definition_archived",
      "not_found",
      "organization_agent_not_found",
      "organization_agent_forbidden",
      "organization_archived",
    ]);
    return allowed.has(
      error.code as OrganizationExperienceCandidateServiceErrorCode,
    )
      ? serviceError(
          error.code as OrganizationExperienceCandidateServiceErrorCode,
        )
      : serviceError("cloud_unavailable");
  }

  private markAmbiguous(candidateId: string): void {
    try {
      this.options.store.markUploadFailed(candidateId, "cloud_unavailable");
    } catch {
      // Preserve the original ambiguous Cloud outcome if local recovery fails.
    }
  }

  private markDeterministic(candidateId: string, code: string): void {
    try {
      this.options.store.markPreparedWithError(
        candidateId,
        /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "request_failed",
      );
    } catch {
      // Preserve the original deterministic Cloud outcome if local recovery fails.
    }
  }

  private matches(
    cloud: CloudOrganizationExperienceCandidateDetail,
    local: ReturnType<OrganizationExperienceCandidateStore["get"]>,
    bundle: ExperienceCandidateBundleV1,
  ): boolean {
    return (
      cloud.organization_id === local.organizationId &&
      cloud.agent_definition_id === local.agentDefinitionId &&
      cloud.source_agent_version_id === local.sourceAgentVersionId &&
      cloud.skill_name === local.skillName &&
      cloud.content_digest === local.contentDigest &&
      JSON.stringify(fromCloudBundle(cloud.bundle)) === JSON.stringify(bundle)
    );
  }

  private handleForLocal(localId: string): string {
    for (const [handle, id] of this.candidateHandles) {
      if (id === localId) return handle;
    }
    const handle = uuid(this.randomUUID());
    this.candidateHandles.set(handle, localId);
    return handle;
  }

  private localSummary(
    local: ReturnType<OrganizationExperienceCandidateStore["get"]>,
  ): OrganizationExperienceCandidateSummary {
    return {
      candidateHandle: this.handleForLocal(local.id),
      reviewHandle: null,
      cloudCandidateId: local.cloudCandidateId,
      organizationId: local.organizationId,
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

  private mergedSummary(
    cloud: CloudOrganizationExperienceCandidateSummary,
    local: ReturnType<OrganizationExperienceCandidateStore["get"]> | null,
    candidateHandle: string | null,
    reviewHandle: string | null,
  ): OrganizationExperienceCandidateSummary {
    return {
      candidateHandle,
      reviewHandle,
      cloudCandidateId: cloud.id,
      organizationId: cloud.organization_id,
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

  private cloudDetail(
    cloud: CloudOrganizationExperienceCandidateDetail,
  ): OrganizationExperienceCandidateDetail {
    return {
      ...this.mergedSummary(cloud, null, null, null),
      bundle: fromCloudBundle(cloud.bundle),
      decisionReasonCode: cloud.review?.reason_code ?? null,
      safeNote: cloud.review?.safe_note ?? null,
    };
  }

  private reviewRequest(
    input: ReviewOrganizationExperienceCandidateInput,
  ): ReviewExperienceCandidateRequest {
    if (input.confirmation === "approve-organization-experience") {
      if (input.reasonCode !== null || input.safeNote !== null) {
        return serviceError("invalid_request");
      }
      return { decision: "APPROVED" };
    }
    if (
      input.confirmation !== "reject-organization-experience" ||
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
}
