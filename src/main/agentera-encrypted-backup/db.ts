import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  AGENTERA_BACKUP_ARGON2_ITERATIONS,
  AGENTERA_BACKUP_ARGON2_MEMORY_KIB,
  AGENTERA_BACKUP_ARGON2_PARALLELISM,
  AGENTERA_BACKUP_FORMAT_VERSION,
  base64urlDecode,
  type RecoveryRootKeyEnvelopeV1,
} from "./crypto";

export const AGENTERA_ENCRYPTED_BACKUP_SCHEMA_VERSION = 2;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECOVERY_ENVELOPE_FIELDS = [
  "formatVersion",
  "kdf",
  "memoryKiB",
  "iterations",
  "parallelism",
  "salt",
  "nonce",
  "ciphertext",
] as const;

export interface AgenteraEncryptedBackupSqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface AgenteraEncryptedBackupSqliteStatement {
  run(...parameters: unknown[]): AgenteraEncryptedBackupSqliteRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface AgenteraEncryptedBackupSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): AgenteraEncryptedBackupSqliteStatement;
  close(): void;
}

export interface AgenteraEncryptedBackupPaths {
  rootPath: string;
  databasePath: string;
  transactionsPath: string;
}

export interface OpenAgenteraEncryptedBackupDatabaseOptions {
  databaseFactory?: (path: string) => AgenteraEncryptedBackupSqliteDatabase;
}

