import { join } from "node:path";
import type {
  AgenteraEncryptedBackupConfirmedRestore,
  AgenteraEncryptedBackupCreationResult,
  AgenteraEncryptedBackupProgress,
  AgenteraEncryptedBackupPublicDevice,
  AgenteraEncryptedBackupPublicEnrollment,
  AgenteraEncryptedBackupPublicState,
  AgenteraEncryptedBackupPublicSummary,
  AgenteraEncryptedBackupState,
} from "../../shared/agentera-encrypted-backup";
import type { RuntimeActivityCoordinator } from "../runtime-activity";
import type { AgenteraEncryptedBackupUserSource } from "../agentera-agent-control/manager";
import {
  AgenteraEncryptedBackupClient,
  type EncryptedBackupCloudDevice,
  type EncryptedBackupSummary,
} from "./client";
import {
  openAgenteraEncryptedBackupDatabase,
  type AgenteraEncryptedBackupDatabase,
} from "./db";
import {
  AgenteraEncryptedBackupKeyStore,
  type EncryptedBackupSecureStorage,
} from "./key-store";
import {
  AgenteraEncryptedBackupManager,
  EncryptedBackupUploadStore,
} from "./manager";
import {
  AgenteraEncryptedBackupRestoreService,
  type EncryptedBackupRestoreAgentControl,
  type PreparedEncryptedBackupRestore,
} from "./restore";
import {
  AgenteraEncryptedBackupScheduler,
  EncryptedBackupScheduleStore,
} from "./scheduler";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AgenteraEncryptedBackupPrincipal {
  accountId: string;
  deviceId: string;
  online: boolean;
  signDigest: (digest: Uint8Array) => string;
}

export interface AgenteraEncryptedBackupAgentControl extends EncryptedBackupRestoreAgentControl {
  resolveEncryptedBackupUserSource(
    installationId: string,
  ): Promise<AgenteraEncryptedBackupUserSource>;
}

export interface AgenteraEncryptedBackupControllerOptions {
  userDataPath: string;
  secureStorage: EncryptedBackupSecureStorage;
  activity: RuntimeActivityCoordinator;
  client: AgenteraEncryptedBackupClient;
  agentControl: AgenteraEncryptedBackupAgentControl;
  getPrincipal: () => AgenteraEncryptedBackupPrincipal | null;
  databaseFactory?: (userDataPath: string) => AgenteraEncryptedBackupDatabase;
}

interface OwnerContext {
  identity: string;
  accountId: string;
  deviceId: string;
  database: AgenteraEncryptedBackupDatabase;
  keyStore: AgenteraEncryptedBackupKeyStore;
  manager: AgenteraEncryptedBackupManager;
  restore: AgenteraEncryptedBackupRestoreService;
  scheduleStore: EncryptedBackupScheduleStore;
  scheduler: AgenteraEncryptedBackupScheduler;
  progress: Map<string, AgenteraEncryptedBackupProgress>;
}

type ProgressListener = (progress: AgenteraEncryptedBackupProgress[]) => void;

function codedError(code: string): Error {
  return Object.assign(
    new Error(`Aera encrypted backup failed: ${code}.`),
    {
      code,
    },
  );
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    throw codedError("invalid_request");
  }
  return value;
}

function identityOf(principal: AgenteraEncryptedBackupPrincipal): string {
  return `${identifier(principal.accountId)}\0${identifier(principal.deviceId)}`;
}

function publicSummary(
  backup: EncryptedBackupSummary,
): AgenteraEncryptedBackupPublicSummary {
  return {
    backupId: backup.backupId,
    profileLineageId: backup.profileLineageId,
    sourceInstallationId: backup.sourceInstallationId,
    sourceDefinitionId: backup.sourceDefinitionId,
    sourceVersionId: backup.sourceVersionId,
    parentBackupId: backup.parentBackupId,
    sourceDeviceId: backup.sourceDeviceId,
    keyEpoch: backup.keyEpoch,
    chunkCount: backup.chunkCount,
    totalCiphertextSize: backup.totalCiphertextSize,
    createdAt: backup.createdAt,
    sealedAt: backup.sealedAt,
  };
}

