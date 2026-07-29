import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AgenteraEncryptedBackupDevice,
  AgenteraEncryptedBackupDeviceRegistration,
  AgenteraEncryptedBackupEnrollment,
  AgenteraEncryptedBackupState,
} from "../../shared/agentera-encrypted-backup";
import {
  base64urlDecode,
  base64urlEncode,
  encryptRuntimeBindingProvenance as encryptProvenance,
  generateBackupDeviceKeyPair,
  recoveryPhraseFromEntropy,
  unwrapRootKeyForDevice as hpkeUnwrapRootKeyForDevice,
  unwrapRootKeyFromRecovery,
  wrapBackupDataKey as aesWrapBackupDataKey,
  wrapRootKeyForDevice as hpkeWrapRootKeyForDevice,
  wrapRootKeyForRecovery,
  type DeviceRootKeyEnvelopeV1,
  type RecoveryRootKeyEnvelopeV1,
  type WrappedBackupDataKeyEnvelopeV1,
} from "./crypto";
import type {
  AgenteraEncryptedBackupDatabase,
  EncryptedBackupAccountRecord,
  EncryptedBackupDeviceRecord,
  EncryptedBackupPendingDeviceRecord,
} from "./db";

const DEVICE_REGISTRATION_DOMAIN =
  "agentera-encrypted-profile-backup-device-registration.v1\0";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const textEncoder = new TextEncoder();

export interface EncryptedBackupSecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?():
    | "basic_text"
    | "gnome_libsecret"
    | "kwallet"
    | "kwallet5"
    | "kwallet6"
    | "unknown";
}

export interface AgenteraEncryptedBackupKeyStoreOptions {
  database: AgenteraEncryptedBackupDatabase;
  secureStorage: EncryptedBackupSecureStorage;
  randomUUID?: () => string;
}

export interface InitializeEncryptedBackupAccountInput {
  accountId: string;
  deviceId: string;
  now?: Date;
}

export interface GetEncryptedBackupRegistrationInput {
  accountId: string;
  deviceId: string;
  signDigest: (digest: Uint8Array) => string;
}

export interface PrepareEncryptedBackupDeviceRegistrationInput {
  accountId: string;
  deviceId: string;
  keyEpoch: number;
  now?: Date;
}

export interface PreparedEncryptedBackupDeviceRegistration {
  accountId: string;
  deviceId: string;
  publicKey: string;
  keyEpoch: number;
  revision: number;
}

export interface AdoptRestoredEncryptedBackupAccountInput {
  accountId: string;
  deviceId: string;
  keyEpoch: number;
  profileLineageId: string;
  rootKey: Uint8Array;
  recoveryEnvelope: RecoveryRootKeyEnvelopeV1;
  now?: Date;
}

export interface WrapEncryptedBackupRootKeyInput {
  accountId: string;
  sourceDeviceId: string;
  deviceId: string;
  publicKey: string;
}

export interface RecoverEncryptedBackupRootKeyInput {
  accountId: string;
  phrase: string;
}

export interface RecoverEncryptedBackupRestoreRootKeyInput extends RecoverEncryptedBackupRootKeyInput {
  envelope: RecoveryRootKeyEnvelopeV1;
  profileLineageId: string;
}

export interface AuthorizeEncryptedBackupDeviceInput extends WrapEncryptedBackupRootKeyInput {
  revision: number;
  now?: Date;
}

export interface RevokeEncryptedBackupDeviceInput {
  accountId: string;
  sourceDeviceId: string;
  deviceId: string;
  now?: Date;
}

export interface EncryptedBackupDeviceAuthorization {
  device: AgenteraEncryptedBackupDevice;
  rootKeyEnvelope: DeviceRootKeyEnvelopeV1;
}

export interface EncryptedBackupArchivePublicMaterial {
  profileLineageId: string;
  keyEpoch: number;
  recoveryRootKeyEnvelope: RecoveryRootKeyEnvelopeV1;
  devicePublicKey: string;
}

