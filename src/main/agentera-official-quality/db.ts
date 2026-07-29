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
  OFFICIAL_QUALITY_PURPOSES,
  type OfficialQualityConsentReceipt,
  type OfficialQualityConsentSettings,
  type OfficialQualityEnvelope,
  type OfficialQualityPurpose,
} from "../../shared/agentera-official-quality";
import {
  parseOfficialQualityEnvelope,
  serializeOfficialQualityEnvelope,
} from "./model";

export const AGENTERA_OFFICIAL_QUALITY_SCHEMA_VERSION = 1;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTBOX_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const MAXIMUM_OUTBOX_EVENTS = 1_000;

export interface AgenteraOfficialQualitySqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface AgenteraOfficialQualitySqliteStatement {
  run(...parameters: unknown[]): AgenteraOfficialQualitySqliteRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface AgenteraOfficialQualitySqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): AgenteraOfficialQualitySqliteStatement;
  close(): void;
}

export interface AgenteraOfficialQualityPaths {
  rootPath: string;
  databasePath: string;
}

export interface OpenAgenteraOfficialQualityDatabaseOptions {
  databaseFactory?: (path: string) => AgenteraOfficialQualitySqliteDatabase;
}

export interface EnqueueOfficialQualityInput {
  accountId: string;
  deviceId: string;
  purpose: OfficialQualityPurpose;
  envelope: unknown;
  now?: Date;
}

export interface OfficialQualityOutboxEntry {
  eventId: string;
  purpose: OfficialQualityPurpose;
  envelopeJson: string;
  attemptCount: number;
  createdAt: string;
  expiresAt: string;
}

interface ConsentRow {
  enabled?: unknown;
  consent_version?: unknown;
  updated_at?: unknown;
}

interface ExistingOutboxRow {
  account_id?: unknown;
  device_id?: unknown;
  purpose?: unknown;
  consent_version?: unknown;
  envelope_json?: unknown;
}

interface OutboxRow {
  event_id?: unknown;
  purpose?: unknown;
  envelope_json?: unknown;
  attempt_count?: unknown;
  created_at?: unknown;
  expires_at?: unknown;
}

const localRequire = createRequire(
  typeof __filename === "string"
    ? __filename
    : join(process.cwd(), "package.json"),
);

function defaultDatabaseFactory(
  path: string,
): AgenteraOfficialQualitySqliteDatabase {
  const loaded = localRequire("better-sqlite3") as
    | (new (databasePath: string) => AgenteraOfficialQualitySqliteDatabase)
    | {
        default: new (
          databasePath: string,
        ) => AgenteraOfficialQualitySqliteDatabase;
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
      "Aera official quality path must remain outside HERMES_HOME.",
    );
  }
}

export function resolveAgenteraOfficialQualityPaths(
  userDataPath: string,
): AgenteraOfficialQualityPaths {
  if (typeof userDataPath !== "string" || !isAbsolute(userDataPath)) {
    throw new Error("Electron userData path must be absolute.");
  }
  const rootPath = join(resolve(userDataPath), "agentera-official-quality");
  assertOutsideHermesHome(rootPath);
  return { rootPath, databasePath: join(rootPath, "quality.db") };
}

function initializeSchema(sqlite: AgenteraOfficialQualitySqliteDatabase): void {
  sqlite.exec("PRAGMA foreign_keys = ON");
  const current = sqlite.prepare("PRAGMA user_version").get() as
    | Record<string, unknown>
    | undefined;
  const currentVersion = current ? Number(Object.values(current)[0]) : 0;
  if (
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > AGENTERA_OFFICIAL_QUALITY_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported Aera official quality database version.");
  }
  if (currentVersion === AGENTERA_OFFICIAL_QUALITY_SCHEMA_VERSION) return;
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(`
      CREATE TABLE official_quality_consent (
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('official_quality_metrics', 'official_explicit_feedback')),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        consent_version INTEGER NOT NULL CHECK (consent_version >= 1),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, device_id, purpose)
      );

      CREATE TABLE official_quality_outbox (
        event_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('official_quality_metrics', 'official_explicit_feedback')),
        consent_version INTEGER NOT NULL CHECK (consent_version >= 1),
        event_day TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX official_quality_outbox_due_idx
        ON official_quality_outbox (account_id, device_id, next_attempt_at, created_at);
      CREATE INDEX official_quality_outbox_expiry_idx
        ON official_quality_outbox (expires_at);

      PRAGMA user_version = 1;
    `);
    sqlite.exec("COMMIT");
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // Preserve the original schema error.
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
    throw new Error(`Invalid official quality ${label}.`);
  }
  return value;
}