export interface EncryptedBackupAccountRecord {
  accountId: string;
  profileLineageId: string;
  keyEpoch: number;
  encryptedRootKey: Buffer;
  recoveryEnvelope: RecoveryRootKeyEnvelopeV1;
  recoveryConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedBackupDeviceRecord {
  accountId: string;
  deviceId: string;
  publicKey: string;
  encryptedPrivateKey: Buffer | null;
  keyEpoch: number;
  revision: number;
  status: "active" | "revoked";
  isLocal: boolean;
  authorizedAt: string;
  revokedAt: string | null;
}

export interface EncryptedBackupPendingDeviceRecord {
  accountId: string;
  deviceId: string;
  publicKey: string;
  encryptedPrivateKey: Buffer;
  keyEpoch: number;
  revision: number;
  createdAt: string;
}

export interface CreateEncryptedBackupAccountInput {
  accountId: string;
  profileLineageId: string;
  keyEpoch: number;
  encryptedRootKey: Uint8Array;
  recoveryEnvelope: RecoveryRootKeyEnvelopeV1;
  localDevice: {
    deviceId: string;
    publicKey: string;
    encryptedPrivateKey: Uint8Array;
    revision: number;
  };
  createdAt: Date;
}

export interface AuthorizeEncryptedBackupDeviceInput {
  accountId: string;
  deviceId: string;
  publicKey: string;
  keyEpoch: number;
  revision: number;
  authorizedAt: Date;
}

export interface SaveEncryptedBackupPendingDeviceInput {
  accountId: string;
  deviceId: string;
  publicKey: string;
  encryptedPrivateKey: Uint8Array;
  keyEpoch: number;
  revision: number;
  createdAt: Date;
}

interface AccountRow {
  account_id?: unknown;
  profile_lineage_id?: unknown;
  key_epoch?: unknown;
  encrypted_root_key?: unknown;
  recovery_envelope_json?: unknown;
  recovery_confirmed?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface DeviceRow {
  account_id?: unknown;
  device_id?: unknown;
  public_key?: unknown;
  encrypted_private_key?: unknown;
  key_epoch?: unknown;
  revision?: unknown;
  status?: unknown;
  is_local?: unknown;
  authorized_at?: unknown;
  revoked_at?: unknown;
}

interface PendingDeviceRow {
  account_id?: unknown;
  device_id?: unknown;
  public_key?: unknown;
  encrypted_private_key?: unknown;
  key_epoch?: unknown;
  revision?: unknown;
  created_at?: unknown;
}

const localRequire = createRequire(
  typeof __filename === "string"
    ? __filename
    : join(process.cwd(), "package.json"),
);

function defaultDatabaseFactory(
  path: string,
): AgenteraEncryptedBackupSqliteDatabase {
  const loaded = localRequire("better-sqlite3") as
    | (new (databasePath: string) => AgenteraEncryptedBackupSqliteDatabase)
    | {
        default: new (
          databasePath: string,
        ) => AgenteraEncryptedBackupSqliteDatabase;
      };
  const Constructor = typeof loaded === "function" ? loaded : loaded.default;
  return new Constructor(path);
}

function isPathInside(parent: string, child: string): boolean {
  const childRelative = relative(resolve(parent), resolve(child));
  return (
    childRelative === "" ||
    (!childRelative.startsWith("..") && !isAbsolute(childRelative))
  );
}

function canonicalPotentialPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  let canonical = existing;
  try {
    canonical = realpathSync.native(existing);
  } catch {
    canonical = resolve(existing);
  }
  return join(canonical, ...missing);
}

function assertOutsideHermesHome(path: string): void {
  const hermesHome = process.env.HERMES_HOME;
  if (
    typeof hermesHome === "string" &&
    hermesHome.length > 0 &&
    isPathInside(
      canonicalPotentialPath(hermesHome),
      canonicalPotentialPath(path),
    )
  ) {
    throw new Error(
      "AgentEra encrypted backup path must remain outside HERMES_HOME.",
    );
  }
}

export function resolveAgenteraEncryptedBackupPaths(
  userDataPath: string,
): AgenteraEncryptedBackupPaths {
  if (typeof userDataPath !== "string" || !isAbsolute(userDataPath)) {
    throw new Error("Electron userData path must be absolute.");
  }
  const rootPath = join(resolve(userDataPath), "agentera-encrypted-backup");
  assertOutsideHermesHome(rootPath);
  return {
    rootPath,
    databasePath: join(rootPath, "backup.db"),
    transactionsPath: join(rootPath, "transactions"),
  };
}

function initializeSchema(sqlite: AgenteraEncryptedBackupSqliteDatabase): void {
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA synchronous = FULL");
  const integrity = sqlite.prepare("PRAGMA quick_check").get() as
    | Record<string, unknown>
    | undefined;
  if (!integrity || Object.values(integrity)[0] !== "ok") {
    throw new Error("AgentEra encrypted backup database is corrupt.");
  }
  const current = sqlite.prepare("PRAGMA user_version").get() as
    | Record<string, unknown>
    | undefined;
  const currentVersion = current ? Number(Object.values(current)[0]) : 0;
  if (
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > AGENTERA_ENCRYPTED_BACKUP_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported AgentEra encrypted backup database version.");
  }
  if (currentVersion === AGENTERA_ENCRYPTED_BACKUP_SCHEMA_VERSION) return;

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    if (currentVersion < 1) {
      sqlite.exec(`
        CREATE TABLE encrypted_backup_accounts (
          account_id TEXT PRIMARY KEY,
          profile_lineage_id TEXT NOT NULL UNIQUE,
          key_epoch INTEGER NOT NULL CHECK (key_epoch >= 1),
          encrypted_root_key BLOB NOT NULL CHECK (length(encrypted_root_key) >= 1),
          recovery_envelope_json TEXT NOT NULL,
          recovery_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (recovery_confirmed IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE encrypted_backup_devices (
          account_id TEXT NOT NULL REFERENCES encrypted_backup_accounts(account_id) ON DELETE CASCADE,
          device_id TEXT NOT NULL,
          public_key TEXT NOT NULL,
          encrypted_private_key BLOB,
          key_epoch INTEGER NOT NULL CHECK (key_epoch >= 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
          is_local INTEGER NOT NULL CHECK (is_local IN (0, 1)),
          authorized_at TEXT NOT NULL,
          revoked_at TEXT,
          PRIMARY KEY (account_id, device_id),
          CHECK (
            (status = 'active' AND revoked_at IS NULL) OR
            (status = 'revoked' AND revoked_at IS NOT NULL)
          ),
          CHECK (
            (is_local = 1) OR encrypted_private_key IS NULL
          )
        );

        CREATE INDEX encrypted_backup_devices_account_status_idx
          ON encrypted_backup_devices (account_id, status, device_id);

        PRAGMA user_version = 1;
      `);
    }
    if (currentVersion < 2) {
      sqlite.exec(`
        CREATE TABLE encrypted_backup_pending_devices (
          account_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          public_key TEXT NOT NULL,
          encrypted_private_key BLOB NOT NULL CHECK (length(encrypted_private_key) >= 1),
          key_epoch INTEGER NOT NULL CHECK (key_epoch >= 1),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          created_at TEXT NOT NULL,
          PRIMARY KEY (account_id, device_id)
        );

        PRAGMA user_version = 2;
      `);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // Preserve the original schema failure.
    }
    throw error;
  }
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new Error(`Invalid encrypted backup ${label}.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid encrypted backup ${label}.`);
  }
  return parsed;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`AgentEra encrypted backup ${label} is corrupt.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`AgentEra encrypted backup ${label} is corrupt.`);
  }
  return value;
}

function inputTimestamp(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Invalid encrypted backup ${label}.`);
  }
  return value.toISOString();
}

