import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  AgentDraft,
  AgentDraftDetail,
  AgenteraAgentControlPublicState,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  AgenteraAgentVersionSummary,
  AgenteraClaimVersionInput,
  AgenteraInstallVersionInput,
  AgenteraRetryPendingInstallationInput,
  AgenteraSelectInstallationVersionInput,
  CreateAgentDraftInput,
  PublicationPreview,
  PublishedRevision,
  UpdateAgentDraftInput,
} from "../../shared/agentera-agent-control";
import type {
  AgenteraProfileBindingStore,
  AgenteraRuntimeOwner,
} from "../agentera-profile-binding";
import type { AgentInstallationProfileAdapter } from "./installation-manager";
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
import { RuntimeBindingStore } from "./runtime-binding-store";
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

interface FullAgentControlOptions {
  database: AgenteraControlPlaneDatabase;
  client: AgenteraAgentControlClient;
  profiles: AgentInstallationProfileAdapter;
  userDataPath: string;
  getOwner: () => AgenteraRuntimeOwner;
  getAgentContext?: () => AgentAssetContext;
  getAuthState: () => AgenteraAuthPublicState;
  getRuntimeVersion: () => string | Promise<string>;
  getConnectionMode: () => "local" | "remote" | "ssh";
  assertEntitled: () => void;
  isVersionRevoked?: (versionId: string) => boolean | Promise<boolean>;
}

