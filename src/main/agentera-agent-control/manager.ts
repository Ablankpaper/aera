import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  AgentDraft,
  AgentDraftDetail,
  AgenteraAgentControlPublicState,
  AgenteraAgentControlContext,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  AgenteraAgentOperationScope,
  AgenteraAgentVersionSummary,
  AgenteraClaimVersionInput,
  AgenteraInstallVersionInput,
  AgenteraRepairInstallationModelInput,
  AgenteraRetryPendingInstallationInput,
  AgenteraSelectInstallationVersionInput,
  ConfirmExperienceCandidateImportInput,
  ConfirmOfficialAgentInstallInput,
  ConfirmOrganizationReviewInput,
  ConfirmOrganizationSubmissionInput,
  ConfirmOrganizationWithdrawalInput,
  CreateAgentDraftInput,
  ExperienceCandidateDetail,
  ExperienceCandidateImportPreview,
  ExperienceCandidatePreview,
  ExperienceCandidateSummary,
  EligibleExperienceSkill,
  PrepareExperienceCandidateInput,
  PrepareOrganizationReviewInput,
  PublicationPreview,
  PublishedRevision,
  ReviewExperienceCandidateInput,
  SubmitExperienceCandidateInput,
  UpdateAgentDraftInput,
  OrganizationAgentSubmissionSummary,
  OfficialAgentDetail,
  OfficialAgentInstallPreview,
  OfficialAgentSummary,
  OfficialManagedUpdate,
} from "../../shared/agentera-agent-control";
import type {
  AgenteraProfileBindingStore,
  AgenteraRuntimeOwner,
} from "../agentera-profile-binding";
import type {
  ActivateVerifiedRestoreInput,
  ActivatedVerifiedRestore,
  AgentInstallationProfileAdapter,
} from "./installation-manager";
import {
  AgentInstallationManager,
  type LocalAgentInstallation,
} from "./installation-manager";
import type { AgentAssetContext, AgenteraControlPlaneDatabase } from "./db";
import { AgentDraftStore } from "./draft-store";
import { AgenteraAgentControlClient, type AgentSigningKeySet } from "./client";
import { AgentPublisher } from "./publisher";
import { AgenteraAgentTrustStore, type AgenteraAgentTrustCache } from "./trust";
import { AgentVersionCache } from "./version-cache";
import { HermesProjectionManager } from "./hermes-projection";
import {
  AgenteraHermesAdapter,
  type PreparedInstalledHermesTurn,
} from "./hermes-adapter";
import {
  RuntimeBindingStore,
  type LocalRuntimeBinding,
} from "./runtime-binding-store";
import {
  ConversationBoundaryStore,
  type ConversationBoundary,
} from "./conversation-boundary-store";
import { ConversationRuntimeCoordinator } from "./conversation-runtime-coordinator";
import { ExperienceCandidateService } from "./experience-candidate-service";
import { ExperienceCandidateImporter } from "./experience-candidate-importer";
import { ExperienceCandidateStore } from "./experience-candidate-store";
import { ReadOnlyHermesSkillCandidateSource } from "./hermes-skill-candidate-source";
import {
  OrganizationPublicationService,
  type OrganizationAgentSubmissionDetail,
  type OrganizationReviewPreview,
  type OrganizationSubmissionPreview,
  type OrganizationWithdrawalPreview,
} from "./organization-publication-service";
import { OfficialAgentService } from "./official-agent-service";
import { modelPolicyForManifest } from "./model-policy";
import {
  serializeDefinition,
  serializeInstallation,
  serializeVersion,
} from "./ipc-contract";

export interface PrepareAgenteraHermesTurnInput {
  conversationKey: string;
  profilePath: string;
  owner: AgenteraRuntimeOwner;
  resumeSessionId: string | null;
}

export interface PrepareAgenteraConversationBoundaryInput {
  conversationKey: string;
  owner: AgenteraRuntimeOwner;
  resumeSessionId: string | null;
  runtimeBinding: LocalRuntimeBinding | null;
}

export interface PreparedAgenteraConversationRuntime {
  preparedAgentTurn: PreparedInstalledHermesTurn | null;
  conversationBoundary: ConversationBoundary;
}

export interface AttachAgenteraConversationRuntimeSessionInput {
  runtimeBindingId: string | null;
  boundaryId: string;
  sessionId: string;
  owner: AgenteraRuntimeOwner;
}

interface FullAgentControlOptions {
  database: AgenteraControlPlaneDatabase;
  client: AgenteraAgentControlClient;
  profiles: AgentInstallationProfileAdapter;
  userDataPath: string;
  getOwner: () => AgenteraRuntimeOwner;
  getAgentContext?: () => AgenteraAgentControlContext;
  getAuthState: () => AgenteraAuthPublicState;
  getRuntimeVersion: () => string | Promise<string>;
  getConnectionMode: () => "local" | "remote" | "ssh";
  assertEntitled: () => void;
  isVersionRevoked?: (versionId: string) => boolean | Promise<boolean>;
  now?: () => Date;
  randomUUID?: () => string;
}

export interface AgenteraAgentControlManagerOptions extends Partial<FullAgentControlOptions> {
  profileBindings: AgenteraProfileBindingStore;
  /** Task-12 compatibility seam used by focused manager tests. */
  hermesAdapter?: AgenteraHermesAdapter;
  /** Test seam for proving that cloud outbox delivery never blocks Hermes. */
  retryPendingRuntimeBindings?: () => Promise<unknown>;
}

export interface AgenteraEncryptedBackupUserSource {
  installationId: string;
  profilePath: string;
  provenance: {
    sourceInstallationId: string;
    sourceDefinitionId: string;
    sourceVersionId: string;
    baseOwnerScope: "USER";
  };
  runtimeBindingProvenance: Uint8Array;
}

interface RuntimeComponents {
  key: string;
  runtimeVersion: string;
  cache: AgentVersionCache;
  installations: AgentInstallationManager;
  hermes: AgenteraHermesAdapter;
  bindingStore: RuntimeBindingStore;
}

interface ContextComponents {
  key: string;
  publisher: AgentPublisher;
}

interface OrganizationPublicationComponents {
  key: string;
  service: OrganizationPublicationService;
}

interface ExperienceCandidateComponents {
  key: string;
  service: ExperienceCandidateService;
}