function encryptedBytes(value: unknown, label: string): Buffer {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > 64 * 1024
  ) {
    throw new Error(`AgentEra encrypted backup ${label} is corrupt.`);
  }
  return Buffer.from(value);
}

function publicKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("AgentEra encrypted backup device record is corrupt.");
  }
  try {
    base64urlDecode(value, 32);
  } catch {
    throw new Error("AgentEra encrypted backup device record is corrupt.");
  }
  return value;
}

function parseRecoveryEnvelope(value: unknown): RecoveryRootKeyEnvelopeV1 {
  if (typeof value !== "string") {
    throw new Error("AgentEra encrypted backup account record is corrupt.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("AgentEra encrypted backup account record is corrupt.");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new Error("AgentEra encrypted backup account record is corrupt.");
  }
  const object = parsed as Record<string, unknown>;
  const actualFields = Object.keys(object).sort();
  const expectedFields = [...RECOVERY_ENVELOPE_FIELDS].sort();
  if (
    actualFields.length !== expectedFields.length ||
    actualFields.some((field, index) => field !== expectedFields[index]) ||
    object.formatVersion !== AGENTERA_BACKUP_FORMAT_VERSION ||
    object.kdf !== "argon2id" ||
    object.memoryKiB !== AGENTERA_BACKUP_ARGON2_MEMORY_KIB ||
    object.iterations !== AGENTERA_BACKUP_ARGON2_ITERATIONS ||
    object.parallelism !== AGENTERA_BACKUP_ARGON2_PARALLELISM
  ) {
    throw new Error("AgentEra encrypted backup account record is corrupt.");
  }
  try {
    base64urlDecode(String(object.salt), 16);
    base64urlDecode(String(object.nonce), 12);
    base64urlDecode(String(object.ciphertext), 48);
  } catch {
    throw new Error("AgentEra encrypted backup account record is corrupt.");
  }
  return {
    formatVersion: AGENTERA_BACKUP_FORMAT_VERSION,
    kdf: "argon2id",
    memoryKiB: AGENTERA_BACKUP_ARGON2_MEMORY_KIB,
    iterations: AGENTERA_BACKUP_ARGON2_ITERATIONS,
    parallelism: AGENTERA_BACKUP_ARGON2_PARALLELISM,
    salt: String(object.salt),
    nonce: String(object.nonce),
    ciphertext: String(object.ciphertext),
  };
}

function serializeRecoveryEnvelope(
  envelope: RecoveryRootKeyEnvelopeV1,
): string {
  return JSON.stringify(parseRecoveryEnvelope(JSON.stringify(envelope)));
}

export class AgenteraEncryptedBackupDatabase {
  readonly paths: AgenteraEncryptedBackupPaths;
  readonly sqlite: AgenteraEncryptedBackupSqliteDatabase;
  private closed = false;

  constructor(
    paths: AgenteraEncryptedBackupPaths,
    sqlite: AgenteraEncryptedBackupSqliteDatabase,
  ) {
    this.paths = paths;
    this.sqlite = sqlite;
  }

  createAccount(input: CreateEncryptedBackupAccountInput): void {
    const accountId = identifier(input.accountId, "account ID");
    const profileLineageId = identifier(
      input.profileLineageId,
      "profile lineage ID",
    );
    const keyEpoch = positiveInteger(input.keyEpoch, "key epoch");
    const encryptedRootKey = encryptedBytes(
      input.encryptedRootKey,
      "root-key record",
    );
    const recoveryEnvelopeJSON = serializeRecoveryEnvelope(
      input.recoveryEnvelope,
    );
    const deviceId = identifier(input.localDevice.deviceId, "device ID");
    const devicePublicKey = publicKey(input.localDevice.publicKey);
    const encryptedPrivateKey = encryptedBytes(
      input.localDevice.encryptedPrivateKey,
      "device-key record",
    );
    const revision = positiveInteger(
      input.localDevice.revision,
      "device revision",
    );
    const createdAt = inputTimestamp(input.createdAt, "creation time");

    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite
        .prepare(
          `INSERT INTO encrypted_backup_accounts (
             account_id, profile_lineage_id, key_epoch, encrypted_root_key,
             recovery_envelope_json, recovery_confirmed, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          accountId,
          profileLineageId,
          keyEpoch,
          encryptedRootKey,
          recoveryEnvelopeJSON,
          createdAt,
          createdAt,
        );
      this.sqlite
        .prepare(
          `INSERT INTO encrypted_backup_devices (
             account_id, device_id, public_key, encrypted_private_key,
             key_epoch, revision, status, is_local, authorized_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, NULL)`,
        )
        .run(
          accountId,
          deviceId,
          devicePublicKey,
          encryptedPrivateKey,
          keyEpoch,
          revision,
          createdAt,
        );
      this.sqlite.exec("COMMIT");
    } catch (error) {
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the original insert failure.
      }
      throw error;
    } finally {
      encryptedRootKey.fill(0);
      encryptedPrivateKey.fill(0);
    }
  }

  readAccount(accountIdValue: string): EncryptedBackupAccountRecord | null {
    const accountId = identifier(accountIdValue, "account ID");
    const row = this.sqlite
      .prepare(
        `SELECT account_id, profile_lineage_id, key_epoch,
                encrypted_root_key, recovery_envelope_json,
                recovery_confirmed, created_at, updated_at
         FROM encrypted_backup_accounts WHERE account_id = ?`,
      )
      .get(accountId) as AccountRow | undefined;
    if (!row) return null;
    try {
      if (row.recovery_confirmed !== 0 && row.recovery_confirmed !== 1) {
        throw new Error();
      }
      return {
        accountId: identifier(row.account_id, "account ID"),
        profileLineageId: identifier(
          row.profile_lineage_id,
          "profile lineage ID",
        ),
        keyEpoch: positiveInteger(row.key_epoch, "key epoch"),
        encryptedRootKey: encryptedBytes(
          row.encrypted_root_key,
          "root-key record",
        ),
        recoveryEnvelope: parseRecoveryEnvelope(row.recovery_envelope_json),
        recoveryConfirmed: row.recovery_confirmed === 1,
        createdAt: canonicalTimestamp(row.created_at, "creation time"),
        updatedAt: canonicalTimestamp(row.updated_at, "update time"),
      };
    } catch {
      throw new Error("AgentEra encrypted backup account record is corrupt.");
    }
  }

  readDevice(
    accountIdValue: string,
    deviceIdValue: string,
  ): EncryptedBackupDeviceRecord | null {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const row = this.sqlite
      .prepare(
        `SELECT account_id, device_id, public_key, encrypted_private_key,
                key_epoch, revision, status, is_local, authorized_at,
                revoked_at
         FROM encrypted_backup_devices
         WHERE account_id = ? AND device_id = ?`,
      )
      .get(accountId, deviceId) as DeviceRow | undefined;
    return row ? this.parseDevice(row) : null;
  }

  listDevices(accountIdValue: string): EncryptedBackupDeviceRecord[] {
    const accountId = identifier(accountIdValue, "account ID");
    return this.sqlite
      .prepare(
        `SELECT account_id, device_id, public_key, encrypted_private_key,
                key_epoch, revision, status, is_local, authorized_at,
                revoked_at
         FROM encrypted_backup_devices
         WHERE account_id = ?
         ORDER BY is_local DESC, device_id ASC`,
      )
      .all(accountId)
      .map((row) => this.parseDevice(row as DeviceRow));
  }

  savePendingDevice(input: SaveEncryptedBackupPendingDeviceInput): void {
    const accountId = identifier(input.accountId, "account ID");
    const deviceId = identifier(input.deviceId, "device ID");
    const devicePublicKey = publicKey(input.publicKey);
    const encryptedPrivateKey = encryptedBytes(
      input.encryptedPrivateKey,
      "pending device-key record",
    );
    const keyEpoch = positiveInteger(input.keyEpoch, "key epoch");
    const revision = positiveInteger(input.revision, "device revision");
    const createdAt = inputTimestamp(input.createdAt, "creation time");
    try {
      const existing = this.readPendingDevice(accountId, deviceId);
      if (existing) {
        if (
          existing.publicKey === devicePublicKey &&
          existing.keyEpoch === keyEpoch &&
          existing.revision === revision &&
          existing.encryptedPrivateKey.equals(encryptedPrivateKey)
        ) {
          return;
        }
        throw new Error("Encrypted backup pending device conflicts.");
      }
      this.sqlite
        .prepare(
          `INSERT INTO encrypted_backup_pending_devices (
             account_id, device_id, public_key, encrypted_private_key,
             key_epoch, revision, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          accountId,
          deviceId,
          devicePublicKey,
          encryptedPrivateKey,
          keyEpoch,
          revision,
          createdAt,
        );
    } finally {
      encryptedPrivateKey.fill(0);
    }
  }

  readPendingDevice(
    accountIdValue: string,
    deviceIdValue: string,
  ): EncryptedBackupPendingDeviceRecord | null {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const row = this.sqlite
      .prepare(
        `SELECT account_id, device_id, public_key, encrypted_private_key,
                key_epoch, revision, created_at
         FROM encrypted_backup_pending_devices
         WHERE account_id = ? AND device_id = ?`,
      )
      .get(accountId, deviceId) as PendingDeviceRow | undefined;
    if (!row) return null;
    try {
      return {
        accountId: identifier(row.account_id, "account ID"),
        deviceId: identifier(row.device_id, "device ID"),
        publicKey: publicKey(row.public_key),
        encryptedPrivateKey: encryptedBytes(
          row.encrypted_private_key,
          "pending device-key record",
        ),
        keyEpoch: positiveInteger(row.key_epoch, "key epoch"),
        revision: positiveInteger(row.revision, "device revision"),
        createdAt: canonicalTimestamp(row.created_at, "creation time"),
      };
    } catch {
      throw new Error(
        "AgentEra encrypted backup pending device record is corrupt.",
      );
    }
  }

  deletePendingDevice(accountIdValue: string, deviceIdValue: string): boolean {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const result = this.sqlite
      .prepare(
        `DELETE FROM encrypted_backup_pending_devices
         WHERE account_id = ? AND device_id = ?`,
      )
      .run(accountId, deviceId);
    return Number(result.changes) === 1;
  }

  authorizeDevice(input: AuthorizeEncryptedBackupDeviceInput): void {
    const accountId = identifier(input.accountId, "account ID");
    const deviceId = identifier(input.deviceId, "device ID");
    const devicePublicKey = publicKey(input.publicKey);
    const keyEpoch = positiveInteger(input.keyEpoch, "key epoch");
    const revision = positiveInteger(input.revision, "device revision");
    const authorizedAt = inputTimestamp(
      input.authorizedAt,
      "authorization time",
    );
    const account = this.readAccount(accountId);
    if (!account || account.keyEpoch !== keyEpoch) {
      throw new Error("Encrypted backup account or key epoch is unavailable.");
    }
    const existing = this.readDevice(accountId, deviceId);
    if (existing) {
      if (existing.status === "revoked") {
        throw new Error("Encrypted backup device is revoked.");
      }
      if (
        existing.keyEpoch === keyEpoch &&
        existing.revision === revision &&
        existing.publicKey === devicePublicKey
      ) {
        return;
      }
      if (existing.isLocal || revision <= existing.revision) {
        throw new Error("Encrypted backup device revision conflicts.");
      }
      this.sqlite
        .prepare(
          `UPDATE encrypted_backup_devices
           SET public_key = ?, key_epoch = ?, revision = ?,
               authorized_at = ?, revoked_at = NULL
           WHERE account_id = ? AND device_id = ? AND status = 'active'`,
        )
        .run(
          devicePublicKey,
          keyEpoch,
          revision,
          authorizedAt,
          accountId,
          deviceId,
        );
      return;
    }
    this.sqlite
      .prepare(
        `INSERT INTO encrypted_backup_devices (
           account_id, device_id, public_key, encrypted_private_key,
           key_epoch, revision, status, is_local, authorized_at, revoked_at
         ) VALUES (?, ?, ?, NULL, ?, ?, 'active', 0, ?, NULL)`,
      )
      .run(
        accountId,
        deviceId,
        devicePublicKey,
        keyEpoch,
        revision,
        authorizedAt,
      );
  }

  revokeDevice(
    accountIdValue: string,
    deviceIdValue: string,
    revokedAtValue: Date,
  ): void {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const revokedAt = inputTimestamp(revokedAtValue, "revocation time");
    const existing = this.readDevice(accountId, deviceId);
    if (!existing) {
      throw new Error("Encrypted backup device is unavailable.");
    }
    if (existing.status === "revoked") return;
    this.sqlite
      .prepare(
        `UPDATE encrypted_backup_devices
         SET status = 'revoked', encrypted_private_key = NULL, revoked_at = ?
         WHERE account_id = ? AND device_id = ? AND status = 'active'`,
      )
      .run(revokedAt, accountId, deviceId);
  }

  confirmRecoverySaved(accountIdValue: string, updatedAtValue: Date): void {
    const accountId = identifier(accountIdValue, "account ID");
    const updatedAt = inputTimestamp(updatedAtValue, "update time");
    const result = this.sqlite
      .prepare(
        `UPDATE encrypted_backup_accounts
         SET recovery_confirmed = 1, updated_at = ?
         WHERE account_id = ?`,
      )
      .run(updatedAt, accountId);
    if (Number(result.changes) !== 1) {
      throw new Error("Encrypted backup account is unavailable.");
    }
  }

  private parseDevice(row: DeviceRow): EncryptedBackupDeviceRecord {
    try {
      if (
        (row.status !== "active" && row.status !== "revoked") ||
        (row.is_local !== 0 && row.is_local !== 1) ||
        (row.status === "active" && row.revoked_at !== null) ||
        (row.status === "revoked" && typeof row.revoked_at !== "string")
      ) {
        throw new Error();
      }
      const encryptedPrivateKey =
        row.encrypted_private_key === null
          ? null
          : encryptedBytes(row.encrypted_private_key, "device-key record");
      if (row.is_local === 0 && encryptedPrivateKey !== null) {
        throw new Error();
      }
      if (
        row.is_local === 1 &&
        row.status === "active" &&
        encryptedPrivateKey === null
      ) {
        throw new Error();
      }
      return {
        accountId: identifier(row.account_id, "account ID"),
        deviceId: identifier(row.device_id, "device ID"),
        publicKey: publicKey(row.public_key),
        encryptedPrivateKey,
        keyEpoch: positiveInteger(row.key_epoch, "key epoch"),
        revision: positiveInteger(row.revision, "device revision"),
        status: row.status,
        isLocal: row.is_local === 1,
        authorizedAt: canonicalTimestamp(
          row.authorized_at,
          "authorization time",
        ),
        revokedAt:
          row.revoked_at === null
            ? null
            : canonicalTimestamp(row.revoked_at, "revocation time"),
      };
    } catch {
      throw new Error("AgentEra encrypted backup device record is corrupt.");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }
}

export function openAgenteraEncryptedBackupDatabase(
  userDataPath: string,
  options: OpenAgenteraEncryptedBackupDatabaseOptions = {},
): AgenteraEncryptedBackupDatabase {
  const paths = resolveAgenteraEncryptedBackupPaths(userDataPath);
  mkdirSync(paths.rootPath, { recursive: true, mode: 0o700 });
  chmodSync(paths.rootPath, 0o700);
  assertOutsideHermesHome(paths.rootPath);
  const sqlite = (options.databaseFactory ?? defaultDatabaseFactory)(
    paths.databasePath,
  );
  try {
    if (existsSync(paths.databasePath)) chmodSync(paths.databasePath, 0o600);
    initializeSchema(sqlite);
    if (existsSync(paths.databasePath)) chmodSync(paths.databasePath, 0o600);
    return new AgenteraEncryptedBackupDatabase(paths, sqlite);
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the original initialization failure.
    }
    throw error;
  }
}