function purpose(value: unknown): OfficialQualityPurpose {
  if (
    typeof value !== "string" ||
    !OFFICIAL_QUALITY_PURPOSES.includes(value as OfficialQualityPurpose)
  ) {
    throw new Error("Invalid official quality purpose.");
  }
  return value as OfficialQualityPurpose;
}

function timestamp(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid official quality timestamp.");
  }
  return value.toISOString();
}

export class AgenteraOfficialQualityDatabase {
  readonly paths: AgenteraOfficialQualityPaths;
  readonly sqlite: AgenteraOfficialQualitySqliteDatabase;
  private closed = false;

  constructor(
    paths: AgenteraOfficialQualityPaths,
    sqlite: AgenteraOfficialQualitySqliteDatabase,
  ) {
    this.paths = paths;
    this.sqlite = sqlite;
  }

  readConsent(
    accountIdValue: string,
    deviceIdValue: string,
  ): OfficialQualityConsentSettings {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const passive = this.readConsentReceipt(
      accountId,
      deviceId,
      "official_quality_metrics",
    );
    const explicit = this.readConsentReceipt(
      accountId,
      deviceId,
      "official_explicit_feedback",
    );
    return {
      passive: passive.enabled,
      explicitFeedback: explicit.enabled,
    };
  }

  readConsentReceipt(
    accountIdValue: string,
    deviceIdValue: string,
    purposeValue: OfficialQualityPurpose,
  ): OfficialQualityConsentReceipt {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const qualityPurpose = purpose(purposeValue);
    const row = this.sqlite
      .prepare(
        `SELECT enabled, consent_version, updated_at
         FROM official_quality_consent
         WHERE account_id = ? AND device_id = ? AND purpose = ?`,
      )
      .get(accountId, deviceId, qualityPurpose) as ConsentRow | undefined;
    if (!row) {
      return {
        purpose: qualityPurpose,
        enabled: false,
        version: 0,
        updatedAt: null,
      };
    }
    const version = Number(row.consent_version);
    if (
      (row.enabled !== 0 && row.enabled !== 1) ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      typeof row.updated_at !== "string"
    ) {
      throw new Error("Aera official quality consent is corrupt.");
    }
    return {
      purpose: qualityPurpose,
      enabled: row.enabled === 1,
      version,
      updatedAt: row.updated_at,
    };
  }