interface OfficialAgentComponents {
  key: string;
  service: OfficialAgentService;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function codedError(code: string): Error {
  return Object.assign(new Error(`Aera Agent control failed: ${code}.`), {
    code,
  });
}

export function runtimeComponentKey(owner: AgenteraRuntimeOwner): string {
  return `${owner.tenantId}\0${owner.ownerId}\0${owner.deviceInstallationId}`;
}

type NormalizedAgentContext = AgenteraAgentControlContext;

function normalizeAgentContext(
  context: AgenteraAgentControlContext | undefined,
): NormalizedAgentContext {
  if (context === undefined || context.scope === "USER") {
    return { scope: "USER" };
  }
  if (context.scope === "ORGANIZATION") {
    if (
      !UUID_PATTERN.test(context.organizationId) ||
      (context.role !== "owner" &&
        context.role !== "admin" &&
        context.role !== "auditor" &&
        context.role !== "member")
    ) {
      throw codedError("invalid_request");
    }
    return {
      scope: "ORGANIZATION",
      organizationId: context.organizationId.toLowerCase(),
      role: context.role,
    };
  }
  if (
    context.scope !== "WORKSPACE" ||
    !UUID_PATTERN.test(context.workspaceId) ||
    (context.role !== "owner" &&
      context.role !== "admin" &&
      context.role !== "member")
  ) {
    throw codedError("invalid_request");
  }
  return {
    scope: "WORKSPACE",
    workspaceId: context.workspaceId.toLowerCase(),
    role: context.role,
  };
}

function contextKey(context: NormalizedAgentContext): string {
  switch (context.scope) {
    case "USER":
      return "USER";
    case "WORKSPACE":
      return `WORKSPACE\0${context.workspaceId}\0${context.role}`;
    case "ORGANIZATION":
      return `ORGANIZATION\0${context.organizationId}\0${context.role}`;
  }
}

function installationMatchesContext(
  installation: LocalAgentInstallation,
  context: AgentAssetContext,
): boolean {
  switch (context.scope) {
    case "USER":
      return (
        installation.sourceScope === "USER" &&
        installation.sourceWorkspaceId === null &&
        installation.sourceOrganizationId === null
      );
    case "WORKSPACE":
      return (
        installation.sourceScope === "WORKSPACE" &&
        installation.sourceWorkspaceId === context.workspaceId &&
        installation.sourceOrganizationId === null
      );
    case "ORGANIZATION":
      return (
        installation.sourceScope === "ORGANIZATION" &&
        installation.sourceWorkspaceId === null &&
        installation.sourceOrganizationId === context.organizationId
      );
  }
}

function requireRuntimeVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    /[\0\r\n]/.test(value)
  ) {
    throw codedError("runtime_incompatible");
  }
  return value;
}

function publicCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw codedError("operation_failed");
  }
  return count;
}

function publicCapabilitySummary(value: unknown): string {
  if (typeof value !== "string") throw codedError("operation_failed");
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) throw codedError("operation_failed");
  const characters = Array.from(normalized);
  return characters.length > 1200
    ? `${characters.slice(0, 1199).join("")}…`
    : normalized;
}

function loadTrustCache(
  database: AgenteraControlPlaneDatabase,
): AgenteraAgentTrustCache {
  const rows = database.sqlite
    .prepare(
      `SELECT origin, purpose, key_id, public_key, fetched_at
       FROM signing_key_cache
       ORDER BY origin, purpose, key_id`,
    )
    .all() as Array<{
    origin?: unknown;
    purpose?: unknown;
    key_id?: unknown;
    public_key?: unknown;
    fetched_at?: unknown;
  }>;
  return {
    schemaVersion: 1,
    keys: rows.map((row) => ({
      origin: String(row.origin),
      purpose: row.purpose as "agent_version" | "agent_policy",
      keyId: String(row.key_id),
      publicKey: String(row.public_key),
      fetchedAt: String(row.fetched_at),
    })),
  };
}

