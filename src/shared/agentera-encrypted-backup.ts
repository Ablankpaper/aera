export const AGENTERA_ENCRYPTED_BACKUP_FORMAT_VERSION = 1 as const;

export type AgenteraEncryptedBackupDeviceStatus = "active" | "revoked";

export interface AgenteraEncryptedBackupDevice {
  deviceId: string;
  publicKey: string;
  keyEpoch: number;
  revision: number;
  status: AgenteraEncryptedBackupDeviceStatus;
  isCurrent: boolean;
  authorizedAt: string;
  revokedAt: string | null;
}

export interface AgenteraEncryptedBackupState {
  initialized: boolean;
  accountId: string;
  currentDeviceId: string;
  keyEpoch: number | null;
  profileLineageId: string | null;
  recoveryConfirmed: boolean;
  devices: AgenteraEncryptedBackupDevice[];
}

/**
 * The recovery phrase is populated only by the first successful enrollment
 * call. Later state reads and repeated enrollment calls return null.
 */
export interface AgenteraEncryptedBackupEnrollment {
  state: AgenteraEncryptedBackupState;
  recoveryPhrase: string | null;
}

/** Exact public payload accepted by the Cloud device-registration endpoint. */
export interface AgenteraEncryptedBackupDeviceRegistration {
  key_epoch: number;
  revision: number;
  public_key: string;
  signature: string;
}

export interface AgenteraEncryptedBackupPublicDevice {
  deviceId: string;
  keyEpoch: number;
  revision: number;
  status: AgenteraEncryptedBackupDeviceStatus;
  isCurrent: boolean;
  authorized: boolean;
  authorizationRequired: boolean;
  registeredAt: string;
  revokedAt: string | null;
}

export interface AgenteraEncryptedBackupPublicSummary {
  backupId: string;
  profileLineageId: string;
  sourceInstallationId: string;
  sourceDefinitionId: string;
  sourceVersionId: string;
  parentBackupId: string | null;
  sourceDeviceId: string;
  keyEpoch: number;
  chunkCount: number;
  totalCiphertextSize: number;
  createdAt: string;
  sealedAt: string;
}

export interface AgenteraEncryptedBackupProgress {
  installationId: string;
  phase: "preparing" | "uploading";
  uploadedObjects: number;
  totalObjects: number;
}

export interface AgenteraEncryptedBackupPublicState {
  available: boolean;
  initialized: boolean;
  recoveryConfirmed: boolean;
  currentDeviceId: string | null;
  keyEpoch: number | null;
  profileLineageId: string | null;
  scheduledInstallationIds: string[];
  activeBackups: AgenteraEncryptedBackupProgress[];
}

export interface AgenteraEncryptedBackupPublicEnrollment {
  state: AgenteraEncryptedBackupPublicState;
  /** Returned exactly once and never emitted on an event channel. */
  recoveryPhrase: string | null;
}

export interface AgenteraEncryptedBackupCreationResult {
  backupId: string;
  sealedAt: string;
  resumed: boolean;
  deviceEnvelopeSyncPending: boolean;
}

export interface AgenteraEncryptedBackupPreparedRestore {
  preparationId: string;
  backupId: string;
  sourceInstallationId: string;
  sourceDefinitionId: string;
  sourceVersionId: string;
  createdAt: string;
  fileCount: number;
  totalPlaintextSize: number;
}

export interface AgenteraEncryptedBackupConfirmedRestore {
  backupId: string;
  agentInstallationId: string;
  profileId: string;
  runtimeProfileId: string;
}
