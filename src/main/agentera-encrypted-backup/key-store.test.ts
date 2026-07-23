// @vitest-environment node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  base64urlDecode,
  generateBackupDeviceKeyPair,
  unwrapRootKeyForDevice,
} from "./crypto";
import {
  openAgenteraEncryptedBackupDatabase,
  type AgenteraEncryptedBackupDatabase,
  type AgenteraEncryptedBackupSqliteDatabase,
} from "./db";
import {
  AgenteraEncryptedBackupKeyStore,
  backupDeviceRootKeyAad,
} from "./key-store";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "10000000-0000-4000-8000-000000000002";
const DEVICE_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_DEVICE_ID = "20000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-07-23T12:00:00.000Z");
const roots: string[] = [];
const databases: AgenteraEncryptedBackupDatabase[] = [];

function persistedBytes(databasePath: string): Buffer {
  return Buffer.concat(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path)),
  );
}

class OpaqueSecureStorage {
  available = true;
  backend:
    | "basic_text"
    | "gnome_libsecret"
    | "kwallet"
    | "kwallet5"
    | "kwallet6"
    | "unknown" = "unknown";
  readonly plaintexts: string[] = [];
  private readonly values = new Map<string, string>();

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  getSelectedStorageBackend(): typeof this.backend {
    return this.backend;
  }

  encryptString(value: string): Buffer {
    const handle = randomBytes(32).toString("hex");
    this.values.set(handle, value);
    this.plaintexts.push(value);
    return Buffer.from(handle, "ascii");
  }

  decryptString(value: Buffer): string {
    const plaintext = this.values.get(value.toString("ascii"));
    if (plaintext === undefined) throw new Error("unknown secure value");
    return plaintext;
  }
}