function persistTrustCache(
  database: AgenteraControlPlaneDatabase,
  trust: AgenteraAgentTrustStore,
  origin: string,
): void {
  const keys = trust.exportCache().keys.filter((key) => key.origin === origin);
  database.sqlite.exec("BEGIN IMMEDIATE");
  try {
    database.sqlite
      .prepare("DELETE FROM signing_key_cache WHERE origin = ?")
      .run(origin);
    const insert = database.sqlite.prepare(
      `INSERT INTO signing_key_cache (
         origin, purpose, key_id, public_key, fetched_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const key of keys) {
      insert.run(
        key.origin,
        key.purpose,
        key.keyId,
        key.publicKey,
        key.fetchedAt,
      );
    }
    database.sqlite.exec("COMMIT");
  } catch (error) {
    try {
      database.sqlite.exec("ROLLBACK");
    } catch {
      // Preserve the primary persistence error.
    }
    throw error;
  }
}

/**
 * One long-lived main-process facade. Renderer requests never construct a DB,
 * trust store, owner, Profile path resolver, or cloud client.
 */
export class AgenteraAgentControlManager {
  private readonly options: AgenteraAgentControlManagerOptions;
  private readonly profileBindings: AgenteraProfileBindingStore;
  private readonly runtimeOnlyHermes: AgenteraHermesAdapter | null;
  private readonly trust: AgenteraAgentTrustStore | null;
  private readonly projection: HermesProjectionManager | null;
  private runtime: RuntimeComponents | null = null;
  private contextComponents: ContextComponents | null = null;
  private organizationPublicationComponents: OrganizationPublicationComponents | null =
    null;
  private experienceCandidateComponents: ExperienceCandidateComponents | null =
    null;
  private officialAgentComponents: OfficialAgentComponents | null = null;
  private readonly publicationOwners = new Map<string, string>();
  private readonly listeners = new Set<
    (state: AgenteraAgentControlPublicState) => void
  >();
  private runtimeBindingDeliveryInFlight = false;
  private runtimeBindingDeliveryRequested = false;
  private readonly installationReconciliationFlights = new Map<
    string,
    Promise<void>
  >();

  constructor(options: AgenteraAgentControlManagerOptions) {
    this.options = options;
    this.profileBindings = options.profileBindings;
    this.runtimeOnlyHermes = options.hermesAdapter ?? null;
    if (options.database) {
      this.trust = new AgenteraAgentTrustStore({
        cache: loadTrustCache(options.database),
      });
      if (!options.userDataPath) throw codedError("invalid_request");
      this.projection = new HermesProjectionManager({
        userDataPath: options.userDataPath,
      });
    } else {
      this.trust = null;
      this.projection = null;
    }
  }

  getState(): AgenteraAgentControlPublicState {
    this.assertProductAccess();
    const state = this.requireFull().getAuthState();
    const context = this.context();
    const common = {
      access:
        state.status === "offline" ? ("offline" as const) : ("online" as const),
      cloudAvailable:
        (state.status === "authenticated" || state.status === "offline") &&
        state.cloudAvailable,
    };
    const owner = this.owner();
    const workspaceId =
      context.scope === "WORKSPACE" ? context.workspaceId : null;
    const organizationId =
      context.scope === "ORGANIZATION" ? context.organizationId : null;
    const canReadDrafts =
      context.scope !== "ORGANIZATION" ||
      context.role === "owner" ||
      context.role === "admin";
    const canUseInstallations =
      context.scope !== "ORGANIZATION" || context.role !== "auditor";
    const draftCount = canReadDrafts
      ? (this.options.database?.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM agent_drafts
             WHERE tenant_id = ? AND owner_id = ?
               AND target_scope = ? AND workspace_id IS ?
               AND organization_id IS ?`,
          )
          .get(
            owner.tenantId,
            owner.ownerId,
            context.scope,
            workspaceId,
            organizationId,
          ) as { count?: unknown } | undefined)
      : undefined;
    const installationCount = canUseInstallations
      ? (this.options.database?.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM local_agent_installations
             WHERE tenant_id = ? AND owner_id = ?
               AND device_installation_id = ?
               AND (
                 (source_scope = ? AND source_workspace_id IS ?
                   AND source_organization_id IS ?)
                 OR (source_scope = 'PLATFORM' AND update_policy = 'managed')
               )`,
          )
          .get(
            owner.tenantId,
            owner.ownerId,
            owner.deviceInstallationId,
            context.scope,
            workspaceId,
            organizationId,
          ) as { count?: unknown } | undefined)
      : undefined;
    return {
      ...common,
      context:
        context.scope === "USER"
          ? { scope: "USER" }
          : context.scope === "WORKSPACE"
            ? {
                scope: "WORKSPACE",
                workspaceId: context.workspaceId,
                role: context.role,
              }
            : {
                scope: "ORGANIZATION",
                organizationId: context.organizationId,
                role: context.role,
              },
      draftCount: publicCount(draftCount?.count ?? 0),
      installationCount: publicCount(installationCount?.count ?? 0),
    };
  }

  subscribe(
    listener: (state: AgenteraAgentControlPublicState) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyAccessStateChanged(): void {
    this.contextComponents = null;
    this.organizationPublicationComponents?.service.invalidate();
    this.organizationPublicationComponents = null;
    this.experienceCandidateComponents?.service.clearPreparedImports();
    this.experienceCandidateComponents = null;
    this.officialAgentComponents?.service.invalidate();
    this.officialAgentComponents = null;
    this.publicationOwners.clear();
    this.emitState();
    this.queueRuntimeBindingDelivery();
    this.queueInstallationReconciliation();
  }

  notifyAgentContextChanged(): void {
    this.contextComponents = null;
    this.organizationPublicationComponents?.service.invalidate();
    this.organizationPublicationComponents = null;
    this.experienceCandidateComponents?.service.clearPreparedImports();
    this.experienceCandidateComponents = null;
    this.officialAgentComponents?.service.invalidate();
    this.officialAgentComponents = null;
    this.publicationOwners.clear();
    this.emitState();
  }

  listDrafts(scope?: AgenteraAgentOperationScope): AgentDraft[] {
    const context = this.operationAssetContext(scope);
    this.assertDraftReadAccess(context);
    return this.requireDrafts(context).listDrafts();
  }

  getDraft(id: string, scope?: AgenteraAgentOperationScope): AgentDraftDetail {
    const context = this.operationAssetContext(scope);
    this.assertDraftReadAccess(context);
    return this.requireDrafts(context).getDraftDetail(id);
  }

  createDraft(
    input: CreateAgentDraftInput,
    scope?: AgenteraAgentOperationScope,
  ): AgentDraftDetail {
    const context = this.operationAssetContext(scope);
    this.assertAuthoringAccess(context);
    const drafts = this.requireDrafts(context);
    const created = drafts.createDraft(input);
    const result = drafts.getDraftDetail(created.id);
    this.emitState();
    return result;
  }

  updateDraft(
    input: UpdateAgentDraftInput,
    scope?: AgenteraAgentOperationScope,
  ): AgentDraftDetail {
    const context = this.operationAssetContext(scope);
    this.assertAuthoringAccess(context);
    const drafts = this.requireDrafts(context);
    const updated = drafts.updateDraft(input);
    const result = drafts.getDraftDetail(updated.id);
    this.emitState();
    return result;
  }

  deleteDraft(id: string, scope?: AgenteraAgentOperationScope): true {
    const context = this.operationAssetContext(scope);
    this.assertAuthoringAccess(context);
    this.requireDrafts(context).deleteDraft(id);
    this.emitState();
    return true;
  }

  async preparePublication(
    id: string,
    scope?: AgenteraAgentOperationScope,
  ): Promise<PublicationPreview> {
    const context = this.operationAssetContext(scope);
    this.assertWorkspacePublicationRole(context);
    await this.assertOnlineAccess(true);
    const components = await this.ensureContextComponents(context);
    const preview = components.publisher.preparePublication(id);
    this.publicationOwners.set(
      preview.publicationHandle,
      this.operationContextKey(context),
    );
    return preview;
  }

  async confirmPublication(
    handle: string,
    scope?: AgenteraAgentOperationScope,
  ): Promise<PublishedRevision> {
    const context = this.operationAssetContext(scope);
    this.assertWorkspacePublicationRole(context);
    const expectedOwner = this.publicationOwners.get(handle);
    this.publicationOwners.delete(handle);
    if (!expectedOwner || expectedOwner !== this.operationContextKey(context)) {
      throw codedError("publication_confirmation_invalid");
    }
    await this.assertOnlineAccess(true);
    const result = await (
      await this.ensureContextComponents(context)
    ).publisher.confirmPublication(handle);
    this.emitState();
    return result;
  }

  async prepareOrganizationSubmission(
    draftId: string,
  ): Promise<OrganizationSubmissionPreview> {
    this.assertOrganizationPublicationRole();
    await this.assertOnlineAccess(false);
    return this.ensureOrganizationPublicationComponents().service.prepareSubmission(
      draftId,
    );
  }

  async confirmOrganizationSubmission(
    input: ConfirmOrganizationSubmissionInput,
  ): Promise<OrganizationAgentSubmissionSummary> {
    this.assertOrganizationPublicationRole();
    await this.assertOnlineAccess(false);
    const result =
      await this.ensureOrganizationPublicationComponents().service.submitPrepared(
        input,
      );
    this.emitState();
    return result;
  }

  async listOrganizationSubmissions(): Promise<
    OrganizationAgentSubmissionSummary[]
  > {
    this.assertOrganizationHistoryRole();
    await this.assertOnlineAccess(false);
    return this.ensureOrganizationPublicationComponents().service.listSubmissions();
  }

  async getOrganizationSubmission(
    submissionId: string,
  ): Promise<OrganizationAgentSubmissionDetail> {
    this.assertOrganizationHistoryRole();
    await this.assertOnlineAccess(false);
    return this.ensureOrganizationPublicationComponents().service.getSubmission(
      submissionId,
    );
  }

  async prepareOrganizationReview(
    input: PrepareOrganizationReviewInput,
  ): Promise<OrganizationReviewPreview> {
    this.assertOrganizationPublicationRole();
    await this.assertOnlineAccess(false);
    return this.ensureOrganizationPublicationComponents().service.prepareReview(
      input,
    );
  }

  async confirmOrganizationReview(
    input: ConfirmOrganizationReviewInput,
  ): Promise<OrganizationAgentSubmissionSummary> {
    this.assertOrganizationPublicationRole();
    await this.assertOnlineAccess(false);
    return this.ensureOrganizationPublicationComponents().service.reviewPrepared(
      input,
    );
  }

  async prepareOrganizationWithdrawal(
    submissionId: string,
  ): Promise<OrganizationWithdrawalPreview> {
    this.assertOrganizationPublicationRole();
    await this.assertOnlineAccess(false);
    return this.ensureOrganizationPublicationComponents().service.prepareWithdrawal(
      submissionId,
    );
  }

  async confirmOrganizationWithdrawal(
    input: ConfirmOrganizationWithdrawalInput,
  ): Promise<OrganizationAgentSubmissionSummary> {
    this.assertOrganizationPublicationRole();
    await this.assertOnlineAccess(false);
    return this.ensureOrganizationPublicationComponents().service.confirmWithdrawal(
      input,
    );
  }

  async listDefinitions(
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentDefinitionSummary[]> {
    await this.assertOnlineAccess(false);
    const context = this.operationAssetContext(scope);
    const definitions =
      context.scope === "USER"
        ? await this.requireFull().client.listDefinitions()
        : context.scope === "WORKSPACE"
          ? await this.requireFull().client.listWorkspaceDefinitions(
              context.workspaceId,
            )
          : await this.requireFull().client.listOrganizationDefinitions(
              context.organizationId,
            );
    return definitions.map(serializeDefinition);
  }

  async listOfficialAgents(): Promise<OfficialAgentSummary[]> {
    await this.assertOnlineAccess(false);
    return this.ensureOfficialAgentComponents().service.list();
  }

  async getOfficialAgentDetail(
    definitionId: string,
  ): Promise<OfficialAgentDetail> {
    await this.assertOnlineAccess(false);
    const detail =
      await this.requireFull().client.getOfficialAgent(definitionId);
    if (
      detail.agent.definitionId !== definitionId ||
      detail.version.definition_id !== definitionId ||
      detail.version.id !== detail.agent.versionId
    ) {
      throw codedError("verification_failed");
    }
    const version = serializeVersion(detail.version);
    const modelPolicy = modelPolicyForManifest(detail.version.manifest);
    return {
      agent: { ...detail.agent },
      capabilitySummary: publicCapabilitySummary(
        detail.version.manifest.identity.system_prompt,
      ),
      assetCounts: { ...version.assetCounts },
      allowedProviders: [...modelPolicy.allowedProviders],
      allowedModels: [...modelPolicy.allowedModels],
      allowedToolCount: publicCount(
        detail.version.manifest.tools.allowed.length,
      ),
    };
  }

  async prepareOfficialInstall(
    definitionId: string,
  ): Promise<OfficialAgentInstallPreview> {
    this.assertInstallationRole();
    await this.assertOnlineAccess(false);
    return this.ensureOfficialAgentComponents().service.prepareInstall(
      definitionId,
    );
  }

  async confirmOfficialInstall(
    input: ConfirmOfficialAgentInstallInput,
  ): Promise<AgenteraAgentInstallationSummary> {
    this.assertInstallationRole();
    await this.assertOnlineLocalRuntimeAccess();
    const result =
      await this.ensureOfficialAgentComponents().service.confirmInstall(input);
    this.emitState();
    return serializeInstallation(result);
  }

  async refreshOfficialUpdates(): Promise<OfficialManagedUpdate[]> {
    this.assertInstallationRole();
    await this.assertOnlineLocalRuntimeAccess();
    await this.ensureRuntimeComponents();
    return this.ensureOfficialAgentComponents().service.refreshManagedUpdates();
  }

  async applyOfficialUpdate(
    installationId: string,
  ): Promise<AgenteraAgentInstallationSummary> {
    this.assertInstallationRole();
    await this.assertOnlineLocalRuntimeAccess();
    await this.ensureRuntimeComponents();
    const result =
      await this.ensureOfficialAgentComponents().service.applyManagedUpdate(
        installationId,
      );
    this.emitState();
    return serializeInstallation(result);
  }

  async listVersions(
    definitionId: string,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentVersionSummary[]> {
    await this.assertOnlineAccess(false);
    const context = this.operationAssetContext(scope);
    const versions =
      context.scope === "USER"
        ? await this.requireFull().client.listVersions(definitionId)
        : context.scope === "WORKSPACE"
          ? await this.requireFull().client.listWorkspaceVersions(
              context.workspaceId,
              definitionId,
            )
          : await this.requireFull().client.listOrganizationVersions(
              context.organizationId,
              definitionId,
            );
    return versions.map(serializeVersion);
  }

  async listInstallations(
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentInstallationSummary[]> {
    const context = this.operationAssetContext(scope);
    this.assertInstallationRole(context);
    const installationManager = (await this.ensureRuntimeComponents())
      .installations;
    return [
      ...installationManager.listLocalInstallations(context),
      ...installationManager.listManagedInstallations(),
    ].map(serializeInstallation);
  }

  async resolveEncryptedBackupUserSource(
    installationId: string,
  ): Promise<AgenteraEncryptedBackupUserSource> {
    this.assertInstallationRole();
    if (this.assetContext().scope !== "USER") {
      throw codedError("operation_failed");
    }
    const runtime = await this.ensureRuntimeComponents();
    const installation =
      runtime.installations.getLocalInstallation(installationId);
    if (
      installation.sourceScope !== "USER" ||
      installation.sourceWorkspaceId !== null ||
      installation.sourceOrganizationId !== null ||
      installation.status !== "active" ||
      installation.runtimeProfileId === null
    ) {
      throw codedError("operation_failed");
    }
    const full = this.requireFull();
    const profilePath = this.profileBindings.resolveAttachedProfilePath(
      installation.runtimeProfileId,
      installation.agentInstallationId,
      full.getOwner(),
    );
    const runtimeBindingProvenance = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        sourceInstallationId: installation.agentInstallationId,
        sourceDefinitionId: installation.definitionId,
        sourceVersionId: installation.selectedVersionId,
        runtimeProfileId: installation.runtimeProfileId,
        bindings: runtime.bindingStore.listForInstallation(
          installation.agentInstallationId,
        ),
      }),
      "utf8",
    );
    if (
      runtimeBindingProvenance.byteLength < 1 ||
      runtimeBindingProvenance.byteLength > 1024 * 1024
    ) {
      runtimeBindingProvenance.fill(0);
      throw codedError("operation_failed");
    }
    return {
      installationId: installation.agentInstallationId,
      profilePath,
      provenance: {
        sourceInstallationId: installation.agentInstallationId,
        sourceDefinitionId: installation.definitionId,
        sourceVersionId: installation.selectedVersionId,
        baseOwnerScope: "USER",
      },
      runtimeBindingProvenance,
    };
  }

  async installVersion(
    input: AgenteraInstallVersionInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentInstallationSummary> {
    const source = this.operationAssetContext(scope);
    this.assertInstallationRole(source);
    await this.assertOnlineLocalRuntimeAccess();
    const result = await (
      await this.ensureRuntimeComponents()
    ).installations.install({
      definitionId: input.definitionId,
      versionId: input.versionId,
      source,
      profile: {
        kind: "fresh",
        name: input.profileName,
        modelSourceProfileId:
          input.modelSelection?.sourceProfileId ?? input.modelProfileId,
        modelSourceModelId: input.modelSelection?.modelLibraryId,
      },
    });
    this.emitState();
    return serializeInstallation(result);
  }

  async verifyImmutableUserBase(input: {
    definitionId: string;
    versionId: string;
    ownerScope: "USER";
  }): Promise<void> {
    await this.assertOnlineLocalRuntimeAccess();
    await (
      await this.ensureRuntimeComponents()
    ).installations.verifyImmutableUserBase(input);
  }

  async activateVerifiedRestore(
    input: ActivateVerifiedRestoreInput,
  ): Promise<ActivatedVerifiedRestore> {
    await this.assertOnlineLocalRuntimeAccess();
    const restored = await (
      await this.ensureRuntimeComponents()
    ).installations.activateVerifiedRestore(input);
    this.emitState();
    return restored;
  }

  async claimVersion(
    input: AgenteraClaimVersionInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentInstallationSummary> {
    const source = this.operationAssetContext(scope);
    this.assertInstallationRole(source);
    await this.assertOnlineLocalRuntimeAccess();
    if (input.confirmation !== "claim-existing-profile") {
      throw codedError("invalid_request");
    }
    const profiles = this.requireFull().profiles;
    const result = await (
      await this.ensureRuntimeComponents()
    ).installations.install({
      definitionId: input.definitionId,
      versionId: input.versionId,
      source,
      profile: {
        kind: "claim",
        profileId: input.localProfileId,
        profilePath: profiles.resolveProfilePath(input.localProfileId),
      },
    });
    this.emitState();
    return serializeInstallation(result);
  }

  async retryPendingInstallation(
    input: AgenteraRetryPendingInstallationInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentInstallationSummary> {
    const context = this.operationAssetContext(scope);
    this.assertInstallationRole(context);
    await this.assertOnlineLocalRuntimeAccess();
    const profiles = this.requireFull().profiles;
    const components = await this.ensureRuntimeComponents();
    this.assertInstallationInContext(
      components.installations.getLocalInstallation(input.id),
      context,
    );
    const target =
      input.target.kind === "fresh"
        ? ({
            kind: "fresh",
            name: input.target.profileName,
            modelSourceProfileId:
              input.target.modelSelection?.sourceProfileId ??
              input.target.modelProfileId,
            modelSourceModelId: input.target.modelSelection?.modelLibraryId,
          } as const)
        : ({
            kind: "claim",
            profileId: input.target.localProfileId,
            profilePath: profiles.resolveProfilePath(
              input.target.localProfileId,
            ),
          } as const);
    const result = await components.installations.retryPendingInstallation({
      agentInstallationId: input.id,
      profile: target,
    });
    this.emitState();
    return serializeInstallation(result);
  }

  async selectInstallationVersion(
    input: AgenteraSelectInstallationVersionInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentInstallationSummary> {
    const context = this.operationAssetContext(scope);
    this.assertInstallationRole(context);
    await this.assertOnlineLocalRuntimeAccess();
    const components = await this.ensureRuntimeComponents();
    this.assertInstallationInContext(
      components.installations.getLocalInstallation(input.id),
      context,
    );
    const result = await components.installations.selectInstallationVersion({
      agentInstallationId: input.id,
      versionId: input.versionId,
      profilePath: this.requireFull().profiles.resolveProfilePath(
        input.localProfileId,
      ),
    });
    this.emitState();
    return serializeInstallation(result);
  }

  async repairInstallationModel(
    input: AgenteraRepairInstallationModelInput,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentInstallationSummary> {
    const context = this.operationAssetContext(scope);
    this.assertInstallationRole(context);
    await this.assertOnlineLocalRuntimeAccess();
    const components = await this.ensureRuntimeComponents();
    this.assertInstallationInContext(
      components.installations.getLocalInstallation(input.id),
      context,
    );
    const modelSourceProfileId =
      input.modelSelection?.sourceProfileId ?? input.modelProfileId;
    if (!modelSourceProfileId) throw codedError("invalid_request");
    const result = await components.installations.repairInstallationModel({
      agentInstallationId: input.id,
      profilePath: this.requireFull().profiles.resolveProfilePath(
        input.localProfileId,
      ),
      localProfileId: input.localProfileId,
      modelSourceProfileId,
      modelSourceModelId: input.modelSelection?.modelLibraryId,
    });
    this.emitState();
    return serializeInstallation(result);
  }

  async archiveInstallation(
    id: string,
    scope?: AgenteraAgentOperationScope,
  ): Promise<AgenteraAgentInstallationSummary> {
    const context = this.operationAssetContext(scope);
    this.assertInstallationRole(context);
    await this.assertOnlineAccess(true);
    const components = await this.ensureRuntimeComponents();
    this.assertInstallationInContext(
      components.installations.getLocalInstallation(id),
      context,
    );
    const result = await components.installations.archiveInstallation(id);
    this.emitState();
    return serializeInstallation(result);
  }

  async listEligibleExperienceSkills(
    installationId: string,
  ): Promise<EligibleExperienceSkill[]> {
    return (
      await this.ensureExperienceCandidateComponents()
    ).service.listEligibleSkills(installationId);
  }

  async prepareExperienceCandidate(
    input: PrepareExperienceCandidateInput,
  ): Promise<ExperienceCandidatePreview> {
    return (await this.ensureExperienceCandidateComponents()).service.prepare(
      input,
    );
  }

  async submitExperienceCandidate(
    input: SubmitExperienceCandidateInput,
  ): Promise<ExperienceCandidateSummary> {
    return (await this.ensureExperienceCandidateComponents()).service.submit(
      input,
    );
  }

  async listMyExperienceCandidates(): Promise<ExperienceCandidateSummary[]> {
    return (
      await this.ensureExperienceCandidateComponents()
    ).service.listMine();
  }

  async listExperienceReviewQueue(): Promise<ExperienceCandidateSummary[]> {
    return (
      await this.ensureExperienceCandidateComponents()
    ).service.listReviewQueue();
  }

  async getExperienceCandidate(
    candidateId: string,
  ): Promise<ExperienceCandidateDetail> {
    return (await this.ensureExperienceCandidateComponents()).service.get(
      candidateId,
    );
  }

  async reviewExperienceCandidate(
    input: ReviewExperienceCandidateInput,
  ): Promise<ExperienceCandidateDetail> {
    return (await this.ensureExperienceCandidateComponents()).service.review(
      input,
    );
  }

  async prepareExperienceCandidateImport(
    candidateId: string,
  ): Promise<ExperienceCandidateImportPreview> {
    this.assertWorkspaceReviewRole();
    await this.assertOnlineAccess(true);
    return (
      await this.ensureExperienceCandidateComponents()
    ).service.prepareImport(candidateId);
  }

  async confirmExperienceCandidateImport(
    input: ConfirmExperienceCandidateImportInput,
  ): Promise<AgentDraftDetail> {
    this.assertWorkspaceReviewRole();
    await this.assertOnlineAccess(false);
    const draft = await (
      await this.ensureExperienceCandidateComponents()
    ).service.confirmImport(input);
    this.emitState();
    return draft;
  }

  async prepareHermesTurn(
    input: PrepareAgenteraHermesTurnInput,
  ): Promise<PreparedInstalledHermesTurn | null> {
    const profile = this.profileBindings.verifyProfileBinding(
      input.profilePath,
      input.owner,
    );
    if (profile.agentInstallationId === null) return null;
    const adapter =
      this.runtimeOnlyHermes ?? (await this.ensureRuntimeComponents()).hermes;
    const prepared = await adapter.prepareInstalledTurn(input);
    this.queueRuntimeBindingDelivery();
    return prepared;
  }

  async prepareConversationRuntime(
    input: PrepareAgenteraHermesTurnInput,
  ): Promise<PreparedAgenteraConversationRuntime> {
    const full = this.requireFull();
    const profile = this.profileBindings.verifyProfileBinding(
      input.profilePath,
      input.owner,
    );
    let adapter: AgenteraHermesAdapter | null = null;
    let bindingStore: RuntimeBindingStore;
    let plan: Awaited<
      ReturnType<AgenteraHermesAdapter["prepareInstalledTurnPlan"]>
    > | null = null;
    if (profile.agentInstallationId === null) {
      bindingStore = new RuntimeBindingStore({
        database: full.database,
        owner: input.owner,
        now: this.options.now,
        randomUUID: this.options.randomUUID,
      });
    } else if (this.runtimeOnlyHermes) {
      adapter = this.runtimeOnlyHermes;
      bindingStore = new RuntimeBindingStore({
        database: full.database,
        owner: input.owner,
        now: this.options.now,
        randomUUID: this.options.randomUUID,
      });
      plan = await adapter.prepareInstalledTurnPlan(input);
    } else {
      const runtime = await this.ensureRuntimeComponents();
      adapter = runtime.hermes;
      bindingStore = runtime.bindingStore;
      plan = await adapter.prepareInstalledTurnPlan(input);
    }

    const coordinator = new ConversationRuntimeCoordinator({
      database: full.database,
      bindingStore,
      boundaryStore: this.conversationBoundaryStore(input.owner),
    });
    const prepared = coordinator.prepare({
      conversationKey: input.conversationKey,
      resumeSessionId: input.resumeSessionId,
      context: this.assetContext(),
      bindingInput: plan?.bindingInput ?? null,
    });
    const preparedAgentTurn =
      plan && adapter && prepared.runtimeBinding
        ? adapter.finalizeInstalledTurn(plan, prepared.runtimeBinding)
        : null;
    if (prepared.runtimeBinding) this.queueRuntimeBindingDelivery();
    return {
      preparedAgentTurn,
      conversationBoundary: prepared.boundary,
    };
  }

  attachConversationRuntimeSession(
    input: AttachAgenteraConversationRuntimeSessionInput,
  ): ReturnType<ConversationRuntimeCoordinator["attachHermesSession"]> {
    const full = this.requireFull();
    const coordinator = new ConversationRuntimeCoordinator({
      database: full.database,
      bindingStore: new RuntimeBindingStore({
        database: full.database,
        owner: input.owner,
        now: this.options.now,
        randomUUID: this.options.randomUUID,
      }),
      boundaryStore: this.conversationBoundaryStore(input.owner),
    });
    const attached = coordinator.attachHermesSession({
      runtimeBindingId: input.runtimeBindingId,
      boundaryId: input.boundaryId,
      sessionId: input.sessionId,
    });
    if (attached.runtimeBinding) this.queueRuntimeBindingDelivery();
    return attached;
  }

  attachHermesSession(bindingId: string, sessionId: string): void {
    const adapter = this.runtimeOnlyHermes ?? this.runtime?.hermes;
    if (!adapter) throw codedError("binding_required");
    adapter.attachHermesSession(bindingId, sessionId);
    this.queueRuntimeBindingDelivery();
  }

  prepareConversationBoundary(
    input: PrepareAgenteraConversationBoundaryInput,
  ): ConversationBoundary {
    return this.conversationBoundaryStore(input.owner).prepare({
      conversationKey: input.conversationKey,
      resumeSessionId: input.resumeSessionId,
      context: this.assetContext(),
      runtimeBinding: input.runtimeBinding,
    });
  }

  attachConversationBoundarySession(
    boundaryId: string,
    sessionId: string,
    owner: AgenteraRuntimeOwner,
  ): ConversationBoundary {
    return this.conversationBoundaryStore(owner).attachHermesSession(
      boundaryId,
      sessionId,
    );
  }

  getConversationBoundaryForSession(
    sessionId: string,
    owner: AgenteraRuntimeOwner,
  ): ConversationBoundary | null {
    return this.conversationBoundaryStore(owner).getByHermesSessionId(
      sessionId,
    );
  }

  deleteConversationBoundariesForSessions(
    sessionIds: readonly string[],
    owner: AgenteraRuntimeOwner,
  ): number {
    return this.conversationBoundaryStore(owner).deleteForHermesSessions(
      sessionIds,
    );
  }

  private requireFull(): FullAgentControlOptions {
    const options = this.options as AgenteraAgentControlManagerOptions &
      Partial<FullAgentControlOptions>;
    if (
      !options.database ||
      !options.client ||
      !options.profiles ||
      !options.userDataPath ||
      !options.getOwner ||
      !options.getAuthState ||
      !options.getRuntimeVersion ||
      !options.getConnectionMode ||
      !options.assertEntitled
    ) {
      throw codedError("operation_failed");
    }
    return options as FullAgentControlOptions;
  }

  private requireDrafts(
    context: AgentAssetContext = this.assetContext(),
  ): AgentDraftStore {
    const full = this.requireFull();
    return new AgentDraftStore({
      database: full.database,
      owner: full.getOwner(),
      context,
    });
  }

  private owner(): AgenteraRuntimeOwner {
    return this.requireFull().getOwner();
  }

  private conversationBoundaryStore(
    owner: AgenteraRuntimeOwner,
  ): ConversationBoundaryStore {
    return new ConversationBoundaryStore({
      database: this.requireFull().database,
      owner,
      now: this.options.now,
      randomUUID: this.options.randomUUID,
    });
  }

  private context(): NormalizedAgentContext {
    return normalizeAgentContext(this.options.getAgentContext?.());
  }

  private assetContext(): AgentAssetContext {
    return this.context();
  }

  private operationAssetContext(
    scope?: AgenteraAgentOperationScope,
  ): AgentAssetContext {
    return scope === "USER" ? { scope: "USER" } : this.assetContext();
  }

  private operationContextKey(
    context: AgentAssetContext = this.assetContext(),
  ): string {
    return `${runtimeComponentKey(this.owner())}\0${contextKey(context)}`;
  }

  private assertWorkspacePublicationRole(
    context: AgentAssetContext = this.assetContext(),
  ): void {
    this.assertLocalAccess();
    if (context.scope === "ORGANIZATION") {
      throw codedError("organization_agent_forbidden");
    }
    if (context.scope === "WORKSPACE" && context.role === "member") {
      throw codedError("workspace_forbidden");
    }
  }

  private assertWorkspaceReviewRole(): void {
    this.assertLocalAccess();
    const context = this.assetContext();
    if (context.scope !== "WORKSPACE" || context.role === "member") {
      throw codedError("workspace_forbidden");
    }
  }

  private assertAuthoringAccess(
    context: AgentAssetContext = this.assetContext(),
  ): void {
    this.assertLocalAccess();
    if (context.scope === "USER") return;
    if (context.scope === "WORKSPACE" && context.role === "member") {
      throw codedError("workspace_forbidden");
    }
    if (
      context.scope === "ORGANIZATION" &&
      context.role !== "owner" &&
      context.role !== "admin"
    ) {
      throw codedError("organization_agent_forbidden");
    }
    const state = this.requireFull().getAuthState();
    if (state.status !== "authenticated" || !state.cloudAvailable) {
      throw codedError("online_required");
    }
  }

  private assertDraftReadAccess(
    context: AgentAssetContext = this.assetContext(),
  ): void {
    this.assertLocalAccess();
    if (
      context.scope === "ORGANIZATION" &&
      context.role !== "owner" &&
      context.role !== "admin"
    ) {
      throw codedError("organization_agent_forbidden");
    }
  }

  private assertOrganizationPublicationRole(): void {
    this.assertLocalAccess();
    const context = this.assetContext();
    if (
      context.scope !== "ORGANIZATION" ||
      (context.role !== "owner" && context.role !== "admin")
    ) {
      throw codedError("organization_agent_forbidden");
    }
  }

  private assertOrganizationHistoryRole(): void {
    this.assertLocalAccess();
    const context = this.assetContext();
    if (context.scope !== "ORGANIZATION" || context.role === "member") {
      throw codedError("organization_agent_forbidden");
    }
  }

  private assertInstallationRole(
    context: AgentAssetContext = this.assetContext(),
  ): void {
    this.assertLocalAccess();
    if (context.scope === "ORGANIZATION" && context.role === "auditor") {
      throw codedError("organization_agent_forbidden");
    }
  }

  private assertInstallationInContext(
    installation: LocalAgentInstallation,
    context: AgentAssetContext = this.assetContext(),
  ): void {
    if (!installationMatchesContext(installation, context)) {
      throw codedError("installation_not_found");
    }
  }

  private assertLocalAccess(): void {
    this.assertProductAccess();
  }

  private assertProductAccess(): void {
    const full = this.requireFull();
    const state = full.getAuthState();
    if (state.status !== "authenticated" && state.status !== "offline") {
      throw codedError("sign_in_required");
    }
    full.assertEntitled();
  }

  private async assertOnlineAccess(refreshKeys: boolean): Promise<void> {
    const full = this.requireFull();
    const state = full.getAuthState();
    if (state.status !== "authenticated" || !state.cloudAvailable) {
      throw codedError("online_required");
    }
    await full.assertEntitled();
    if (refreshKeys) await this.refreshSigningKeys();
  }

  private async assertOnlineLocalRuntimeAccess(): Promise<void> {
    await this.assertOnlineAccess(false);
    if (this.requireFull().getConnectionMode() !== "local") {
      throw codedError("local_runtime_required");
    }
    await this.refreshSigningKeys();
  }

  private async refreshSigningKeys(): Promise<void> {
    const full = this.requireFull();
    if (!this.trust) throw codedError("operation_failed");
    const keys: AgentSigningKeySet = await full.client.getSigningKeys();
    const fetchedAt = new Date().toISOString();
    this.trust.replaceKeys(full.client.origin, keys, fetchedAt);
    persistTrustCache(full.database, this.trust, full.client.origin);
  }

  private async ensureRuntimeComponents(): Promise<RuntimeComponents> {
    const full = this.requireFull();
    if (!this.trust || !this.projection) {
      throw codedError("operation_failed");
    }
    const owner = full.getOwner();
    const runtimeVersion = requireRuntimeVersion(
      await full.getRuntimeVersion(),
    );
    const key = `${runtimeComponentKey(owner)}\0${runtimeVersion}`;
    if (this.runtime?.key === key) return this.runtime;
    this.publicationOwners.clear();
    this.contextComponents = null;
    this.experienceCandidateComponents?.service.clearPreparedImports();
    this.experienceCandidateComponents = null;
    this.officialAgentComponents?.service.invalidate();
    this.officialAgentComponents = null;
    const cache = new AgentVersionCache({
      database: full.database,
      owner,
      trust: this.trust,
      origin: full.client.origin,
      runtimeVersion,
    });
    const installations = new AgentInstallationManager({
      database: full.database,
      client: full.client,
      trust: this.trust,
      cache,
      projection: this.projection,
      profileBindings: this.profileBindings,
      profiles: full.profiles,
      owner,
      runtimeVersion,
    });
    const bindingStore = new RuntimeBindingStore({
      database: full.database,
      owner,
    });
    const hermes = new AgenteraHermesAdapter({
      database: full.database,
      bindingStore,
      profileBindings: this.profileBindings,
      cache,
      projection: this.projection,
      getConnectionMode: full.getConnectionMode,
      getRuntimeVersion: full.getRuntimeVersion,
      getProfileModelConfig: (profilePath) => {
        if (!full.profiles.readProfileModelConfig) {
          throw codedError("operation_failed");
        }
        return full.profiles.readProfileModelConfig(profilePath);
      },
      isVersionRevoked: full.isVersionRevoked ?? (() => false),
      assertEntitled: full.assertEntitled,
      getAgentContext: () => this.context(),
    });
    this.runtime = {
      key,
      runtimeVersion,
      cache,
      installations,
      hermes,
      bindingStore,
    };
    return this.runtime;
  }

  private async ensureContextComponents(
    context: AgentAssetContext = this.assetContext(),
  ): Promise<ContextComponents> {
    const full = this.requireFull();
    if (!this.trust) throw codedError("operation_failed");
    const runtime = await this.ensureRuntimeComponents();
    const owner = full.getOwner();
    const key = `${runtime.key}\0${contextKey(context)}`;
    if (this.contextComponents?.key === key) return this.contextComponents;
    this.publicationOwners.clear();
    const publisher = new AgentPublisher({
      drafts: new AgentDraftStore({
        database: full.database,
        owner,
        context,
      }),
      client: full.client,
      trust: this.trust,
      cache: runtime.cache,
      context,
      runtimeVersion: runtime.runtimeVersion,
      refreshTrust: () => this.refreshSigningKeys(),
    });
    this.contextComponents = { key, publisher };
    return this.contextComponents;
  }

  private ensureOrganizationPublicationComponents(): OrganizationPublicationComponents {
    const full = this.requireFull();
    const owner = full.getOwner();
    const context = this.context();
    if (context.scope !== "ORGANIZATION") {
      throw codedError("organization_agent_forbidden");
    }
    const key = `${runtimeComponentKey(owner)}\0${contextKey(context)}`;
    if (this.organizationPublicationComponents?.key === key) {
      return this.organizationPublicationComponents;
    }
    this.organizationPublicationComponents?.service.invalidate();
    const service = new OrganizationPublicationService({
      database: full.database,
      ...(context.role === "owner" || context.role === "admin"
        ? {
            drafts: new AgentDraftStore({
              database: full.database,
              owner,
              context,
              now: full.now,
              randomUUID: full.randomUUID,
            }),
          }
        : {}),
      client: full.client,
      getContext: () => this.context(),
      getActorUserId: () => full.getOwner().ownerId,
      isOnline: () => {
        const state = full.getAuthState();
        return state.status === "authenticated" && state.cloudAvailable;
      },
      now: full.now,
      randomUUID: full.randomUUID,
    });
    this.organizationPublicationComponents = { key, service };
    return this.organizationPublicationComponents;
  }

  private ensureOfficialAgentComponents(): OfficialAgentComponents {
    const full = this.requireFull();
    const key = `${this.operationContextKey()}\0${full.client.getOfficialAgentChannel()}`;
    if (this.officialAgentComponents?.key === key) {
      return this.officialAgentComponents;
    }
    this.officialAgentComponents?.service.invalidate();
    const service = new OfficialAgentService({
      client: full.client,
      installer: {
        install: async (input) =>
          (await this.ensureRuntimeComponents()).installations.install(input),
        listManagedInstallations: () => {
          if (!this.runtime) throw codedError("local_runtime_required");
          return this.runtime.installations.listManagedInstallations();
        },
        applyManagedOfficialUpdate: async (installationId) =>
          (
            await this.ensureRuntimeComponents()
          ).installations.applyManagedOfficialUpdate(installationId),
      },
      getOwner: full.getOwner,
      getContext: () => this.context(),
      isOnline: () => {
        const state = full.getAuthState();
        return state.status === "authenticated" && state.cloudAvailable;
      },
      now: full.now,
      randomUUID: full.randomUUID,
    });
    this.officialAgentComponents = { key, service };
    return this.officialAgentComponents;
  }

  private async ensureExperienceCandidateComponents(): Promise<ExperienceCandidateComponents> {
    const full = this.requireFull();
    const runtime = await this.ensureRuntimeComponents();
    const owner = full.getOwner();
    const context = this.assetContext();
    if (context.scope === "ORGANIZATION") {
      throw codedError("workspace_forbidden");
    }
    const key = `${runtime.key}\0${contextKey(context)}`;
    if (this.experienceCandidateComponents?.key === key) {
      return this.experienceCandidateComponents;
    }
    const candidates = new ExperienceCandidateStore({
      database: full.database,
      owner,
      now: full.now,
      randomUUID: full.randomUUID,
    });
    const drafts = new AgentDraftStore({
      database: full.database,
      owner,
      context,
      now: full.now,
      randomUUID: full.randomUUID,
    });
    const importer = new ExperienceCandidateImporter({
      database: full.database,
      client: full.client,
      candidates,
      drafts,
      cache: runtime.cache,
      owner,
      now: full.now,
      randomUUID: full.randomUUID,
    });
    const service = new ExperienceCandidateService({
      client: full.client,
      store: candidates,
      source: new ReadOnlyHermesSkillCandidateSource(),
      getInstallation: (id) => runtime.installations.getLocalInstallation(id),
      resolveProfilePath: (runtimeProfileId, agentInstallationId) =>
        this.profileBindings.resolveAttachedProfilePath(
          runtimeProfileId,
          agentInstallationId,
          owner,
        ),
      getContext: () => {
        const current = this.assetContext();
        if (current.scope === "USER") return { scope: "USER" };
        if (current.scope === "ORGANIZATION") {
          throw codedError("workspace_forbidden");
        }
        return {
          scope: "WORKSPACE",
          workspaceId: current.workspaceId,
          role: current.role,
        };
      },
      getAuthState: full.getAuthState,
      importer,
      now: full.now,
      randomUUID: full.randomUUID,
    });
    this.experienceCandidateComponents = { key, service };
    return this.experienceCandidateComponents;
  }

  private emitState(): void {
    let state: AgenteraAgentControlPublicState;
    try {
      state = this.getState();
    } catch {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener({ ...state });
      } catch {
        // A renderer listener cannot change control-plane state.
      }
    }
  }

  /**
   * RuntimeBinding upload is a best-effort sanitized outbox. Hermes receives
   * the locally committed binding immediately; cloud availability can never
   * delay, reject, or roll back the native turn.
   */
  private queueRuntimeBindingDelivery(): void {
    if (!this.options.retryPendingRuntimeBindings && !this.options.client) {
      return;
    }
    this.runtimeBindingDeliveryRequested = true;
    if (this.runtimeBindingDeliveryInFlight) return;
    this.runtimeBindingDeliveryInFlight = true;
    void (async () => {
      while (this.runtimeBindingDeliveryRequested) {
        this.runtimeBindingDeliveryRequested = false;
        try {
          if (this.options.retryPendingRuntimeBindings) {
            await this.options.retryPendingRuntimeBindings();
            continue;
          }
          const full = this.requireFull();
          const state = full.getAuthState();
          if (state.status !== "authenticated" || !state.cloudAvailable) {
            continue;
          }
          const components = await this.ensureRuntimeComponents();
          await components.bindingStore.retryPendingCloudRecords(full.client);
        } catch {
          // The durable local record remains queued for a later auth change or
          // installed conversation. Cloud failure cannot affect Hermes.
        }
      }
    })().finally(() => {
      this.runtimeBindingDeliveryInFlight = false;
      if (this.runtimeBindingDeliveryRequested) {
        this.queueRuntimeBindingDelivery();
      }
    });
  }

  private queueInstallationReconciliation(): void {
    let full: FullAgentControlOptions;
    try {
      full = this.requireFull();
    } catch {
      return;
    }
    const state = full.getAuthState();
    if (
      state.status !== "authenticated" ||
      !state.cloudAvailable ||
      full.getConnectionMode() !== "local"
    ) {
      return;
    }
    const ownerKey = runtimeComponentKey(full.getOwner());
    void (async () => {
      const runtimeVersion = requireRuntimeVersion(
        await full.getRuntimeVersion(),
      );
      const key = `${ownerKey}\0${runtimeVersion}`;
      if (this.installationReconciliationFlights.has(key)) return;
      const flight = (async (): Promise<void> => {
        const currentState = full.getAuthState();
        if (
          currentState.status !== "authenticated" ||
          !currentState.cloudAvailable ||
          full.getConnectionMode() !== "local" ||
          runtimeComponentKey(full.getOwner()) !== ownerKey
        ) {
          return;
        }
        const components = await this.ensureRuntimeComponents();
        if (components.key !== key) return;
        const readyState = full.getAuthState();
        if (
          readyState.status !== "authenticated" ||
          !readyState.cloudAvailable ||
          full.getConnectionMode() !== "local" ||
          runtimeComponentKey(full.getOwner()) !== ownerKey
        ) {
          return;
        }
        await components.installations.reconcilePendingInstallations();
      })();
      this.installationReconciliationFlights.set(key, flight);
      try {
        await flight;
      } finally {
        if (this.installationReconciliationFlights.get(key) === flight) {
          this.installationReconciliationFlights.delete(key);
        }
      }
    })().catch(() => {
      console.error("[AGENTERA_INSTALLATION_RECONCILIATION] failed");
    });
  }
}