export function backupDeviceRootKeyAad(input: {
  accountId: string;
  deviceId: string;
  keyEpoch: number;
}): Uint8Array {
  return textEncoder.encode(
    `agentera-backup-v1/device-root\0account=${input.accountId}\0device=${input.deviceId}\0epoch=${input.keyEpoch}`,
  );
}

function signingDigest(input: {
  accountId: string;
  deviceId: string;
  keyEpoch: number;
  revision: number;
  publicKey: string;
}): Uint8Array {
  const canonical = JSON.stringify({
    user_id: input.accountId,
    device_id: input.deviceId,
    key_epoch: input.keyEpoch,
    revision: input.revision,
    public_key: input.publicKey,
  });
  return new Uint8Array(
    createHash("sha256")
      .update(DEVICE_REGISTRATION_DOMAIN)
      .update(canonical)
      .digest(),
  );
}

export class AgenteraEncryptedBackupKeyStore {
  private readonly database: AgenteraEncryptedBackupDatabase;
  private readonly secureStorage: EncryptedBackupSecureStorage;
  private readonly createUUID: () => string;

  constructor(options: AgenteraEncryptedBackupKeyStoreOptions) {
    this.database = options.database;
    this.secureStorage = options.secureStorage;
    this.createUUID = options.randomUUID ?? randomUUID;
  }

  async initializeAccount(
    input: InitializeEncryptedBackupAccountInput,
  ): Promise<AgenteraEncryptedBackupEnrollment> {
    const existing = this.database.readAccount(input.accountId);
    if (existing) {
      return {
        state: this.getState(input),
        recoveryPhrase: null,
      };
    }
    this.assertSecureStorage();
    const rootKey = new Uint8Array(randomBytes(32));
    const recoveryEntropy = new Uint8Array(randomBytes(32));
    const salt = new Uint8Array(randomBytes(16));
    const profileLineageId = this.createUUID();
    let phrase = "";
    try {
      phrase = recoveryPhraseFromEntropy(recoveryEntropy);
      const recoveryEnvelope = await wrapRootKeyForRecovery({
        rootKey,
        phrase,
        salt,
        lineageId: profileLineageId,
      });
      const deviceKeys = await generateBackupDeviceKeyPair();
      const encryptedRootKey = this.encryptSecret(base64urlEncode(rootKey, 32));
      const encryptedPrivateKey = this.encryptSecret(deviceKeys.privateKey);
      try {
        this.database.createAccount({
          accountId: input.accountId,
          profileLineageId,
          keyEpoch: 1,
          encryptedRootKey,
          recoveryEnvelope,
          localDevice: {
            deviceId: input.deviceId,
            publicKey: deviceKeys.publicKey,
            encryptedPrivateKey,
            revision: 1,
          },
          createdAt: input.now ?? new Date(),
        });
      } finally {
        encryptedRootKey.fill(0);
        encryptedPrivateKey.fill(0);
      }
      return {
        state: this.getState(input),
        recoveryPhrase: phrase,
      };
    } finally {
      rootKey.fill(0);
      recoveryEntropy.fill(0);
      salt.fill(0);
    }
  }

  getState(input: {
    accountId: string;
    deviceId: string;
  }): AgenteraEncryptedBackupState {
    const account = this.database.readAccount(input.accountId);
    if (!account) {
      return {
        initialized: false,
        accountId: input.accountId,
        currentDeviceId: input.deviceId,
        keyEpoch: null,
        profileLineageId: null,
        recoveryConfirmed: false,
        devices: [],
      };
    }
    return {
      initialized: true,
      accountId: account.accountId,
      currentDeviceId: input.deviceId,
      keyEpoch: account.keyEpoch,
      profileLineageId: account.profileLineageId,
      recoveryConfirmed: account.recoveryConfirmed,
      devices: this.database
        .listDevices(account.accountId)
        .map((device) => this.publicDevice(device, input.deviceId)),
    };
  }

