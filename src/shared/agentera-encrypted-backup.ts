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
