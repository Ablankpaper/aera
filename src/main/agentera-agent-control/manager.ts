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
import { AgentInstallationManager } from "./installation-manager";
import type { AgenteraControlPlaneDatabase } from "./db";
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
}

interface RuntimeComponents {
  key: string;
  publisher: AgentPublisher;
  installations: AgentInstallationManager;
  hermes: AgenteraHermesAdapter;
}

function codedError(code: string): Error {
  return Object.assign(new Error(`AgentEra Agent control failed: ${code}.`), {
    code,
  });
}

function ownerKey(owner: AgenteraRuntimeOwner): string {
  return `${owner.tenantId}\0${owner.ownerId}\0${owner.deviceInstallationId}`;
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
  private readonly drafts: AgentDraftStore | null;
  private readonly trust: AgenteraAgentTrustStore | null;
  private readonly projection: HermesProjectionManager | null;
  private readonly bindingStore: RuntimeBindingStore | null;
  private runtime: RuntimeComponents | null = null;
  private readonly publicationOwners = new Map<string, string>();
  private readonly listeners = new Set<
    (state: AgenteraAgentControlPublicState) => void
  >();

  constructor(options: AgenteraAgentControlManagerOptions) {
    this.options = options;
    this.profileBindings = options.profileBindings;
    this.runtimeOnlyHermes = options.hermesAdapter ?? null;
    if (options.database) {
      this.drafts = new AgentDraftStore({ database: options.database });
      this.trust = new AgenteraAgentTrustStore({
        cache: loadTrustCache(options.database),
      });
      if (!options.userDataPath) throw codedError("invalid_request");
      this.projection = new HermesProjectionManager({
        userDataPath: options.userDataPath,
      });
      this.bindingStore = new RuntimeBindingStore({
        database: options.database,
      });
    } else {
      this.drafts = null;
      this.trust = null;
      this.projection = null;
      this.bindingStore = null;
    }
  }

  getState(): AgenteraAgentControlPublicState {
    this.assertLocalAccess();
    const state = this.requireFull().getAuthState();
    const draftCount = this.options.database?.sqlite
      .prepare("SELECT COUNT(*) AS count FROM agent_drafts")
      .get() as { count?: unknown } | undefined;
    const installationCount = this.options.database?.sqlite
      .prepare("SELECT COUNT(*) AS count FROM local_agent_installations")
      .get() as { count?: unknown } | undefined;
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
    this.assertLocalAccess();
    const created = this.requireDrafts().createDraft(input);
    const result = this.requireDrafts().getDraftDetail(created.id);
    this.emitState();
    return result;
  }

  updateDraft(input: UpdateAgentDraftInput): AgentDraftDetail {
    this.assertLocalAccess();
    const updated = this.requireDrafts().updateDraft(input);
    const result = this.requireDrafts().getDraftDetail(updated.id);
    this.emitState();
    return result;
  }

  deleteDraft(id: string): true {
    this.assertLocalAccess();
    this.requireDrafts().deleteDraft(id);
    this.emitState();
    return true;
  }

  async preparePublication(id: string): Promise<PublicationPreview> {
    await this.assertOnlineAccess(true);
    const components = await this.ensureRuntimeComponents();
    const preview = components.publisher.preparePublication(id);
    this.publicationOwners.set(
      preview.publicationHandle,
      ownerKey(this.owner()),
    );
    return preview;
  }

  async confirmPublication(handle: string): Promise<PublishedRevision> {
    await this.assertOnlineAccess(true);
    const expectedOwner = this.publicationOwners.get(handle);
    this.publicationOwners.delete(handle);
    if (!expectedOwner || expectedOwner !== ownerKey(this.owner())) {
      throw codedError("publication_confirmation_invalid");
    }
    const result = await (
      await this.ensureRuntimeComponents()
    ).publisher.confirmPublication(handle);
    this.emitState();
    return result;
  }

  async listDefinitions(): Promise<AgenteraAgentDefinitionSummary[]> {
    await this.assertOnlineAccess(false);
    return (await this.requireFull().client.listDefinitions()).map(
      serializeDefinition,
    );
  }

  async listVersions(
    definitionId: string,
  ): Promise<AgenteraAgentVersionSummary[]> {
    await this.assertOnlineAccess(false);
    return (await this.requireFull().client.listVersions(definitionId)).map(
      serializeVersion,
    );
  }

  async listInstallations(): Promise<AgenteraAgentInstallationSummary[]> {
    this.assertLocalAccess();
    return (await this.ensureRuntimeComponents()).installations
      .listLocalInstallations()
      .map(serializeInstallation);
  }

  async installVersion(
    input: AgenteraInstallVersionInput,
  ): Promise<AgenteraAgentInstallationSummary> {
    await this.assertOnlineLocalRuntimeAccess();
    const result = await (
      await this.ensureRuntimeComponents()
    ).installations.install({
      definitionId: input.definitionId,
      versionId: input.versionId,
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
    const profiles = this.requireFull().profiles;
    const result = await (
      await this.ensureRuntimeComponents()
    ).installations.install({
      definitionId: input.definitionId,
      versionId: input.versionId,
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
    const result = await (
      await this.ensureRuntimeComponents()
    ).installations.retryPendingInstallation({
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
    const result = await (
      await this.ensureRuntimeComponents()
    ).installations.selectInstallationVersion({
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
    const result = await (
      await this.ensureRuntimeComponents()
    ).installations.archiveInstallation(id);
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
    return adapter.prepareInstalledTurn(input);
  }

  attachHermesSession(bindingId: string, sessionId: string): void {
    const adapter = this.runtimeOnlyHermes ?? this.runtime?.hermes;
    if (!adapter) throw codedError("binding_required");
    adapter.attachHermesSession(bindingId, sessionId);
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
    if (!this.drafts) throw codedError("operation_failed");
    return this.drafts;
  }

  private owner(): AgenteraRuntimeOwner {
    return this.requireFull().getOwner();
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
    if (!this.trust || !this.projection || !this.bindingStore || !this.drafts) {
      throw codedError("operation_failed");
    }
    const owner = full.getOwner();
    const runtimeVersion = requireRuntimeVersion(
      await full.getRuntimeVersion(),
    );
    const key = `${ownerKey(owner)}\0${runtimeVersion}`;
    if (this.runtime?.key === key) return this.runtime;
    this.publicationOwners.clear();
    const cache = new AgentVersionCache({
      database: full.database,
      trust: this.trust,
      origin: full.client.origin,
      runtimeVersion,
    });
    const publisher = new AgentPublisher({
      drafts: this.drafts,
      client: full.client,
      trust: this.trust,
      cache,
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
    const hermes = new AgenteraHermesAdapter({
      database: full.database,
      bindingStore: this.bindingStore,
      profileBindings: this.profileBindings,
      cache,
      projection: this.projection,
      getConnectionMode: full.getConnectionMode,
      getRuntimeVersion: full.getRuntimeVersion,
      isVersionRevoked: full.isVersionRevoked ?? (() => false),
      assertEntitled: full.assertEntitled,
    });
    this.runtime = { key, publisher, installations, hermes };
    return this.runtime;
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
}