  async getDevicePublicRegistration(
    input: GetEncryptedBackupRegistrationInput,
  ): Promise<AgenteraEncryptedBackupDeviceRegistration> {
    const account = this.database.readAccount(input.accountId);
    const device = account
      ? this.requireActiveLocalDevice(input.accountId, input.deviceId)
      : this.requirePendingDevice(input.accountId, input.deviceId);
    const digest = signingDigest({
      accountId: input.accountId,
      deviceId: device.deviceId,
      keyEpoch: device.keyEpoch,
      revision: device.revision,
      publicKey: device.publicKey,
    });
    let signature: string;
    try {
      signature = input.signDigest(digest);
      base64urlDecode(signature, 64);
    } catch {
      throw new Error("Encrypted backup device signature is invalid.");
    } finally {
      digest.fill(0);
    }
    return {
      key_epoch: device.keyEpoch,
      revision: device.revision,
      public_key: device.publicKey,
      signature,
    };
  }

  async prepareCurrentDeviceRegistration(
    input: PrepareEncryptedBackupDeviceRegistrationInput,
  ): Promise<PreparedEncryptedBackupDeviceRegistration> {
    if (
      !UUID_PATTERN.test(input.accountId) ||
      !UUID_PATTERN.test(input.deviceId) ||
      !Number.isSafeInteger(input.keyEpoch) ||
      input.keyEpoch < 1
    ) {
      throw new Error("Encrypted backup device registration is invalid.");
    }
    const account = this.database.readAccount(input.accountId);
    if (account) {
      const device = this.requireActiveLocalDevice(
        input.accountId,
        input.deviceId,
      );
      if (
        account.keyEpoch !== input.keyEpoch ||
        device.keyEpoch !== input.keyEpoch
      ) {
        throw new Error("Encrypted backup local device key epoch is stale.");
      }
      return {
        accountId: input.accountId,
        deviceId: device.deviceId,
        publicKey: device.publicKey,
        keyEpoch: device.keyEpoch,
        revision: device.revision,
      };
    }
    const existing = this.database.readPendingDevice(
      input.accountId,
      input.deviceId,
    );
    if (existing) {
      if (existing.keyEpoch !== input.keyEpoch) {
        throw new Error("Encrypted backup pending device key epoch conflicts.");
      }
      return this.publicPendingDevice(existing);
    }
    this.assertSecureStorage();
    const deviceKeys = await generateBackupDeviceKeyPair();
    const encryptedPrivateKey = this.encryptSecret(deviceKeys.privateKey);
    try {
      this.database.savePendingDevice({
        accountId: input.accountId,
        deviceId: input.deviceId,
        publicKey: deviceKeys.publicKey,
        encryptedPrivateKey,
        keyEpoch: input.keyEpoch,
        revision: 1,
        createdAt: input.now ?? new Date(),
      });
    } finally {
      encryptedPrivateKey.fill(0);
    }
    return this.publicPendingDevice(
      this.requirePendingDevice(input.accountId, input.deviceId),
    );
  }

  getArchivePublicMaterial(input: {
    accountId: string;
    deviceId: string;
  }): EncryptedBackupArchivePublicMaterial {
    const account = this.requireAccount(input.accountId);
    const device = this.requireActiveLocalDevice(
      input.accountId,
      input.deviceId,
    );
    if (device.keyEpoch !== account.keyEpoch) {
      throw new Error("Encrypted backup local device key epoch is stale.");
    }
    return {
      profileLineageId: account.profileLineageId,
      keyEpoch: account.keyEpoch,
      recoveryRootKeyEnvelope: { ...account.recoveryEnvelope },
      devicePublicKey: device.publicKey,
    };
  }

