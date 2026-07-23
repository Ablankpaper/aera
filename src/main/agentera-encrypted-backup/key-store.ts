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
  generateBackupDeviceKeyPair,
  recoveryPhraseFromEntropy,
  unwrapRootKeyFromRecovery,
  wrapRootKeyForDevice as hpkeWrapRootKeyForDevice,
  wrapRootKeyForRecovery,
  type DeviceRootKeyEnvelopeV1,
} from "./crypto";
import type {
  AgenteraEncryptedBackupDatabase,
  EncryptedBackupAccountRecord,
  EncryptedBackupDeviceRecord,
} from "./db";

const DEVICE_REGISTRATION_DOMAIN =
  "agentera-encrypted-profile-backup-device-registration.v1\0";
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
    const account = this.requireAccount(input.accountId);
    const device = this.requireActiveLocalDevice(
      input.accountId,
      input.deviceId,
    );
    const digest = signingDigest({
      accountId: account.accountId,
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

  async recoverRootKeyFromPhrase(
    input: RecoverEncryptedBackupRootKeyInput,
  ): Promise<Uint8Array> {
    const account = this.requireAccount(input.accountId);
    return unwrapRootKeyFromRecovery({
      envelope: account.recoveryEnvelope,
      phrase: input.phrase,
      lineageId: account.profileLineageId,
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
        "Secure storage is unavailable for AgentEra encrypted backup keys.",
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
        "Secure storage could not protect AgentEra encrypted backup keys.",
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
        "AgentEra encrypted backup root key could not be opened.",
      );
    }
    try {
      return base64urlDecode(plaintext, 32);
    } catch {
      throw new Error("AgentEra encrypted backup root key is corrupt.");
    }
  }
}
