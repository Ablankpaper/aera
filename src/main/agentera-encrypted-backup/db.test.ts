// @vitest-environment node

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { RecoveryRootKeyEnvelopeV1 } from "./crypto";
import {
  AGENTERA_ENCRYPTED_BACKUP_SCHEMA_VERSION,
  openAgenteraEncryptedBackupDatabase,
  resolveAgenteraEncryptedBackupPaths,
  type AgenteraEncryptedBackupDatabase,
  type AgenteraEncryptedBackupSqliteDatabase,
} from "./db";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "10000000-0000-4000-8000-000000000002";
const DEVICE_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_DEVICE_ID = "20000000-0000-4000-8000-000000000002";
const LINEAGE_ID = "30000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-23T12:00:00.000Z");
const roots: string[] = [];
const databases: AgenteraEncryptedBackupDatabase[] = [];
const originalHermesHome = process.env.HERMES_HOME;

function persistedBytes(databasePath: string): Buffer {
  return Buffer.concat(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path)),
  );
}

const recoveryEnvelope: RecoveryRootKeyEnvelopeV1 = {
  formatVersion: 1,
  kdf: "argon2id",
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
  salt: Buffer.alloc(16, 0x11).toString("base64url"),
  nonce: Buffer.alloc(12, 0x12).toString("base64url"),
  ciphertext: Buffer.alloc(48, 0x13).toString("base64url"),
};

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), "agentera-encrypted-backup-db-"));
  roots.push(root);
  return join(root, "user-data");
}

function databaseFor(
  userDataPath = temporaryUserData(),
): AgenteraEncryptedBackupDatabase {
  const database = openAgenteraEncryptedBackupDatabase(userDataPath, {
    databaseFactory: (path) =>
      new DatabaseSync(
        path,
      ) as unknown as AgenteraEncryptedBackupSqliteDatabase,
  });
  databases.push(database);
  return database;
}

function createAccount(
  database: AgenteraEncryptedBackupDatabase,
  accountId = ACCOUNT_ID,
  deviceId = DEVICE_ID,
): void {
  database.createAccount({
    accountId,
    profileLineageId:
      accountId === ACCOUNT_ID
        ? LINEAGE_ID
        : "30000000-0000-4000-8000-000000000002",
    keyEpoch: 1,
    encryptedRootKey: Buffer.from(`sealed-root:${accountId}`),
    recoveryEnvelope,
    localDevice: {
      deviceId,
      publicKey: Buffer.alloc(32, 0x21).toString("base64url"),
      encryptedPrivateKey: Buffer.from(`sealed-private:${deviceId}`),
      revision: 1,
    },
    createdAt: NOW,
  });
}

afterEach(() => {
  delete process.env.HERMES_HOME;
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (originalHermesHome !== undefined) {
    process.env.HERMES_HOME = originalHermesHome;
  }
});

describe("AgenteraEncryptedBackupDatabase", () => {
  it("opens only the restrictive absolute userData domain outside HERMES_HOME", () => {
    expect(() => resolveAgenteraEncryptedBackupPaths("relative/path")).toThrow(
      "absolute",
    );
    const userDataPath = temporaryUserData();
    expect(resolveAgenteraEncryptedBackupPaths(userDataPath)).toEqual({
      rootPath: join(userDataPath, "agentera-encrypted-backup"),
      databasePath: join(
        userDataPath,
        "agentera-encrypted-backup",
        "backup.db",
      ),
      transactionsPath: join(
        userDataPath,
        "agentera-encrypted-backup",
        "transactions",
      ),
    });
    process.env.HERMES_HOME = join(userDataPath, "agentera-encrypted-backup");
    expect(() => databaseFor(userDataPath)).toThrow("outside HERMES_HOME");
    delete process.env.HERMES_HOME;

    const database = databaseFor(userDataPath);
    expect(statSync(database.paths.rootPath).mode & 0o777).toBe(0o700);
    expect(statSync(database.paths.databasePath).mode & 0o777).toBe(0o600);
  });

  it("stores versioned account-bound key records without secret plaintext", () => {
    const database = databaseFor();
    createAccount(database);
    createAccount(database, OTHER_ACCOUNT_ID, OTHER_DEVICE_ID);

    expect(
      (
        database.sqlite.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(AGENTERA_ENCRYPTED_BACKUP_SCHEMA_VERSION);
    expect(database.readAccount(ACCOUNT_ID)).toMatchObject({
      accountId: ACCOUNT_ID,
      profileLineageId: LINEAGE_ID,
      keyEpoch: 1,
      recoveryConfirmed: false,
    });
    expect(database.readDevice(ACCOUNT_ID, DEVICE_ID)).toMatchObject({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      status: "active",
      isLocal: true,
    });
    expect(database.readDevice(OTHER_ACCOUNT_ID, DEVICE_ID)).toBeNull();
    expect(database.listDevices(ACCOUNT_ID)).toHaveLength(1);
    expect(database.listDevices(OTHER_ACCOUNT_ID)).toHaveLength(1);

    const bytes = persistedBytes(database.paths.databasePath);
    expect(bytes.includes(Buffer.from("sealed-root:"))).toBe(true);
    expect(bytes.includes(Buffer.alloc(32, 0x21))).toBe(false);
  });

  it("tracks account-scoped authorization, recovery confirmation, and revocation", () => {
    const database = databaseFor();
    createAccount(database);
    database.authorizeDevice({
      accountId: ACCOUNT_ID,
      deviceId: OTHER_DEVICE_ID,
      publicKey: Buffer.alloc(32, 0x31).toString("base64url"),
      keyEpoch: 1,
      revision: 1,
      authorizedAt: NOW,
    });
    expect(database.listDevices(ACCOUNT_ID)).toEqual([
      expect.objectContaining({ deviceId: DEVICE_ID, status: "active" }),
      expect.objectContaining({
        deviceId: OTHER_DEVICE_ID,
        status: "active",
        isLocal: false,
      }),
    ]);

    database.confirmRecoverySaved(ACCOUNT_ID, NOW);
    expect(database.readAccount(ACCOUNT_ID)?.recoveryConfirmed).toBe(true);
    database.revokeDevice(ACCOUNT_ID, OTHER_DEVICE_ID, NOW);
    expect(database.readDevice(ACCOUNT_ID, OTHER_DEVICE_ID)).toMatchObject({
      status: "revoked",
      revokedAt: NOW.toISOString(),
    });
    expect(database.readDevice(OTHER_ACCOUNT_ID, OTHER_DEVICE_ID)).toBeNull();
  });

  it("fails closed for corrupt records and unsupported schemas", () => {
    const userDataPath = temporaryUserData();
    const database = databaseFor(userDataPath);
    createAccount(database);
    database.sqlite
      .prepare(
        "UPDATE encrypted_backup_accounts SET recovery_envelope_json = ? WHERE account_id = ?",
      )
      .run('{"formatVersion":1,"phrase":"must-not-exist"}', ACCOUNT_ID);
    expect(() => database.readAccount(ACCOUNT_ID)).toThrow("corrupt");

    database.sqlite.exec("PRAGMA user_version = 99");
    database.close();
    databases.splice(databases.indexOf(database), 1);
    expect(() => databaseFor(userDataPath)).toThrow("Unsupported");
  });
});