export interface AgenteraAgentControlManagerOptions extends Partial<FullAgentControlOptions> {
  profileBindings: AgenteraProfileBindingStore;
  /** Task-12 compatibility seam used by focused manager tests. */
  hermesAdapter?: AgenteraHermesAdapter;
  /** Test seam for proving that cloud outbox delivery never blocks Hermes. */
  retryPendingRuntimeBindings?: () => Promise<unknown>;
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function codedError(code: string): Error {
  return Object.assign(new Error(`AgentEra Agent control failed: ${code}.`), {
    code,
  });
}

function ownerKey(owner: AgenteraRuntimeOwner): string {
  return `${owner.tenantId}\0${owner.ownerId}\0${owner.deviceInstallationId}`;
}

function normalizeAgentContext(
  context: AgentAssetContext | undefined,
): AgentAssetContext {
  if (context === undefined || context.scope === "USER") {
    return { scope: "USER" };
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

function contextKey(context: AgentAssetContext): string {
  return context.scope === "USER"
    ? "USER"
    : `WORKSPACE\0${context.workspaceId}\0${context.role}`;
}

function installationMatchesContext(
  installation: LocalAgentInstallation,
  context: AgentAssetContext,
): boolean {
  return context.scope === "USER"
    ? installation.sourceScope === "USER" &&
        installation.sourceWorkspaceId === null
    : installation.sourceScope === "WORKSPACE" &&
        installation.sourceWorkspaceId === context.workspaceId;
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
  private readonly publicationOwners = new Map<string, string>();
  private readonly listeners = new Set<
    (state: AgenteraAgentControlPublicState) => void
  >();
  private runtimeBindingDeliveryInFlight = false;
  private runtimeBindingDeliveryRequested = false;

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
    this.assertLocalAccess();
    const state = this.requireFull().getAuthState();
    const owner = this.owner();
    const context = this.context();
    const workspaceId =
      context.scope === "WORKSPACE" ? context.workspaceId : null;
    const draftCount = this.options.database?.sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_drafts
         WHERE tenant_id = ? AND owner_id = ?
           AND target_scope = ? AND workspace_id IS ?`,
      )
      .get(owner.tenantId, owner.ownerId, context.scope, workspaceId) as
      | { count?: unknown }
      | undefined;
    const installationCount = this.options.database?.sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM local_agent_installations
         WHERE tenant_id = ? AND owner_id = ? AND device_installation_id = ?
           AND source_scope = ? AND source_workspace_id IS ?`,
      )
      .get(
        owner.tenantId,
        owner.ownerId,
        owner.deviceInstallationId,
        context.scope,
        workspaceId,
      ) as { count?: unknown } | undefined;
    return {
      access: state.status === "offline" ? "offline" : "online",
      cloudAvailable:
        (state.status === "authenticated" || state.status === "offline") &&
        state.cloudAvailable,
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
    this.publicationOwners.clear();
    this.emitState();
    this.queueRuntimeBindingDelivery();
  }

  notifyAgentContextChanged(): void {
    this.contextComponents = null;
    this.publicationOwners.clear();
    this.emitState();
  }

  listDrafts(): AgentDraft[] {
    this.assertLocalAccess();
    return this.requireDrafts().listDrafts();
  }

  getDraft(id: string): AgentDraftDetail {
    this.assertLocalAccess();
    return this.requireDrafts().getDraftDetail(id);
  }

  createDraft(input: CreateAgentDraftInput): AgentDraftDetail {
    this.assertAuthoringAccess();
    const created = this.requireDrafts().createDraft(input);
    const result = this.requireDrafts().getDraftDetail(created.id);
    this.emitState();
    return result;
  }

  updateDraft(input: UpdateAgentDraftInput): AgentDraftDetail {
    this.assertAuthoringAccess();
    const updated = this.requireDrafts().updateDraft(input);
    const result = this.requireDrafts().getDraftDetail(updated.id);
    this.emitState();
    return result;
  }

  deleteDraft(id: string): true {
    this.assertAuthoringAccess();
    this.requireDrafts().deleteDraft(id);
    this.emitState();
    return true;
  }

  async preparePublication(id: string): Promise<PublicationPreview> {
    this.assertWorkspacePublicationRole();
    await this.assertOnlineAccess(true);
    const components = await this.ensureContextComponents();
    const preview = components.publisher.preparePublication(id);
    this.publicationOwners.set(
      preview.publicationHandle,
      this.operationContextKey(),
    );
    return preview;
  }

  async confirmPublication(handle: string): Promise<PublishedRevision> {
    this.assertWorkspacePublicationRole();
    const expectedOwner = this.publicationOwners.get(handle);
    this.publicationOwners.delete(handle);
    if (!expectedOwner || expectedOwner !== this.operationContextKey()) {
      throw codedError("publication_confirmation_invalid");
    }
    await this.assertOnlineAccess(true);
    const result = await (
      await this.ensureContextComponents()
    ).publisher.confirmPublication(handle);
    this.emitState();
    return result;
  }

  async listDefinitions(): Promise<AgenteraAgentDefinitionSummary[]> {
    await this.assertOnlineAccess(false);
    const context = this.context();
    const definitions =
      context.scope === "USER"
        ? await this.requireFull().client.listDefinitions()
        : await this.requireFull().client.listWorkspaceDefinitions(
            context.workspaceId,
          );
    return definitions.map(serializeDefinition);
  }

  async listVersions(
    definitionId: string,
  ): Promise<AgenteraAgentVersionSummary[]> {
    await this.assertOnlineAccess(false);
    const context = this.context();
    const versions =
      context.scope === "USER"
        ? await this.requireFull().client.listVersions(definitionId)
        : await this.requireFull().client.listWorkspaceVersions(
            context.workspaceId,
            definitionId,
          );
    return versions.map(serializeVersion);
  }

  async listInstallations(): Promise<AgenteraAgentInstallationSummary[]> {
    this.assertLocalAccess();
    return (await this.ensureRuntimeComponents()).installations
      .listLocalInstallations(this.context())
      .map(serializeInstallation);
  }

  async installVersion(
    input: AgenteraInstallVersionInput,
  ): Promise<AgenteraAgentInstallationSummary> {
    await this.assertOnlineLocalRuntimeAccess();
    const source = this.context();
    const result = await (
      await this.ensureRuntimeComponents()
    ).installations.install({
      definitionId: input.definitionId,
      versionId: input.versionId,
      source,
      profile: { kind: "fresh", name: input.profileName },
    });
    this.emitState();
    return serializeInstallation(result);
  }

  async claimVersion(
    input: AgenteraClaimVersionInput,
  ): Promise<AgenteraAgentInstallationSummary> {
    await this.assertOnlineLocalRuntimeAccess();
    if (input.confirmation !== "claim-existing-profile") {
      throw codedError("invalid_request");
    }
    const source = this.context();
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
  ): Promise<AgenteraAgentInstallationSummary> {
    await this.assertOnlineLocalRuntimeAccess();
    const profiles = this.requireFull().profiles;
    const components = await this.ensureRuntimeComponents();
    this.assertInstallationInContext(
      components.installations.getLocalInstallation(input.id),
    );
    const target =
      input.target.kind === "fresh"
        ? ({ kind: "fresh", name: input.target.profileName } as const)
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
  ): Promise<AgenteraAgentInstallationSummary> {
    await this.assertOnlineLocalRuntimeAccess();
    const components = await this.ensureRuntimeComponents();
    this.assertInstallationInContext(
      components.installations.getLocalInstallation(input.id),
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

  async archiveInstallation(
    id: string,
  ): Promise<AgenteraAgentInstallationSummary> {
    await this.assertOnlineAccess(true);
    const components = await this.ensureRuntimeComponents();
    this.assertInstallationInContext(
      components.installations.getLocalInstallation(id),
    );
    const result = await components.installations.archiveInstallation(id);
    this.emitState();
    return serializeInstallation(result);
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

  attachHermesSession(bindingId: string, sessionId: string): void {
    const adapter = this.runtimeOnlyHermes ?? this.runtime?.hermes;
    if (!adapter) throw codedError("binding_required");
    adapter.attachHermesSession(bindingId, sessionId);
    this.queueRuntimeBindingDelivery();
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

  private requireDrafts(): AgentDraftStore {
    const full = this.requireFull();
    return new AgentDraftStore({
      database: full.database,
      owner: full.getOwner(),
      context: this.context(),
    });
  }

  private owner(): AgenteraRuntimeOwner {
    return this.requireFull().getOwner();
  }

  private context(): AgentAssetContext {
    return normalizeAgentContext(this.options.getAgentContext?.());
  }

  private operationContextKey(): string {
    return `${ownerKey(this.owner())}\0${contextKey(this.context())}`;
  }

  private assertWorkspacePublicationRole(): void {
    this.assertLocalAccess();
    const context = this.context();
    if (context.scope === "WORKSPACE" && context.role === "member") {
      throw codedError("workspace_forbidden");
    }
  }

  private assertAuthoringAccess(): void {
    this.assertWorkspacePublicationRole();
    const context = this.context();
    if (context.scope !== "WORKSPACE") return;
    const state = this.requireFull().getAuthState();
    if (state.status !== "authenticated" || !state.cloudAvailable) {
      throw codedError("online_required");
    }
  }

  private assertInstallationInContext(
    installation: LocalAgentInstallation,
  ): void {
    if (!installationMatchesContext(installation, this.context())) {
      throw codedError("installation_not_found");
    }
  }

  private assertLocalAccess(): void {
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
    const key = `${ownerKey(owner)}\0${runtimeVersion}`;
    if (this.runtime?.key === key) return this.runtime;
    this.publicationOwners.clear();
    this.contextComponents = null;
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
      isVersionRevoked: full.isVersionRevoked ?? (() => false),
      assertEntitled: full.assertEntitled,
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

  private async ensureContextComponents(): Promise<ContextComponents> {
    const full = this.requireFull();
    if (!this.trust) throw codedError("operation_failed");
    const runtime = await this.ensureRuntimeComponents();
    const owner = full.getOwner();
    const context = this.context();
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
    });
    this.contextComponents = { key, publisher };
    return this.contextComponents;
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
}