  encryptRuntimeBindingProvenance(input: {
    accountId: string;
    deviceId: string;
    plaintext: Uint8Array;
  }): Uint8Array {
    const account = this.requireAccount(input.accountId);
    const device = this.requireActiveLocalDevice(
      input.accountId,
      input.deviceId,
    );
    if (device.keyEpoch !== account.keyEpoch) {
      throw new Error("Encrypted backup local device key epoch is stale.");
    }
    const rootKey = this.decryptRootKey(account.encryptedRootKey);
    try {
      const envelope = encryptProvenance({
        rootKey,
        profileLineageId: account.profileLineageId,
        plaintext: input.plaintext,
      });
      const serialized = Buffer.from(JSON.stringify(envelope), "utf8");
      if (serialized.byteLength > 1024 * 1024 + 4096) {
        serialized.fill(0);
        throw new Error(
          "Encrypted backup RuntimeBinding provenance is too large.",
        );
      }
      return new Uint8Array(serialized);
    } finally {
      rootKey.fill(0);
    }
  }

  wrapBackupDataKey(input: {
    accountId: string;
    deviceId: string;
    backupId: string;
    dataKey: Uint8Array;
  }): WrappedBackupDataKeyEnvelopeV1 {
    const account = this.requireAccount(input.accountId);
    const device = this.requireActiveLocalDevice(
      input.accountId,
      input.deviceId,
    );
    if (device.keyEpoch !== account.keyEpoch) {
      throw new Error("Encrypted backup local device key epoch is stale.");
    }
    const rootKey = this.decryptRootKey(account.encryptedRootKey);
    try {
      return aesWrapBackupDataKey(rootKey, input.dataKey, input.backupId);
    } finally {
      rootKey.fill(0);
    }
  }

  async wrapRootKeyForDevice(
    input: WrapEncryptedBackupRootKeyInput,
  ): Promise<DeviceRootKeyEnvelopeV1> {
    const account = this.requireAccount(input.accountId);
    this.requireActiveLocalDevice(input.accountId, input.sourceDeviceId);
    const knownTarget = this.database.readDevice(
      input.accountId,
      input.deviceId,
    );
    if (knownTarget?.status === "revoked") {
      throw new Error("Encrypted backup target device is revoked.");
    }
    base64urlDecode(input.publicKey, 32);
    const rootKey = this.decryptRootKey(account.encryptedRootKey);
    const aad = backupDeviceRootKeyAad({
      accountId: account.accountId,
      deviceId: input.deviceId,
      keyEpoch: account.keyEpoch,
    });
    try {
      return await hpkeWrapRootKeyForDevice(input.publicKey, rootKey, aad);
    } finally {
      rootKey.fill(0);
      aad.fill(0);
    }
  }

  async unwrapRootKeyForCurrentDevice(input: {
    accountId: string;
    deviceId: string;
    keyEpoch: number;
    envelope: DeviceRootKeyEnvelopeV1;
  }): Promise<Uint8Array> {
    const account = this.database.readAccount(input.accountId);
    const device = account
      ? this.requireActiveLocalDevice(input.accountId, input.deviceId)
      : this.requirePendingDevice(input.accountId, input.deviceId);
    if (
      (account !== null && input.keyEpoch !== account.keyEpoch) ||
      device.keyEpoch !== input.keyEpoch ||
      !device.encryptedPrivateKey
    ) {
      throw new Error("Encrypted backup device key epoch is unavailable.");
    }
    const privateKey = this.decryptDevicePrivateKey(device.encryptedPrivateKey);
    const aad = backupDeviceRootKeyAad({
      accountId: input.accountId,
      deviceId: input.deviceId,
      keyEpoch: input.keyEpoch,
    });
    try {
      return await hpkeUnwrapRootKeyForDevice(
        base64urlEncode(privateKey, 32),
        input.envelope,
        aad,
      );
    } finally {
      privateKey.fill(0);
      aad.fill(0);
    }
  }

