import { randomUUID as nodeRandomUUID } from "node:crypto";
import type {
  AgenteraAgentControlContext,
  ConfirmOfficialAgentInstallInput,
  OfficialAgentInstallPreview,
  OfficialAgentSummary,
  OfficialManagedUpdate,
} from "../../shared/agentera-agent-control";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import { AgenteraAgentControlClientError } from "./client";
import type { OfficialAgentChannel } from "./official-channel";
import {
  AgentInstallationManagerError,
  type AgentInstallationSource,
  type LocalAgentInstallation,
} from "./installation-manager";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_HANDLE_TTL_MS = 5 * 60 * 1000;

export interface OfficialAgentServiceClient {
  listOfficialAgents(): Promise<OfficialAgentSummary[]>;
  getOfficialRelease(definitionId: string): Promise<OfficialAgentSummary>;
  getManagedUpdate(
    installationId: string,
  ): Promise<OfficialManagedUpdate | null>;
  getOfficialAgentChannel(): OfficialAgentChannel;
}

export interface OfficialAgentServiceInstaller {
  install(input: {
    definitionId: string;
    versionId: string;
    source: Extract<AgentInstallationSource, { scope: "PLATFORM" }>;
    profile: { kind: "fresh"; name: string };
  }): Promise<LocalAgentInstallation>;
  listManagedInstallations(): LocalAgentInstallation[];
  applyManagedOfficialUpdate(
    installationId: string,
  ): Promise<LocalAgentInstallation>;
}

export interface OfficialAgentServiceOptions {
  client: OfficialAgentServiceClient;
  installer: OfficialAgentServiceInstaller;
  getOwner: () => AgenteraRuntimeOwner;
  getContext: () => AgenteraAgentControlContext;
  isOnline: () => boolean;
  now?: () => Date;
  randomUUID?: () => string;
  handleTtlMs?: number;
}

interface PreparedInstall {
  operationKey: string;
  agent: OfficialAgentSummary;
  expiresAt: number;
}

