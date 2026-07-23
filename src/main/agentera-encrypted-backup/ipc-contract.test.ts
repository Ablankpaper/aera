// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AGENTERA_IPC_CHANNEL_POLICY } from "../ipc/auth-guard";
import {
  parseAuthorizeEncryptedBackupDeviceInput,
  parseCancelEncryptedBackupInput,
  parseCancelEncryptedBackupRestoreInput,
  parseConfirmEncryptedBackupRecoveryInput,
  parseConfirmEncryptedBackupRestoreInput,
  parseCreateEncryptedBackupInput,
  parseDeleteEncryptedBackupInput,
  parseInitializeEncryptedBackupRecoveryInput,
  parsePrepareEncryptedBackupRestoreInput,
  parseRegisterEncryptedBackupDeviceInput,
  parseRevokeEncryptedBackupDeviceInput,
  parseSetEncryptedBackupScheduleInput,
} from "./ipc-contract";

const INSTALLATION_ID = "40000000-0000-4000-8000-000000000001";
const BACKUP_ID = "70000000-0000-4000-8000-000000000001";
const DEVICE_ID = "20000000-0000-4000-8000-000000000002";
const PREPARATION_ID = "71000000-0000-4000-8000-000000000001";
const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("encrypted backup IPC contract", () => {
  it("keeps local setup/state authenticated and Cloud mutations online", () => {
    for (const channel of [
      "agentera-encrypted-backup-get-state",
      "agentera-encrypted-backup-confirm-recovery",
      "agentera-encrypted-backup-cancel",
      "agentera-encrypted-backup-set-daily-schedule",
      "agentera-encrypted-backup-cancel-restore",
    ]) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel], channel).toBe(
        "authenticated",
      );
    }
    for (const channel of [
      "agentera-encrypted-backup-register-current-device",
      "agentera-encrypted-backup-authorize-device",
      "agentera-encrypted-backup-create",
      "agentera-encrypted-backup-list",
      "agentera-encrypted-backup-delete",
      "agentera-encrypted-backup-list-devices",
      "agentera-encrypted-backup-initialize-recovery",
      "agentera-encrypted-backup-revoke-device",
      "agentera-encrypted-backup-prepare-restore",
      "agentera-encrypted-backup-confirm-restore",
    ]) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel], channel).toBe("online");
    }
  });

  it("accepts only IDs, fixed confirmations, one boolean, a safe name, and one valid 24-word phrase", () => {
    expect(
      parseInitializeEncryptedBackupRecoveryInput({
        confirmation: "initialize-recovery",
      }),
    ).toEqual({ confirmation: "initialize-recovery" });
    expect(
      parseConfirmEncryptedBackupRecoveryInput({
        confirmation: "recovery-written-down",
      }),
    ).toEqual({ confirmation: "recovery-written-down" });
    expect(
      parseRegisterEncryptedBackupDeviceInput({
        confirmation: "register-current-device",
      }),
    ).toEqual({ confirmation: "register-current-device" });
    expect(
      parseAuthorizeEncryptedBackupDeviceInput({
        deviceId: DEVICE_ID,
        confirmation: "authorize-device",
      }),
    ).toEqual({ deviceId: DEVICE_ID, confirmation: "authorize-device" });
    expect(
      parseCreateEncryptedBackupInput({ installationId: INSTALLATION_ID }),
    ).toEqual({ installationId: INSTALLATION_ID });
    expect(
      parseCancelEncryptedBackupInput({ installationId: INSTALLATION_ID }),
    ).toEqual({ installationId: INSTALLATION_ID });
    expect(
      parseSetEncryptedBackupScheduleInput({
        installationId: INSTALLATION_ID,
        enabled: true,
      }),
    ).toEqual({ installationId: INSTALLATION_ID, enabled: true });
    expect(
      parseDeleteEncryptedBackupInput({
        backupId: BACKUP_ID,
        confirmation: "delete-backup",
      }),
    ).toEqual({ backupId: BACKUP_ID, confirmation: "delete-backup" });
    expect(
      parseRevokeEncryptedBackupDeviceInput({
        deviceId: DEVICE_ID,
        confirmation: "revoke-device",
      }),
    ).toEqual({ deviceId: DEVICE_ID, confirmation: "revoke-device" });
    expect(
      parsePrepareEncryptedBackupRestoreInput({
        backupId: BACKUP_ID,
        recoveryPhrase: PHRASE,
      }),
    ).toEqual({ backupId: BACKUP_ID, recoveryPhrase: PHRASE });
    expect(
      parseConfirmEncryptedBackupRestoreInput({
        preparationId: PREPARATION_ID,
        name: "Restored private branch",
        confirmation: "restore-into-new-profile",
      }),
    ).toEqual({
      preparationId: PREPARATION_ID,
      name: "Restored private branch",
      confirmation: "restore-into-new-profile",
    });
    expect(
      parseCancelEncryptedBackupRestoreInput({
        preparationId: PREPARATION_ID,
      }),
    ).toEqual({ preparationId: PREPARATION_ID });
  });

  it("rejects paths, file inventories, secrets, destinations, and Profile overlays before dispatch", () => {
    const validCreate = { installationId: INSTALLATION_ID };
    for (const [field, value] of Object.entries({
      path: "/private/profile",
      profilePath: "/private/profile",
      destinationPath: "/private/restored",
      files: ["memories/MEMORY.md"],
      rootKey: "secret",
      privateKey: "secret",
      apiKey: "secret",
      profileId: "default",
      overlay: true,
    })) {
      expect(() =>
        parseCreateEncryptedBackupInput({ ...validCreate, [field]: value }),
      ).toThrow(/invalid/i);
    }
    expect(() =>
      parsePrepareEncryptedBackupRestoreInput({
        backupId: BACKUP_ID,
        recoveryPhrase: `${PHRASE} extra`,
      }),
    ).toThrow(/invalid/i);
    expect(() =>
      parseConfirmEncryptedBackupRestoreInput({
        preparationId: PREPARATION_ID,
        name: "../existing",
        confirmation: "restore-into-new-profile",
        destinationPath: "/private/existing",
      }),
    ).toThrow(/invalid/i);
  });
});