  async adoptRestoredAccount(
    input: AdoptRestoredEncryptedBackupAccountInput,
  ): Promise<AgenteraEncryptedBackupState> {
    if (
      !UUID_PATTERN.test(input.accountId) ||
      !UUID_PATTERN.test(input.deviceId) ||
      !UUID_PATTERN.test(input.profileLineageId) ||
      !Number.isSafeInteger(input.keyEpoch) ||
      input.keyEpoch < 1 ||
      !(input.rootKey instanceof Uint8Array) ||
      input.rootKey.byteLength !== 32
    ) {
      throw new Error("Encrypted backup restored account is invalid.");
    }
    const existing = this.database.readAccount(input.accountId);
    if (existing) {
      const local = this.requireActiveLocalDevice(
        input.accountId,
        input.deviceId,
      );
      if (
        existing.profileLineageId !== input.profileLineageId ||
        existing.keyEpoch !== input.keyEpoch ||
        local.keyEpoch !== input.keyEpoch
      ) {
        throw new Error("Encrypted backup restored account conflicts.");
      }
      this.database.deletePendingDevice(input.accountId, input.deviceId);
      if (!existing.recoveryConfirmed) {
        this.database.confirmRecoverySaved(
          input.accountId,
          input.now ?? new Date(),
        );
      }
      return this.getState(input);
    }
    const pending = this.requirePendingDevice(input.accountId, input.deviceId);
    if (pending.keyEpoch !== input.keyEpoch) {
      pending.encryptedPrivateKey.fill(0);
      throw new Error("Encrypted backup pending device key epoch conflicts.");
    }
    const encryptedRootKey = this.encryptSecret(
      base64urlEncode(input.rootKey, 32),
    );
    const now = input.now ?? new Date();
    try {
      this.database.createAccount({
        accountId: input.accountId,
        profileLineageId: input.profileLineageId,
        keyEpoch: input.keyEpoch,
        encryptedRootKey,
        recoveryEnvelope: input.recoveryEnvelope,
        localDevice: {
          deviceId: input.deviceId,
          publicKey: pending.publicKey,
          encryptedPrivateKey: pending.encryptedPrivateKey,
          revision: pending.revision,
        },
        createdAt: now,
      });
      this.database.confirmRecoverySaved(input.accountId, now);
      this.database.deletePendingDevice(input.accountId, input.deviceId);
      return this.getState(input);
    } finally {
      encryptedRootKey.fill(0);
      pending.encryptedPrivateKey.fill(0);
    }
  }

  async recoverRootKeyFromPhrase(
    input: RecoverEncryptedBackupRootKeyInput,
  ): Promise<Uint8Array> {
    const account = this.requireAccount(input.accountId);
    return this.recoverRestoreRootKeyFromPhrase({
      ...input,
      envelope: account.recoveryEnvelope,
      profileLineageId: account.profileLineageId,
    });
  }

  async recoverRestoreRootKeyFromPhrase(
    input: RecoverEncryptedBackupRestoreRootKeyInput,
  ): Promise<Uint8Array> {
    if (
      !UUID_PATTERN.test(input.accountId) ||
      !UUID_PATTERN.test(input.profileLineageId)
    ) {
      throw new Error("Encrypted backup restore identity is invalid.");
    }
    return unwrapRootKeyFromRecovery({
      envelope: input.envelope,
      phrase: input.phrase,
      lineageId: input.profileLineageId,
    });
  }

  async authorizeDevice(
    input: AuthorizeEncryptedBackupDeviceInput,
  ): Promise<EncryptedBackupDeviceAuthorization> {
    if (input.deviceId === input.sourceDeviceId) {
      throw new Error("Encrypted backup target device must be different.");
    }
    const account = this.requireAccount(input.accountId);
    const rootKeyEnvelope = await this.wrapRootKeyForDevice(input);
    this.database.authorizeDevice({
      accountId: input.accountId,
      deviceId: input.deviceId,
      publicKey: input.publicKey,
      keyEpoch: account.keyEpoch,
      revision: input.revision,
      authorizedAt: input.now ?? new Date(),
    });
    const record = this.database.readDevice(input.accountId, input.deviceId);
    if (!record) {
      throw new Error("Encrypted backup device authorization failed.");
    }
    return {
      device: this.publicDevice(record, input.sourceDeviceId),
      rootKeyEnvelope,
    };
  }

  revokeDevice(
    input: RevokeEncryptedBackupDeviceInput,
  ): AgenteraEncryptedBackupState {
    this.requireActiveLocalDevice(input.accountId, input.sourceDeviceId);
    this.database.revokeDevice(
      input.accountId,
      input.deviceId,
      input.now ?? new Date(),
    );
    return this.getState({
      accountId: input.accountId,
      deviceId: input.sourceDeviceId,
    });
  }