export class AgenteraEncryptedBackupController {
  private readonly options: AgenteraEncryptedBackupControllerOptions;
  private readonly listeners = new Set<ProgressListener>();
  private owner: OwnerContext | null = null;
  private closed = false;

  constructor(options: AgenteraEncryptedBackupControllerOptions) {
    this.options = options;
  }

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): AgenteraEncryptedBackupPublicState {
    const principal = this.options.getPrincipal();
    if (!principal || this.closed) return this.unavailableState();
    const owner = this.ensureOwner(principal);
    return this.publicState(owner);
  }

  async initializeRecovery(): Promise<AgenteraEncryptedBackupPublicEnrollment> {
    const principal = this.requireOnlinePrincipal();
    const owner = this.ensureOwner(principal);
    const current = owner.keyStore.getState(principal);
    if (!current.initialized) {
      const [backups, devices] = await Promise.all([
        this.options.client.listBackups(),
        this.options.client.listDevices(),
      ]);
      if (
        backups.length > 0 ||
        devices.some((device) => device.status === "active")
      ) {
        throw codedError("existing_backup_recovery_required");
      }
    }
    const enrollment = await owner.keyStore.initializeAccount({
      accountId: principal.accountId,
      deviceId: principal.deviceId,
    });
    return {
      state: this.publicState(owner),
      recoveryPhrase: enrollment.recoveryPhrase,
    };
  }

  confirmRecoverySaved(): AgenteraEncryptedBackupPublicState {
    const principal = this.requirePrincipal();
    const owner = this.ensureOwner(principal);
    owner.keyStore.confirmRecoverySaved(
      principal.accountId,
      principal.deviceId,
    );
    return this.publicState(owner);
  }

  async registerCurrentDevice(): Promise<
    AgenteraEncryptedBackupPublicDevice[]
  > {
    const principal = this.requireOnlinePrincipal();
    const owner = this.ensureOwner(principal);
    await this.ensureCurrentDeviceRegistration(owner, principal);
    return this.listDevices();
  }

  async authorizeDevice(
    deviceIdValue: string,
  ): Promise<AgenteraEncryptedBackupPublicDevice[]> {
    const deviceId = identifier(deviceIdValue);
    const principal = this.requireOnlinePrincipal();
    if (deviceId === principal.deviceId) throw codedError("invalid_request");
    const owner = this.ensureOwner(principal);
    const state = owner.keyStore.getState(principal);
    if (
      !state.initialized ||
      !state.recoveryConfirmed ||
      state.keyEpoch === null ||
      state.profileLineageId === null
    ) {
      throw codedError("recovery_setup_required");
    }
    const cloudDevices = await this.options.client.listDevices();
    const target = cloudDevices.find(
      (device) =>
        device.deviceId === deviceId &&
        device.status === "active" &&
        device.keyEpoch === state.keyEpoch,
    );
    if (!target) throw codedError("device_registration_required");
    const authorization = await owner.keyStore.authorizeDevice({
      accountId: principal.accountId,
      sourceDeviceId: principal.deviceId,
      deviceId,
      publicKey: target.publicKey,
      revision: target.revision,
    });
    const backups = await this.options.client.listBackups();
    for (const backup of backups) {
      if (
        backup.profileLineageId !== state.profileLineageId ||
        backup.keyEpoch !== state.keyEpoch
      ) {
        continue;
      }
      await this.options.client.addDeviceEnvelope(backup.backupId, {
        deviceId,
        keyEpoch: state.keyEpoch,
        rootKeyEnvelope: authorization.rootKeyEnvelope,
      });
    }
    return this.listDevices();
  }

  async createBackup(
    installationIdValue: string,
  ): Promise<AgenteraEncryptedBackupCreationResult> {
    const installationId = identifier(installationIdValue);
    const principal = this.requireOnlinePrincipal();
    const owner = this.ensureOwner(principal);
    return this.createBackupForOwner(owner, installationId);
  }

  cancelBackup(installationIdValue: string): Promise<boolean> {
    const owner = this.ensureOwner(this.requirePrincipal());
    return owner.manager.cancelBackup(identifier(installationIdValue));
  }

  async listBackups(): Promise<AgenteraEncryptedBackupPublicSummary[]> {
    this.requireOnlinePrincipal();
    return (await this.options.client.listBackups()).map(publicSummary);
  }

  async deleteBackup(backupIdValue: string): Promise<void> {
    this.requireOnlinePrincipal();
    await this.options.client.deleteBackup(identifier(backupIdValue));
  }

  setDailySchedule(
    installationIdValue: string,
    enabled: boolean,
  ): AgenteraEncryptedBackupPublicState {
    const installationId = identifier(installationIdValue);
    if (typeof enabled !== "boolean") throw codedError("invalid_request");
    const principal = this.requirePrincipal();
    const owner = this.ensureOwner(principal);
    const state = owner.keyStore.getState(principal);
    if (!state.profileLineageId || !state.recoveryConfirmed) {
      throw codedError("recovery_setup_required");
    }
    owner.scheduler.setDailySchedule({
      accountId: principal.accountId,
      installationId,
      profileLineageId: state.profileLineageId,
      enabled,
    });
    return this.publicState(owner);
  }

  async listDevices(): Promise<AgenteraEncryptedBackupPublicDevice[]> {
    const principal = this.requireOnlinePrincipal();
    const owner = this.ensureOwner(principal);
    const cloud = await this.options.client.listDevices();
    return this.mergeDevices(
      owner.keyStore.getState(principal),
      cloud,
      principal.deviceId,
    );
  }

  async revokeDevice(
    deviceIdValue: string,
  ): Promise<AgenteraEncryptedBackupPublicDevice[]> {
    const deviceId = identifier(deviceIdValue);
    const principal = this.requireOnlinePrincipal();
    if (deviceId === principal.deviceId) {
      throw codedError("current_device_revoke_forbidden");
    }
    const owner = this.ensureOwner(principal);
    await this.options.client.revokeDevice(deviceId);
    const local = owner.keyStore
      .getState(principal)
      .devices.find((device) => device.deviceId === deviceId);
    if (local && local.status === "active") {
      owner.keyStore.revokeDevice({
        accountId: principal.accountId,
        sourceDeviceId: principal.deviceId,
        deviceId,
      });
    }
    return this.listDevices();
  }

  async prepareRestore(input: {
    backupId: string;
    recoveryPhrase?: string;
  }): Promise<PreparedEncryptedBackupRestore> {
    const backupId = identifier(input.backupId);
    const principal = this.requireOnlinePrincipal();
    const owner = this.ensureOwner(principal);
    const backups = await this.options.client.listBackups();
    const selected = backups.find((backup) => backup.backupId === backupId);
    if (!selected) throw codedError("backup_not_found");
    await this.ensureCurrentDeviceRegistration(
      owner,
      principal,
      selected.keyEpoch,
    );
    return owner.restore.prepareRestore({
      backupId,
      ...(input.recoveryPhrase === undefined
        ? {}
        : { recoveryPhrase: input.recoveryPhrase }),
    });
  }

  confirmRestore(input: {
    preparationId: string;
    name: string;
  }): Promise<AgenteraEncryptedBackupConfirmedRestore> {
    const owner = this.ensureOwner(this.requireOnlinePrincipal());
    return owner.restore.confirmRestore({
      preparationId: identifier(input.preparationId),
      name: input.name,
    });
  }

  cancelRestore(preparationIdValue: string): boolean {
    const owner = this.ensureOwner(this.requirePrincipal());
    return owner.restore.cancelPreparedRestore(identifier(preparationIdValue));
  }

  notifyPrincipalChanged(): void {
    if (!this.owner) return;
    const principal = this.options.getPrincipal();
    if (!principal || identityOf(principal) !== this.owner.identity) {
      this.closeOwner();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeOwner();
    this.listeners.clear();
  }

  private ensureOwner(
    principal: AgenteraEncryptedBackupPrincipal,
  ): OwnerContext {
    if (this.closed) throw codedError("service_unavailable");
    const identity = identityOf(principal);
    if (this.owner?.identity === identity) return this.owner;
    this.closeOwner();
    const database = (
      this.options.databaseFactory ?? openAgenteraEncryptedBackupDatabase
    )(this.options.userDataPath);
    try {
      const keyStore = new AgenteraEncryptedBackupKeyStore({
        database,
        secureStorage: this.options.secureStorage,
      });
      const uploadStore = new EncryptedBackupUploadStore(
        join(database.paths.transactionsPath, "uploads"),
      );
      const progress = new Map<string, AgenteraEncryptedBackupProgress>();
      const principalForOwner = (): AgenteraEncryptedBackupPrincipal | null => {
        const current = this.options.getPrincipal();
        return current && identityOf(current) === identity ? current : null;
      };
      const manager = new AgenteraEncryptedBackupManager({
        transactionsRoot: join(database.paths.transactionsPath, "snapshots"),
        activity: this.options.activity,
        uploadStore,
        client: this.options.client,
        keyStore,
        getPrincipal: () => {
          const current = principalForOwner();
          return current
            ? {
                accountId: current.accountId,
                deviceId: current.deviceId,
                signDigest: current.signDigest,
              }
            : null;
        },
        resolveSource: async (installationId) => {
          const current = principalForOwner();
          if (!current) return null;
          const source =
            await this.options.agentControl.resolveEncryptedBackupUserSource(
              installationId,
            );
          const state = keyStore.getState(current);
          if (!state.profileLineageId) {
            source.runtimeBindingProvenance.fill(0);
            throw codedError("recovery_setup_required");
          }
          let encryptedRuntimeBindingProvenance: Uint8Array;
          try {
            encryptedRuntimeBindingProvenance =
              keyStore.encryptRuntimeBindingProvenance({
                accountId: current.accountId,
                deviceId: current.deviceId,
                plaintext: source.runtimeBindingProvenance,
              });
          } finally {
            source.runtimeBindingProvenance.fill(0);
          }
          try {
            const backups = await this.options.client.listBackups();
            const parent =
              backups
                .filter(
                  (backup) =>
                    backup.profileLineageId === state.profileLineageId,
                )
                .sort((left, right) =>
                  right.sealedAt.localeCompare(left.sealedAt),
                )[0] ?? null;
            return {
              installationId: source.installationId,
              profilePath: source.profilePath,
              parentBackupId: parent?.backupId ?? null,
              provenance: source.provenance,
              encryptedRuntimeBindingProvenance,
            };
          } catch (error) {
            encryptedRuntimeBindingProvenance.fill(0);
            throw error;
          }
        },
      });
      const restore = new AgenteraEncryptedBackupRestoreService({
        client: this.options.client,
        keyStore,
        getPrincipal: () => {
          const current = principalForOwner();
          return current
            ? { accountId: current.accountId, deviceId: current.deviceId }
            : null;
        },
        agentControl: this.options.agentControl,
        transactionsRoot: join(database.paths.transactionsPath, "restores"),
      });
      const scheduleStore = new EncryptedBackupScheduleStore(
        join(database.paths.rootPath, "daily-schedules.json"),
      );
      let ownerContext: OwnerContext | null = null;
      const scheduler = new AgenteraEncryptedBackupScheduler({
        store: scheduleStore,
        getReadiness: () => {
          const current = principalForOwner();
          return {
            authenticatedAccountId: current?.accountId ?? null,
            online: current?.online === true,
            idle:
              this.options.activity.activeRunCount === 0 &&
              !this.options.activity.snapshotActive,
          };
        },
        createBackup: (installationId) => {
          if (!ownerContext || this.owner !== ownerContext) {
            throw codedError("authentication_required");
          }
          return this.createBackupForOwner(ownerContext, installationId);
        },
      });
      ownerContext = {
        identity,
        accountId: principal.accountId,
        deviceId: principal.deviceId,
        database,
        keyStore,
        manager,
        restore,
        scheduleStore,
        scheduler,
        progress,
      };
      this.owner = ownerContext;
      scheduler.start();
      return ownerContext;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private async createBackupForOwner(
    owner: OwnerContext,
    installationId: string,
  ): Promise<AgenteraEncryptedBackupCreationResult> {
    if (this.owner !== owner) throw codedError("authentication_required");
    owner.progress.set(installationId, {
      installationId,
      phase: "preparing",
      uploadedObjects: 0,
      totalObjects: 0,
    });
    this.emitProgress(owner);
    try {
      const created = await owner.manager.createBackup(installationId, {
        onProgress: (progress) => {
          if (this.owner !== owner) return;
          owner.progress.set(installationId, {
            installationId,
            phase: "uploading",
            ...progress,
          });
          this.emitProgress(owner);
        },
      });
      let deviceEnvelopeSyncPending = false;
      try {
        await this.syncAuthorizedDeviceEnvelopes(owner, created.backupId);
      } catch {
        deviceEnvelopeSyncPending = true;
      }
      return { ...created, deviceEnvelopeSyncPending };
    } finally {
      owner.progress.delete(installationId);
      this.emitProgress(owner);
    }
  }

  private async syncAuthorizedDeviceEnvelopes(
    owner: OwnerContext,
    backupId: string,
  ): Promise<void> {
    const principal = this.requireOnlinePrincipal();
    if (this.owner !== owner) throw codedError("authentication_required");
    const state = owner.keyStore.getState(principal);
    if (!state.profileLineageId || state.keyEpoch === null) return;
    for (const device of state.devices) {
      if (
        device.isCurrent ||
        device.status !== "active" ||
        device.keyEpoch !== state.keyEpoch
      ) {
        continue;
      }
      const envelope = await owner.keyStore.wrapRootKeyForDevice({
        accountId: principal.accountId,
        sourceDeviceId: principal.deviceId,
        deviceId: device.deviceId,
        publicKey: device.publicKey,
      });
      await this.options.client.addDeviceEnvelope(backupId, {
        deviceId: device.deviceId,
        keyEpoch: state.keyEpoch,
        rootKeyEnvelope: envelope,
      });
    }
  }

  private async ensureCurrentDeviceRegistration(
    owner: OwnerContext,
    principal: AgenteraEncryptedBackupPrincipal,
    expectedKeyEpoch?: number,
  ): Promise<void> {
    const state = owner.keyStore.getState(principal);
    let keyEpoch = state.keyEpoch;
    if (keyEpoch === null) {
      if (expectedKeyEpoch !== undefined) {
        keyEpoch = expectedKeyEpoch;
      } else {
        const backups = await this.options.client.listBackups();
        keyEpoch = backups.reduce(
          (maximum, backup) => Math.max(maximum, backup.keyEpoch),
          0,
        );
      }
    }
    if (keyEpoch < 1) throw codedError("backup_not_found");
    if (expectedKeyEpoch !== undefined && keyEpoch !== expectedKeyEpoch) {
      throw codedError("key_epoch_conflict");
    }
    await owner.keyStore.prepareCurrentDeviceRegistration({
      accountId: principal.accountId,
      deviceId: principal.deviceId,
      keyEpoch,
    });
    const registration = await owner.keyStore.getDevicePublicRegistration({
      accountId: principal.accountId,
      deviceId: principal.deviceId,
      signDigest: principal.signDigest,
    });
    const receipt =
      await this.options.client.registerCurrentDevice(registration);
    if (
      receipt.deviceId !== principal.deviceId ||
      receipt.keyEpoch !== keyEpoch ||
      receipt.revision !== registration.revision ||
      receipt.status !== "active"
    ) {
      throw codedError("device_registration_failed");
    }
  }

  private mergeDevices(
    local: AgenteraEncryptedBackupState,
    cloud: EncryptedBackupCloudDevice[],
    currentDeviceId: string,
  ): AgenteraEncryptedBackupPublicDevice[] {
    const localById = new Map(
      local.devices.map((device) => [device.deviceId, device]),
    );
    const merged = cloud.map((device): AgenteraEncryptedBackupPublicDevice => {
      const known = localById.get(device.deviceId);
      localById.delete(device.deviceId);
      const authorized = known?.status === "active";
      return {
        deviceId: device.deviceId,
        keyEpoch: device.keyEpoch,
        revision: device.revision,
        status: device.status,
        isCurrent: device.deviceId === currentDeviceId,
        authorized,
        authorizationRequired:
          device.status === "active" &&
          device.deviceId !== currentDeviceId &&
          !authorized,
        registeredAt: device.registeredAt,
        revokedAt: device.revokedAt,
      };
    });
    for (const device of localById.values()) {
      merged.push({
        deviceId: device.deviceId,
        keyEpoch: device.keyEpoch,
        revision: device.revision,
        status: device.status,
        isCurrent: device.deviceId === currentDeviceId,
        authorized: device.status === "active",
        authorizationRequired: false,
        registeredAt: device.authorizedAt,
        revokedAt: device.revokedAt,
      });
    }
    return merged.sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
      return left.deviceId.localeCompare(right.deviceId);
    });
  }

  private publicState(owner: OwnerContext): AgenteraEncryptedBackupPublicState {
    const local = owner.keyStore.getState({
      accountId: owner.accountId,
      deviceId: owner.deviceId,
    });
    return {
      available: true,
      initialized: local.initialized,
      recoveryConfirmed: local.recoveryConfirmed,
      currentDeviceId: owner.deviceId,
      keyEpoch: local.keyEpoch,
      profileLineageId: local.profileLineageId,
      scheduledInstallationIds: owner.scheduleStore
        .list()
        .filter(
          (schedule) =>
            schedule.accountId === owner.accountId && schedule.enabled,
        )
        .map((schedule) => schedule.installationId)
        .sort(),
      activeBackups: [...owner.progress.values()].sort((left, right) =>
        left.installationId.localeCompare(right.installationId),
      ),
    };
  }

  private unavailableState(): AgenteraEncryptedBackupPublicState {
    return {
      available: false,
      initialized: false,
      recoveryConfirmed: false,
      currentDeviceId: null,
      keyEpoch: null,
      profileLineageId: null,
      scheduledInstallationIds: [],
      activeBackups: [],
    };
  }

  private requirePrincipal(): AgenteraEncryptedBackupPrincipal {
    const principal = this.options.getPrincipal();
    if (!principal) throw codedError("authentication_required");
    identityOf(principal);
    return principal;
  }

  private requireOnlinePrincipal(): AgenteraEncryptedBackupPrincipal {
    const principal = this.requirePrincipal();
    if (!principal.online) throw codedError("online_required");
    return principal;
  }

  private emitProgress(owner: OwnerContext): void {
    if (this.owner !== owner) return;
    const progress = [...owner.progress.values()].map((entry) => ({
      ...entry,
    }));
    for (const listener of this.listeners) {
      try {
        listener(progress);
      } catch {
        // UI observers never affect backup isolation.
      }
    }
  }

  private closeOwner(): void {
    const owner = this.owner;
    this.owner = null;
    if (!owner) return;
    owner.scheduler.stop();
    owner.manager.close();
    owner.restore.close();
    owner.progress.clear();
    owner.database.close();
  }
}