function storeFor(secureStorage = new OpaqueSecureStorage()): {
  database: AgenteraEncryptedBackupDatabase;
  secureStorage: OpaqueSecureStorage;
  store: AgenteraEncryptedBackupKeyStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agentera-backup-keys-"));
  roots.push(root);
  const database = openAgenteraEncryptedBackupDatabase(join(root, "userData"), {
    databaseFactory: (path) =>
      new DatabaseSync(
        path,
      ) as unknown as AgenteraEncryptedBackupSqliteDatabase,
  });
  databases.push(database);
  return {
    database,
    secureStorage,
    store: new AgenteraEncryptedBackupKeyStore({
      database,
      secureStorage,
    }),
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgenteraEncryptedBackupKeyStore", () => {
  it("returns a 24-word phrase once and persists only encrypted key material", async () => {
    const { database, secureStorage, store } = storeFor();
    const first = await store.initializeAccount({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      now: NOW,
    });
    if (!first.recoveryPhrase) throw new Error("missing recovery phrase");
    expect(first.recoveryPhrase.split(" ")).toHaveLength(24);
    expect(first.state).toMatchObject({
      initialized: true,
      accountId: ACCOUNT_ID,
      currentDeviceId: DEVICE_ID,
      keyEpoch: 1,
      recoveryConfirmed: false,
    });

    const second = await store.initializeAccount({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      now: NOW,
    });
    expect(second.recoveryPhrase).toBeNull();
    expect(second.state).toEqual(first.state);
    expect(secureStorage.plaintexts).toHaveLength(2);
    expect(secureStorage.plaintexts.every((value) => value.length === 43)).toBe(
      true,
    );

    const rawDatabase = persistedBytes(database.paths.databasePath);
    expect(rawDatabase.includes(Buffer.from(first.recoveryPhrase))).toBe(false);
    for (const plaintext of secureStorage.plaintexts) {
      expect(rawDatabase.includes(Buffer.from(plaintext))).toBe(false);
    }
    const recovery = database.sqlite
      .prepare(
        "SELECT recovery_envelope_json FROM encrypted_backup_accounts WHERE account_id = ?",
      )
      .get(ACCOUNT_ID) as { recovery_envelope_json: string };
    expect(
      Object.keys(JSON.parse(recovery.recovery_envelope_json)).sort(),
    ).toEqual([
      "ciphertext",
      "formatVersion",
      "iterations",
      "kdf",
      "memoryKiB",
      "nonce",
      "parallelism",
      "salt",
    ]);
  }, 20_000);

  it("signs the Cloud-compatible public registration without exporting secrets", async () => {
    const { store } = storeFor();
    await store.initializeAccount({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      now: NOW,
    });
    let signedDigest: Uint8Array | null = null;
    const registration = await store.getDevicePublicRegistration({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      signDigest: (digest) => {
        signedDigest = new Uint8Array(digest);
        return Buffer.alloc(64, 0x55).toString("base64url");
      },
    });
    expect(registration).toMatchObject({
      key_epoch: 1,
      revision: 1,
      signature: Buffer.alloc(64, 0x55).toString("base64url"),
    });
    expect(registration.public_key).toHaveLength(43);
    const canonical = JSON.stringify({
      user_id: ACCOUNT_ID,
      device_id: DEVICE_ID,
      key_epoch: 1,
      revision: 1,
      public_key: registration.public_key,
    });
    expect(Buffer.from(signedDigest!)).toEqual(
      createHash("sha256")
        .update("agentera-encrypted-profile-backup-device-registration.v1\0")
        .update(canonical)
        .digest(),
    );

    const sharedSource = readFileSync(
      join(__dirname, "../../shared/agentera-encrypted-backup.ts"),
      "utf8",
    );
    expect(sharedSource).not.toMatch(
      /\b(?:devicePrivateKey|rootKey|encryptedPrivateKey)\b/,
    );
  }, 20_000);

  it("authorizes and revokes an account-bound device envelope", async () => {
    const { store } = storeFor();
    const enrollment = await store.initializeAccount({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      now: NOW,
    });
    if (!enrollment.recoveryPhrase) {
      throw new Error("missing recovery phrase");
    }
    const target = await generateBackupDeviceKeyPair();
    const authorized = await store.authorizeDevice({
      accountId: ACCOUNT_ID,
      sourceDeviceId: DEVICE_ID,
      deviceId: OTHER_DEVICE_ID,
      publicKey: target.publicKey,
      revision: 1,
      now: NOW,
    });
    expect(authorized.device).toMatchObject({
      deviceId: OTHER_DEVICE_ID,
      status: "active",
      isCurrent: false,
    });
    const recovered = await store.recoverRootKeyFromPhrase({
      accountId: ACCOUNT_ID,
      phrase: enrollment.recoveryPhrase,
    });
    const unwrapped = await unwrapRootKeyForDevice(
      target.privateKey,
      authorized.rootKeyEnvelope,
      backupDeviceRootKeyAad({
        accountId: ACCOUNT_ID,
        deviceId: OTHER_DEVICE_ID,
        keyEpoch: 1,
      }),
    );
    try {
      expect(Buffer.from(unwrapped)).toEqual(Buffer.from(recovered));
    } finally {
      recovered.fill(0);
      unwrapped.fill(0);
    }

    const state = store.revokeDevice({
      accountId: ACCOUNT_ID,
      sourceDeviceId: DEVICE_ID,
      deviceId: OTHER_DEVICE_ID,
      now: NOW,
    });
    expect(state.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: OTHER_DEVICE_ID,
          status: "revoked",
        }),
      ]),
    );
    await expect(
      store.wrapRootKeyForDevice({
        accountId: ACCOUNT_ID,
        sourceDeviceId: DEVICE_ID,
        deviceId: OTHER_DEVICE_ID,
        publicKey: target.publicKey,
      }),
    ).rejects.toThrow("revoked");
  }, 30_000);

  it("isolates accounts across logout-style owner switches", async () => {
    const { store } = storeFor();
    await store.initializeAccount({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      now: NOW,
    });
    expect(
      store.getState({
        accountId: OTHER_ACCOUNT_ID,
        deviceId: DEVICE_ID,
      }),
    ).toEqual({
      initialized: false,
      accountId: OTHER_ACCOUNT_ID,
      currentDeviceId: DEVICE_ID,
      keyEpoch: null,
      profileLineageId: null,
      recoveryConfirmed: false,
      devices: [],
    });
    await expect(
      store.recoverRootKeyFromPhrase({
        accountId: OTHER_ACCOUNT_ID,
        phrase:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      }),
    ).rejects.toThrow("not initialized");
  });

  it("fails closed when secure storage is unavailable, weak, or corrupt", async () => {
    const unavailable = new OpaqueSecureStorage();
    unavailable.available = false;
    await expect(
      storeFor(unavailable).store.initializeAccount({
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
      }),
    ).rejects.toThrow("Secure storage");

    const weak = new OpaqueSecureStorage();
    weak.backend = "basic_text";
    await expect(
      storeFor(weak).store.initializeAccount({
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
      }),
    ).rejects.toThrow("Secure storage");

    const { database, store } = storeFor();
    await store.initializeAccount({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
    });
    database.sqlite
      .prepare(
        "UPDATE encrypted_backup_accounts SET encrypted_root_key = ? WHERE account_id = ?",
      )
      .run(Buffer.from(randomUUID()), ACCOUNT_ID);
    await expect(
      store.wrapRootKeyForDevice({
        accountId: ACCOUNT_ID,
        sourceDeviceId: DEVICE_ID,
        deviceId: DEVICE_ID,
        publicKey: Buffer.alloc(32, 0x41).toString("base64url"),
      }),
    ).rejects.toThrow(/could not be opened|corrupt/i);
  });

  it("generates distinct valid X25519 backup keys", async () => {
    const one = await generateBackupDeviceKeyPair();
    const two = await generateBackupDeviceKeyPair();
    expect(base64urlDecode(one.publicKey, 32)).toHaveLength(32);
    expect(base64urlDecode(one.privateKey, 32)).toHaveLength(32);
    expect(one).not.toEqual(two);
  });
});