  confirmRecoverySaved(
    accountId: string,
    deviceId: string,
    now = new Date(),
  ): AgenteraEncryptedBackupState {
    this.requireActiveLocalDevice(accountId, deviceId);
    this.database.confirmRecoverySaved(accountId, now);
    return this.getState({ accountId, deviceId });
  }

  private requireAccount(accountId: string): EncryptedBackupAccountRecord {
    const account = this.database.readAccount(accountId);
    if (!account) {
      throw new Error("Encrypted backup account is not initialized.");
    }
    return account;
  }

  private requireActiveLocalDevice(
    accountId: string,
    deviceId: string,
  ): EncryptedBackupDeviceRecord {
    const device = this.database.readDevice(accountId, deviceId);
    if (!device || !device.isLocal) {
      throw new Error("Encrypted backup local device is unavailable.");
    }
    if (device.status !== "active") {
      throw new Error("Encrypted backup local device is revoked.");
    }
    if (!device.encryptedPrivateKey) {
      throw new Error("Encrypted backup local device key is unavailable.");
    }
    return device;
  }

  private requirePendingDevice(
    accountId: string,
    deviceId: string,
  ): EncryptedBackupPendingDeviceRecord {
    const device = this.database.readPendingDevice(accountId, deviceId);
    if (!device) {
      throw new Error("Encrypted backup pending local device is unavailable.");
    }
    return device;
  }

  private publicPendingDevice(
    device: EncryptedBackupPendingDeviceRecord,
  ): PreparedEncryptedBackupDeviceRegistration {
    return {
      accountId: device.accountId,
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      keyEpoch: device.keyEpoch,
      revision: device.revision,
    };
  }

  private publicDevice(
    device: EncryptedBackupDeviceRecord,
    currentDeviceId: string,
  ): AgenteraEncryptedBackupDevice {
    return {
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      keyEpoch: device.keyEpoch,
      revision: device.revision,
      status: device.status,
      isCurrent: device.deviceId === currentDeviceId,
      authorizedAt: device.authorizedAt,
      revokedAt: device.revokedAt,
    };
  }

  private assertSecureStorage(): void {
    let available = false;
    let weakBackend = false;
    try {
      available = this.secureStorage.isEncryptionAvailable();
      weakBackend =
        this.secureStorage.getSelectedStorageBackend?.() === "basic_text";
    } catch {
      available = false;
    }
    if (!available || weakBackend) {
      throw new Error(
        "Secure storage is unavailable for Aera encrypted backup keys.",
      );
    }
  }

  private encryptSecret(value: string): Buffer {
    this.assertSecureStorage();
    try {
      const encrypted = this.secureStorage.encryptString(value);
      if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0) {
        throw new Error();
      }
      return Buffer.from(encrypted);
    } catch {
      throw new Error(
        "Secure storage could not protect Aera encrypted backup keys.",
      );
    }
  }

  private decryptRootKey(encrypted: Uint8Array): Uint8Array {
    this.assertSecureStorage();
    let plaintext: string;
    try {
      plaintext = this.secureStorage.decryptString(Buffer.from(encrypted));
    } catch {
      throw new Error(
        "Aera encrypted backup root key could not be opened.",
      );
    }
    try {
      return base64urlDecode(plaintext, 32);
    } catch {
      throw new Error("Aera encrypted backup root key is corrupt.");
    }
  }

  private decryptDevicePrivateKey(encrypted: Uint8Array): Uint8Array {
    this.assertSecureStorage();
    let plaintext: string;
    try {
      plaintext = this.secureStorage.decryptString(Buffer.from(encrypted));
    } catch {
      throw new Error(
        "Aera encrypted backup device key could not be opened.",
      );
    }
    try {
      return base64urlDecode(plaintext, 32);
    } catch {
      throw new Error("Aera encrypted backup device key is corrupt.");
    }
  }
}