  setConsent(
    accountIdValue: string,
    deviceIdValue: string,
    purposeValue: OfficialQualityPurpose,
    enabledValue: boolean,
    updatedAtValue = new Date(),
  ): OfficialQualityConsentReceipt {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const qualityPurpose = purpose(purposeValue);
    if (typeof enabledValue !== "boolean") {
      throw new Error("Invalid official quality consent state.");
    }
    const updatedAt = timestamp(updatedAtValue);
    const current = this.readConsentReceipt(
      accountId,
      deviceId,
      qualityPurpose,
    );
    if (current.version > 0 && current.enabled === enabledValue) return current;
    const version = current.version + 1;
    this.sqlite
      .prepare(
        `INSERT INTO official_quality_consent (
           account_id, device_id, purpose, enabled, consent_version, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, device_id, purpose) DO UPDATE SET
           enabled = excluded.enabled,
           consent_version = excluded.consent_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        accountId,
        deviceId,
        qualityPurpose,
        enabledValue ? 1 : 0,
        version,
        updatedAt,
      );
    return {
      purpose: qualityPurpose,
      enabled: enabledValue,
      version,
      updatedAt,
    };
  }

  enqueue(input: EnqueueOfficialQualityInput): OfficialQualityEnvelope {
    const accountId = identifier(input.accountId, "account ID");
    const deviceId = identifier(input.deviceId, "device ID");
    const qualityPurpose = purpose(input.purpose);
    const now = input.now ?? new Date();
    const createdAt = timestamp(now);
    const envelope = parseOfficialQualityEnvelope(input.envelope, now);
    const expectedPurpose =
      envelope.kind === "metric"
        ? "official_quality_metrics"
        : "official_explicit_feedback";
    const receipt = this.readConsentReceipt(
      accountId,
      deviceId,
      qualityPurpose,
    );
    if (
      expectedPurpose !== qualityPurpose ||
      !receipt.enabled ||
      receipt.version !== envelope.consent_version
    ) {
      throw new Error("Official quality consent is inactive or stale.");
    }
    const envelopeJSON = serializeOfficialQualityEnvelope(envelope, now);
    const existing = this.sqlite
      .prepare(
        `SELECT account_id, device_id, purpose, consent_version, envelope_json
         FROM official_quality_outbox WHERE event_id = ?`,
      )
      .get(envelope.event_id) as ExistingOutboxRow | undefined;
    if (existing) {
      if (
        existing.account_id === accountId &&
        existing.device_id === deviceId &&
        existing.purpose === qualityPurpose &&
        existing.consent_version === envelope.consent_version &&
        existing.envelope_json === envelopeJSON
      ) {
        return envelope;
      }
      throw new Error("Official quality outbox event conflicts.");
    }
    this.purgeExpired(now);
    this.reserveOutboxCapacity(accountId, deviceId, qualityPurpose);
    const expiresAt = new Date(
      now.getTime() + OUTBOX_RETENTION_MILLISECONDS,
    ).toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO official_quality_outbox (
           event_id, account_id, device_id, purpose, consent_version,
           event_day, envelope_json, attempt_count, next_attempt_at,
           created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        envelope.event_id,
        accountId,
        deviceId,
        qualityPurpose,
        envelope.consent_version,
        envelope.event_day,
        envelopeJSON,
        createdAt,
        createdAt,
        expiresAt,
      );
    return envelope;
  }

  countOutbox(accountIdValue: string, deviceIdValue: string): number {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
         FROM official_quality_outbox
         WHERE account_id = ? AND device_id = ?`,
      )
      .get(accountId, deviceId) as { count?: unknown } | undefined;
    const count = Number(row?.count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Aera official quality outbox is corrupt.");
    }
    return count;
  }

  listDue(
    accountIdValue: string,
    deviceIdValue: string,
    nowValue = new Date(),
    limitValue = 25,
  ): OfficialQualityOutboxEntry[] {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const now = timestamp(nowValue);
    if (
      !Number.isSafeInteger(limitValue) ||
      limitValue < 1 ||
      limitValue > 100
    ) {
      throw new Error("Invalid official quality outbox limit.");
    }
    this.purgeExpired(nowValue);
    return this.sqlite
      .prepare(
        `SELECT event_id, purpose, envelope_json, attempt_count,
                created_at, expires_at
         FROM official_quality_outbox
         WHERE account_id = ? AND device_id = ? AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, created_at ASC, event_id ASC
         LIMIT ?`,
      )
      .all(accountId, deviceId, now, limitValue)
      .map((row) => this.parseOutboxRow(row as OutboxRow, nowValue));
  }

  acknowledge(
    accountIdValue: string,
    deviceIdValue: string,
    eventIdValue: string,
  ): void {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const eventId = identifier(eventIdValue, "event ID");
    this.sqlite
      .prepare(
        `DELETE FROM official_quality_outbox
         WHERE event_id = ? AND account_id = ? AND device_id = ?`,
      )
      .run(eventId, accountId, deviceId);
  }

  recordRetry(
    accountIdValue: string,
    deviceIdValue: string,
    eventIdValue: string,
    nextAttemptAtValue: Date,
  ): void {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const eventId = identifier(eventIdValue, "event ID");
    const nextAttemptAt = timestamp(nextAttemptAtValue);
    this.sqlite
      .prepare(
        `UPDATE official_quality_outbox
         SET attempt_count = attempt_count + 1, next_attempt_at = ?
         WHERE event_id = ? AND account_id = ? AND device_id = ?`,
      )
      .run(nextAttemptAt, eventId, accountId, deviceId);
  }