export class OfficialAgentServiceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Official Agent operation failed: ${code}.`);
    this.name = "OfficialAgentServiceError";
    this.code = code;
  }
}

function codedError(code: string): OfficialAgentServiceError {
  return new OfficialAgentServiceError(code);
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw codedError("invalid_request");
  }
  return value;
}

function serviceError(error: unknown): OfficialAgentServiceError {
  if (error instanceof OfficialAgentServiceError) return error;
  if (
    error instanceof AgenteraAgentControlClientError ||
    error instanceof AgentInstallationManagerError
  ) {
    return codedError(error.code);
  }
  return codedError("operation_failed");
}

function safeSummary(value: OfficialAgentSummary): OfficialAgentSummary {
  return {
    definitionId: value.definitionId,
    displayName: value.displayName,
    iconMediaType: value.iconMediaType,
    iconDataBase64Url: value.iconDataBase64Url,
    versionId: value.versionId,
    versionNumber: value.versionNumber,
    releaseId: value.releaseId,
    releaseRevisionId: value.releaseRevisionId,
    channel: value.channel,
    runtimeMinimumVersion: value.runtimeMinimumVersion,
    runtimeMaximumVersionExclusive: value.runtimeMaximumVersionExclusive,
    installationState: value.installationState,
    updateState: value.updateState,
  };
}

function sameRelease(
  prepared: OfficialAgentSummary,
  current: OfficialAgentSummary,
): boolean {
  return (
    prepared.definitionId === current.definitionId &&
    prepared.versionId === current.versionId &&
    prepared.versionNumber === current.versionNumber &&
    prepared.releaseId === current.releaseId &&
    prepared.releaseRevisionId === current.releaseRevisionId &&
    prepared.channel === current.channel &&
    prepared.runtimeMinimumVersion === current.runtimeMinimumVersion &&
    prepared.runtimeMaximumVersionExclusive ===
      current.runtimeMaximumVersionExclusive
  );
}

export class OfficialAgentService {
  private readonly client: OfficialAgentServiceClient;
  private readonly installer: OfficialAgentServiceInstaller;
  private readonly getOwner: () => AgenteraRuntimeOwner;
  private readonly getContext: () => AgenteraAgentControlContext;
  private readonly isOnline: () => boolean;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly handleTtlMs: number;
  private readonly preparedInstalls = new Map<string, PreparedInstall>();

  constructor(options: OfficialAgentServiceOptions) {
    const ttl = options.handleTtlMs ?? DEFAULT_HANDLE_TTL_MS;
    if (
      typeof options.getOwner !== "function" ||
      typeof options.getContext !== "function" ||
      typeof options.isOnline !== "function" ||
      !Number.isSafeInteger(ttl) ||
      ttl < 1 ||
      ttl > 30 * 60 * 1000
    ) {
      throw new Error("Official Agent service is misconfigured.");
    }
    this.client = options.client;
    this.installer = options.installer;
    this.getOwner = options.getOwner;
    this.getContext = options.getContext;
    this.isOnline = options.isOnline;
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.handleTtlMs = ttl;
  }

  async list(): Promise<OfficialAgentSummary[]> {
    try {
      this.assertOnline();
      return (await this.client.listOfficialAgents()).map(safeSummary);
    } catch (error) {
      throw serviceError(error);
    }
  }

  async prepareInstall(
    definitionIdInput: string,
  ): Promise<OfficialAgentInstallPreview> {
    try {
      this.assertOnline();
      const definitionId = requireUuid(definitionIdInput);
      const agent = await this.client.getOfficialRelease(definitionId);
      if (
        agent.definitionId !== definitionId ||
        agent.channel !== this.client.getOfficialAgentChannel()
      ) {
        throw codedError("verification_failed");
      }
      const handle = this.newHandle();
      const expiresAt = this.nowMilliseconds() + this.handleTtlMs;
      this.preparedInstalls.set(handle, {
        operationKey: this.operationKey(),
        agent: safeSummary(agent),
        expiresAt,
      });
      return {
        installHandle: handle,
        agent: safeSummary(agent),
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      throw serviceError(error);
    }
  }

  async confirmInstall(
    input: ConfirmOfficialAgentInstallInput,
  ): Promise<LocalAgentInstallation> {
    try {
      const prepared = this.consume(input?.installHandle);
      if (input.confirmation !== "install-official-agent") {
        throw codedError("official_install_handle_invalid");
      }
      this.assertOnline();
      if (prepared.operationKey !== this.operationKey()) {
        throw codedError("official_install_handle_invalid");
      }
      const current = await this.client.getOfficialRelease(
        prepared.agent.definitionId,
      );
      if (!sameRelease(prepared.agent, current)) {
        throw codedError("official_release_changed");
      }
      const installed = await this.installer.install({
        definitionId: current.definitionId,
        versionId: current.versionId,
        source: {
          scope: "PLATFORM",
          officialReleaseId: current.releaseId,
          selectedReleaseRevisionId: current.releaseRevisionId,
          updatePolicy: "managed",
        },
        profile: { kind: "fresh", name: current.displayName },
      });
      if (
        installed.sourceScope !== "PLATFORM" ||
        installed.definitionId !== current.definitionId ||
        installed.selectedVersionId !== current.versionId ||
        installed.officialReleaseId !== current.releaseId ||
        installed.selectedReleaseRevisionId !== current.releaseRevisionId ||
        installed.updatePolicy !== "managed"
      ) {
        throw codedError("installation_conflict");
      }
      return installed;
    } catch (error) {
      throw serviceError(error);
    }
  }

  async refreshManagedUpdates(): Promise<OfficialManagedUpdate[]> {
    try {
      this.assertOnline();
      const updates: OfficialManagedUpdate[] = [];
      for (const installation of this.installer.listManagedInstallations()) {
        if (
          installation.sourceScope !== "PLATFORM" ||
          installation.updatePolicy !== "managed" ||
          installation.selectedReleaseRevisionId === null ||
          installation.status !== "active"
        ) {
          continue;
        }
        const update = await this.client.getManagedUpdate(
          requireUuid(installation.agentInstallationId),
        );
        if (update === null) continue;
        if (
          requireUuid(update.installationId) !==
            installation.agentInstallationId ||
          requireUuid(update.expectedSelectedReleaseRevisionId) !==
            installation.selectedReleaseRevisionId ||
          requireUuid(update.targetReleaseRevisionId) ===
            installation.selectedReleaseRevisionId
        ) {
          throw codedError("verification_failed");
        }
        updates.push({
          installationId: update.installationId,
          expectedSelectedReleaseRevisionId:
            update.expectedSelectedReleaseRevisionId,
          targetReleaseRevisionId: update.targetReleaseRevisionId,
          targetVersionId: requireUuid(update.targetVersionId),
        });
      }
      return updates;
    } catch (error) {
      throw serviceError(error);
    }
  }

  async applyManagedUpdate(
    installationIdInput: string,
  ): Promise<LocalAgentInstallation> {
    try {
      this.assertOnline();
      const installationId = requireUuid(installationIdInput);
      const updated =
        await this.installer.applyManagedOfficialUpdate(installationId);
      if (
        updated.agentInstallationId !== installationId ||
        updated.sourceScope !== "PLATFORM" ||
        updated.updatePolicy !== "managed" ||
        updated.officialReleaseId === null ||
        updated.selectedReleaseRevisionId === null ||
        updated.runtimeProfileId === null ||
        updated.policySnapshotId === null ||
        updated.status !== "active"
      ) {
        throw codedError("installation_conflict");
      }
      return updated;
    } catch (error) {
      throw serviceError(error);
    }
  }

  invalidate(): void {
    this.preparedInstalls.clear();
  }

  private assertOnline(): void {
    if (!this.isOnline()) throw codedError("online_required");
  }

  private nowMilliseconds(): number {
    const value = this.now();
    const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
    if (!Number.isFinite(milliseconds)) throw codedError("operation_failed");
    return milliseconds;
  }

  private operationKey(): string {
    const owner = this.getOwner();
    const channel = this.client.getOfficialAgentChannel();
    const ownerKey = [
      requireUuid(owner.tenantId),
      requireUuid(owner.ownerId),
      requireUuid(owner.deviceInstallationId),
    ].join("\0");
    const context = this.getContext();
    if (context.scope === "USER") return `${ownerKey}\0${channel}\0USER`;
    if (context.scope === "WORKSPACE") {
      return `${ownerKey}\0${channel}\0WORKSPACE\0${requireUuid(context.workspaceId)}\0${context.role}`;
    }
    return `${ownerKey}\0${channel}\0ORGANIZATION\0${requireUuid(context.organizationId)}\0${context.role}`;
  }

  private newHandle(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const handle = requireUuid(this.randomUUID());
      if (!this.preparedInstalls.has(handle)) return handle;
    }
    throw codedError("operation_failed");
  }

  private consume(handleInput: unknown): PreparedInstall {
    const handle = requireUuid(handleInput);
    const prepared = this.preparedInstalls.get(handle);
    this.preparedInstalls.delete(handle);
    if (!prepared || prepared.expiresAt <= this.nowMilliseconds()) {
      throw codedError("official_install_handle_invalid");
    }
    return prepared;
  }
}