  purgePurpose(
    accountIdValue: string,
    deviceIdValue: string,
    purposeValue: OfficialQualityPurpose,
  ): void {
    const accountId = identifier(accountIdValue, "account ID");
    const deviceId = identifier(deviceIdValue, "device ID");
    const qualityPurpose = purpose(purposeValue);
    this.sqlite
      .prepare(
        `DELETE FROM official_quality_outbox
         WHERE account_id = ? AND device_id = ? AND purpose = ?`,
      )
      .run(accountId, deviceId, qualityPurpose);
  }

  purgeAccount(accountIdValue: string): void {
    const accountId = identifier(accountIdValue, "account ID");
    this.sqlite
      .prepare("DELETE FROM official_quality_outbox WHERE account_id = ?")
      .run(accountId);
  }

  purgeExpired(nowValue = new Date()): number {
    const now = timestamp(nowValue);
    const result = this.sqlite
      .prepare("DELETE FROM official_quality_outbox WHERE expires_at <= ?")
      .run(now);
    return Number(result.changes);
  }

  private reserveOutboxCapacity(
    accountId: string,
    deviceId: string,
    incomingPurpose: OfficialQualityPurpose,
  ): void {
    const count = this.countOutbox(accountId, deviceId);
    if (count < MAXIMUM_OUTBOX_EVENTS) return;
    const required = count - MAXIMUM_OUTBOX_EVENTS + 1;
    const passive = this.sqlite
      .prepare(
        `DELETE FROM official_quality_outbox
         WHERE event_id IN (
           SELECT event_id FROM official_quality_outbox
           WHERE account_id = ? AND device_id = ?
             AND purpose = 'official_quality_metrics'
           ORDER BY created_at ASC, event_id ASC
           LIMIT ?
         )`,
      )
      .run(accountId, deviceId, required);
    const passiveRemoved = Number(passive.changes);
    if (passiveRemoved >= required) return;
    if (incomingPurpose === "official_quality_metrics") {
      throw new Error("Official quality outbox is full.");
    }
    this.sqlite
      .prepare(
        `DELETE FROM official_quality_outbox
         WHERE event_id IN (
           SELECT event_id FROM official_quality_outbox
           WHERE account_id = ? AND device_id = ?
           ORDER BY created_at ASC, event_id ASC
           LIMIT ?
         )`,
      )
      .run(accountId, deviceId, required - passiveRemoved);
  }

  private parseOutboxRow(
    row: OutboxRow,
    now: Date,
  ): OfficialQualityOutboxEntry {
    const eventId = identifier(row.event_id, "event ID");
    const qualityPurpose = purpose(row.purpose);
    const attemptCount = Number(row.attempt_count);
    if (
      typeof row.envelope_json !== "string" ||
      !Number.isSafeInteger(attemptCount) ||
      attemptCount < 0 ||
      typeof row.created_at !== "string" ||
      typeof row.expires_at !== "string"
    ) {
      throw new Error("Aera official quality outbox is corrupt.");
    }
    let envelope: OfficialQualityEnvelope;
    try {
      envelope = parseOfficialQualityEnvelope(
        JSON.parse(row.envelope_json),
        now,
      );
    } catch {
      throw new Error("Aera official quality outbox is corrupt.");
    }
    if (
      envelope.event_id !== eventId ||
      (envelope.kind === "metric"
        ? "official_quality_metrics"
        : "official_explicit_feedback") !== qualityPurpose
    ) {
      throw new Error("Aera official quality outbox is corrupt.");
    }
    return {
      eventId,
      purpose: qualityPurpose,
      envelopeJson: serializeOfficialQualityEnvelope(envelope, now),
      attemptCount,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }
}

export function openAgenteraOfficialQualityDatabase(
  userDataPath: string,
  options: OpenAgenteraOfficialQualityDatabaseOptions = {},
): AgenteraOfficialQualityDatabase {
  const paths = resolveAgenteraOfficialQualityPaths(userDataPath);
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
    return new AgenteraOfficialQualityDatabase(paths, sqlite);
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the original initialization error.
    }
    throw error;
  }
}
