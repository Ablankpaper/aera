import { randomUUID as systemRandomUUID } from "node:crypto";
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
import type {
  OrganizationDepartment,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationSummary,
} from "../../shared/agentera-organization";
import {
  AgenteraOrganizationPolicyVerificationError,
  canonicalizeOrganizationPolicyDocument,
  type VerifiedOrganizationPolicySnapshot,
} from "./policy-verifier";

export const AGENTERA_ORGANIZATION_SCHEMA_VERSION = 1;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,7}$/;
const MAX_CACHE_ITEMS = 4096;
const MAX_POLICY_HISTORY = 128;
const MAX_CACHE_JSON_BYTES = 256 * 1024;

export interface AgenteraOrganizationSqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface AgenteraOrganizationSqliteStatement {
  run(...parameters: unknown[]): AgenteraOrganizationSqliteRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface AgenteraOrganizationSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): AgenteraOrganizationSqliteStatement;
  close(): void;
}

export interface AgenteraOrganizationPaths {
  rootPath: string;
  databasePath: string;
}

export interface OpenAgenteraOrganizationDatabaseOptions {
  databaseFactory?: (path: string) => AgenteraOrganizationSqliteDatabase;
  randomUUID?: () => string;
}

export interface CachedOrganizations {
  organizations: readonly OrganizationSummary[];
  refreshedAt: string | null;
}

export interface CachedOrganizationMembers {
  members: readonly OrganizationMember[];
  refreshedAt: string | null;
}

export interface CachedOrganizationDepartments {
  departments: readonly OrganizationDepartment[];
  refreshedAt: string | null;
}

export interface CachedOrganizationInvitations {
  invitations: readonly OrganizationInvitation[];
  refreshedAt: string | null;
}

export interface CachedOrganizationPolicy {
  policy: VerifiedOrganizationPolicySnapshot;
  verifiedAt: string;
  current: boolean;
}

export interface CurrentCachedOrganizationPolicy {
  policy: VerifiedOrganizationPolicySnapshot | null;
  verifiedAt: string | null;
}

export interface OrganizationMutationIntentInput {
  operation: string;
  resourceId: string;
  requestDigest: string;
  createdAt: string;
}

export interface OrganizationMutationIntent extends OrganizationMutationIntentInput {
  idempotencyKey: string;
}

interface CachedJSONRow {
  entity_id: unknown;
  json: unknown;
  refreshed_at: unknown;
}

interface CachedPolicyRow {
  snapshot_id: unknown;
  policy_version: unknown;
  json: unknown;
  verified_at: unknown;
  current: unknown;
}

interface MutationIntentRow {
  operation: unknown;
  resource_id: unknown;
  idempotency_key: unknown;
  request_digest: unknown;
  created_at: unknown;
}

const localRequire = createRequire(
  typeof __filename === "string"
    ? __filename
    : join(process.cwd(), "package.json"),
);

function defaultDatabaseFactory(
  path: string,
): AgenteraOrganizationSqliteDatabase {
  const loaded = localRequire("better-sqlite3") as
    | (new (databasePath: string) => AgenteraOrganizationSqliteDatabase)
    | {
        default: new (
          databasePath: string,
        ) => AgenteraOrganizationSqliteDatabase;
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
      "AgentEra Organization path must remain outside HERMES_HOME.",
    );
  }
}

export function resolveAgenteraOrganizationPaths(
  userDataPath: string,
): AgenteraOrganizationPaths {
  if (typeof userDataPath !== "string" || !isAbsolute(userDataPath)) {
    throw new Error("Electron userData path must be absolute.");
  }
  const rootPath = join(resolve(userDataPath), "agentera-organization");
  assertOutsideHermesHome(rootPath);
  return {
    rootPath,
    databasePath: join(rootPath, "organization.db"),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function requireExactFields(
  value: unknown,
  expected: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`Invalid ${label} cache value.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index])
  ) {
    throw new Error(`Invalid ${label} cache fields.`);
  }
  return value;
}

function requireUUID(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function requireTimestamp(value: unknown, label: string): string {
  if (!isTimestamp(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Invalid ${label}.`);
  }
  return Number(value);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid ${label}.`);
  }
  return Number(value);
}

function requireSafeText(
  value: unknown,
  maximum: number,
  label: string,
  exactForm = false,
): string {
  const hasControlCharacter =
    typeof value === "string" &&
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    });
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    hasControlCharacter ||
    (exactForm && (value.trim() !== value || value.normalize("NFC") !== value))
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function normalizeOrganizationSummary(value: unknown): OrganizationSummary {
  const object = requireExactFields(
    value,
    [
      "id",
      "displayName",
      "status",
      "revision",
      "role",
      "memberCount",
      "departmentCount",
      "currentPolicyVersion",
      "currentPolicyDigest",
      "mutationState",
      "createdAt",
      "updatedAt",
      "archivedAt",
    ],
    "Organization summary",
  );
  const id = requireUUID(object.id, "Organization ID");
  const displayName = requireSafeText(
    object.displayName,
    120,
    "Organization display name",
    true,
  );
  if (
    !(["active", "archived", "dissolved"] as const).includes(
      object.status as never,
    )
  ) {
    throw new Error("Invalid Organization status.");
  }
  if (
    !(["owner", "admin", "auditor", "member"] as const).includes(
      object.role as never,
    )
  ) {
    throw new Error("Invalid Organization role.");
  }
  if (
    !(["writable", "archived", "dissolved"] as const).includes(
      object.mutationState as never,
    )
  ) {
    throw new Error("Invalid Organization mutation state.");
  }
  const status = object.status as OrganizationSummary["status"];
  const mutationState =
    object.mutationState as OrganizationSummary["mutationState"];
  if (
    (status === "active" && mutationState !== "writable") ||
    (status !== "active" && mutationState !== status)
  ) {
    throw new Error("Invalid Organization lifecycle cache value.");
  }
  const createdAt = requireTimestamp(
    object.createdAt,
    "Organization creation time",
  );
  const updatedAt = requireTimestamp(
    object.updatedAt,
    "Organization update time",
  );
  if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) {
    throw new Error("Invalid Organization update time.");
  }
  let archivedAt: string | null;
  if (status === "active") {
    if (object.archivedAt !== null) {
      throw new Error("Invalid Organization archive time.");
    }
    archivedAt = null;
  } else {
    archivedAt = requireTimestamp(
      object.archivedAt,
      "Organization archive time",
    );
    if (new Date(archivedAt).getTime() < new Date(createdAt).getTime()) {
      throw new Error("Invalid Organization archive time.");
    }
  }
  if (
    typeof object.currentPolicyDigest !== "string" ||
    !DIGEST_PATTERN.test(object.currentPolicyDigest)
  ) {
    throw new Error("Invalid Organization policy digest.");
  }
  return {
    id,
    displayName,
    status,
    revision: requirePositiveInteger(object.revision, "Organization revision"),
    role: object.role as OrganizationSummary["role"],
    memberCount: requireNonNegativeInteger(
      object.memberCount,
      "Organization member count",
    ),
    departmentCount: requireNonNegativeInteger(
      object.departmentCount,
      "Organization department count",
    ),
    currentPolicyVersion: requirePositiveInteger(
      object.currentPolicyVersion,
      "Organization policy version",
    ),
    currentPolicyDigest: object.currentPolicyDigest,
    mutationState,
    createdAt,
    updatedAt,
    archivedAt,
  };
}

function normalizeOrganizationMember(value: unknown): OrganizationMember {
  const object = requireExactFields(
    value,
    [
      "userId",
      "nickname",
      "role",
      "departmentId",
      "revision",
      "joinedAt",
      "updatedAt",
    ],
    "Organization member",
  );
  if (
    !(["owner", "admin", "auditor", "member"] as const).includes(
      object.role as never,
    )
  ) {
    throw new Error("Invalid Organization member role.");
  }
  const joinedAt = requireTimestamp(
    object.joinedAt,
    "Organization member join time",
  );
  const updatedAt = requireTimestamp(
    object.updatedAt,
    "Organization member update time",
  );
  if (new Date(updatedAt).getTime() < new Date(joinedAt).getTime()) {
    throw new Error("Invalid Organization member update time.");
  }
  return {
    userId: requireUUID(object.userId, "Organization member user ID"),
    nickname:
      object.nickname === null
        ? null
        : requireSafeText(object.nickname, 80, "Organization member nickname"),
    role: object.role as OrganizationMember["role"],
    departmentId:
      object.departmentId === null
        ? null
        : requireUUID(object.departmentId, "Organization member department ID"),
    revision: requirePositiveInteger(
      object.revision,
      "Organization member revision",
    ),
    joinedAt,
    updatedAt,
  };
}

function normalizeOrganizationDepartment(
  value: unknown,
): OrganizationDepartment {
  const object = requireExactFields(
    value,
    [
      "id",
      "displayName",
      "status",
      "memberCount",
      "revision",
      "createdAt",
      "updatedAt",
      "archivedAt",
    ],
    "Organization department",
  );
  if (!(["active", "archived"] as const).includes(object.status as never)) {
    throw new Error("Invalid Organization department status.");
  }
  const status = object.status as OrganizationDepartment["status"];
  const memberCount = requireNonNegativeInteger(
    object.memberCount,
    "Organization department member count",
  );
  const createdAt = requireTimestamp(
    object.createdAt,
    "Organization department creation time",
  );
  const updatedAt = requireTimestamp(
    object.updatedAt,
    "Organization department update time",
  );
  if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) {
    throw new Error("Invalid Organization department update time.");
  }
  let archivedAt: string | null;
  if (status === "active") {
    if (object.archivedAt !== null) {
      throw new Error("Invalid Organization department archive time.");
    }
    archivedAt = null;
  } else {
    archivedAt = requireTimestamp(
      object.archivedAt,
      "Organization department archive time",
    );
    if (memberCount !== 0) {
      throw new Error("Invalid archived Organization department.");
    }
  }
  return {
    id: requireUUID(object.id, "Organization department ID"),
    displayName: requireSafeText(
      object.displayName,
      80,
      "Organization department display name",
      true,
    ),
    status,
    memberCount,
    revision: requirePositiveInteger(
      object.revision,
      "Organization department revision",
    ),
    createdAt,
    updatedAt,
    archivedAt,
  };
}

function normalizeOrganizationInvitation(
  value: unknown,
): OrganizationInvitation {
  const object = requireExactFields(
    value,
    [
      "id",
      "status",
      "createdByUserId",
      "acceptedByUserId",
      "createdAt",
      "expiresAt",
      "acceptedAt",
      "revokedAt",
    ],
    "Organization invitation",
  );
  if (
    !(["pending", "accepted", "revoked", "expired"] as const).includes(
      object.status as never,
    )
  ) {
    throw new Error("Invalid Organization invitation status.");
  }
  const status = object.status as OrganizationInvitation["status"];
  const createdAt = requireTimestamp(
    object.createdAt,
    "Organization invitation creation time",
  );
  const expiresAt = requireTimestamp(
    object.expiresAt,
    "Organization invitation expiry time",
  );
  if (new Date(expiresAt).getTime() <= new Date(createdAt).getTime()) {
    throw new Error("Invalid Organization invitation expiry time.");
  }
  const acceptedAt =
    object.acceptedAt === null
      ? null
      : requireTimestamp(
          object.acceptedAt,
          "Organization invitation acceptance time",
        );
  const revokedAt =
    object.revokedAt === null
      ? null
      : requireTimestamp(
          object.revokedAt,
          "Organization invitation revocation time",
        );
  if (
    (status === "accepted" &&
      (acceptedAt === null ||
        revokedAt !== null ||
        new Date(acceptedAt).getTime() < new Date(createdAt).getTime() ||
        new Date(acceptedAt).getTime() > new Date(expiresAt).getTime())) ||
    (status === "revoked" &&
      (acceptedAt !== null ||
        revokedAt === null ||
        new Date(revokedAt).getTime() < new Date(createdAt).getTime())) ||
    ((status === "pending" || status === "expired") &&
      (acceptedAt !== null || revokedAt !== null))
  ) {
    throw new Error("Invalid Organization invitation lifecycle.");
  }
  return {
    id: requireUUID(object.id, "Organization invitation ID"),
    status,
    createdByUserId:
      object.createdByUserId === null
        ? null
        : requireUUID(
            object.createdByUserId,
            "Organization invitation creator ID",
          ),
    acceptedByUserId:
      object.acceptedByUserId === null
        ? null
        : requireUUID(
            object.acceptedByUserId,
            "Organization invitation accepter ID",
          ),
    createdAt,
    expiresAt,
    acceptedAt,
    revokedAt,
  };
}

function isCanonicalBase64URL(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || !SIGNATURE_PATTERN.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return (
      decoded.byteLength === bytes && decoded.toString("base64url") === value
    );
  } catch {
    return false;
  }
}

function normalizeVerifiedPolicy(
  value: unknown,
): VerifiedOrganizationPolicySnapshot {
  try {
    const object = requireExactFields(
      value,
      ["organizationId", "snapshot", "canonicalJson", "contentDigest"],
      "verified policy",
    );
    const organizationId = requireUUID(
      object.organizationId,
      "verified policy Organization ID",
    );
    const snapshot = requireExactFields(
      object.snapshot,
      [
        "id",
        "policyVersion",
        "schemaVersion",
        "contentDigest",
        "issuer",
        "signingKeyId",
        "createdAt",
        "document",
        "signature",
      ],
      "verified policy snapshot",
    );
    const snapshotId = requireUUID(snapshot.id, "verified policy snapshot ID");
    const policyVersion = requirePositiveInteger(
      snapshot.policyVersion,
      "verified policy version",
    );
    if (snapshot.schemaVersion !== 1) {
      throw new Error("Invalid verified policy schema.");
    }
    if (
      typeof snapshot.issuer !== "string" ||
      new URL(snapshot.issuer).origin !== snapshot.issuer
    ) {
      throw new Error("Invalid verified policy issuer.");
    }
    const signingKeyId = requireSafeText(
      snapshot.signingKeyId,
      128,
      "verified policy signing key",
    );
    if (!KEY_ID_PATTERN.test(signingKeyId)) {
      throw new Error("Invalid verified policy signing key.");
    }
    const createdAt = requireTimestamp(
      snapshot.createdAt,
      "verified policy creation time",
    );
    if (!isCanonicalBase64URL(snapshot.signature, 64)) {
      throw new Error("Invalid verified policy signature.");
    }
    const canonical = canonicalizeOrganizationPolicyDocument(
      snapshot.document,
      { requireCanonical: true },
    );
    if (
      typeof object.canonicalJson !== "string" ||
      object.canonicalJson !== canonical.canonicalJson ||
      typeof object.contentDigest !== "string" ||
      object.contentDigest !== canonical.contentDigest ||
      typeof snapshot.contentDigest !== "string" ||
      snapshot.contentDigest !== canonical.contentDigest
    ) {
      throw new Error("Invalid verified policy digest.");
    }
    return {
      organizationId,
      snapshot: {
        id: snapshotId,
        policyVersion,
        schemaVersion: 1,
        contentDigest: canonical.contentDigest,
        issuer: snapshot.issuer,
        signingKeyId,
        createdAt,
        document: canonical.document,
        signature: snapshot.signature,
      },
      canonicalJson: canonical.canonicalJson,
      contentDigest: canonical.contentDigest,
    };
  } catch (error) {
    if (
      error instanceof AgenteraOrganizationPolicyVerificationError ||
      error instanceof Error
    ) {
      throw new Error("Invalid verified policy cache value.");
    }
    throw error;
  }
}

function requireDistinct<T>(
  values: readonly T[],
  identity: (value: T) => string,
  label: string,
): void {
  if (values.length > MAX_CACHE_ITEMS) {
    throw new Error(`Too many ${label} cache values.`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    const id = identity(value);
    if (seen.has(id)) throw new Error(`Duplicate ${label} cache value.`);
    seen.add(id);
  }
}

function parseCachedJSON(raw: unknown, label: string): unknown {
  if (typeof raw !== "string") throw new Error(`Invalid ${label} cache JSON.`);
  const size = Buffer.byteLength(raw, "utf8");
  if (size === 0 || size > MAX_CACHE_JSON_BYTES) {
    throw new Error(`Invalid ${label} cache JSON.`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid ${label} cache JSON.`);
  }
}

function consistentRefreshedAt(
  rows: readonly CachedJSONRow[],
  label: string,
): string | null {
  if (rows.length === 0) return null;
  const first = requireTimestamp(rows[0].refreshed_at, `${label} refresh time`);
  for (const row of rows.slice(1)) {
    if (requireTimestamp(row.refreshed_at, `${label} refresh time`) !== first) {
      throw new Error(`Inconsistent ${label} cache refresh time.`);
    }
  }
  return first;
}

function initializeSchema(sqlite: AgenteraOrganizationSqliteDatabase): void {
  const current = sqlite.prepare("PRAGMA user_version").get() as
    | Record<string, unknown>
    | undefined;
  const currentVersion = current ? Number(Object.values(current)[0]) : 0;
  if (
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > AGENTERA_ORGANIZATION_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported AgentEra Organization database version.");
  }
  if (currentVersion === AGENTERA_ORGANIZATION_SCHEMA_VERSION) return;

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(`
      CREATE TABLE organization_summaries (
        account_user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        json TEXT NOT NULL,
        refreshed_at TEXT NOT NULL,
        PRIMARY KEY (account_user_id, organization_id)
      );

      CREATE TABLE organization_members (
        account_user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        json TEXT NOT NULL,
        refreshed_at TEXT NOT NULL,
        PRIMARY KEY (account_user_id, organization_id, user_id),
        FOREIGN KEY (account_user_id, organization_id)
          REFERENCES organization_summaries(account_user_id, organization_id)
          ON DELETE CASCADE
      );

      CREATE TABLE organization_departments (
        account_user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        department_id TEXT NOT NULL,
        json TEXT NOT NULL,
        refreshed_at TEXT NOT NULL,
        PRIMARY KEY (account_user_id, organization_id, department_id),
        FOREIGN KEY (account_user_id, organization_id)
          REFERENCES organization_summaries(account_user_id, organization_id)
          ON DELETE CASCADE
      );

      CREATE TABLE organization_invitations (
        account_user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        invitation_id TEXT NOT NULL,
        json TEXT NOT NULL,
        refreshed_at TEXT NOT NULL,
        PRIMARY KEY (account_user_id, organization_id, invitation_id),
        FOREIGN KEY (account_user_id, organization_id)
          REFERENCES organization_summaries(account_user_id, organization_id)
          ON DELETE CASCADE
      );

      CREATE TABLE organization_policies (
        account_user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
        json TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        current INTEGER NOT NULL CHECK (current IN (0, 1)),
        PRIMARY KEY (account_user_id, organization_id, snapshot_id),
        UNIQUE (account_user_id, organization_id, policy_version),
        FOREIGN KEY (account_user_id, organization_id)
          REFERENCES organization_summaries(account_user_id, organization_id)
          ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX organization_policies_one_current
        ON organization_policies(account_user_id, organization_id)
        WHERE current = 1;

      CREATE TABLE organization_mutation_intents (
        account_user_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_user_id, operation, resource_id),
        UNIQUE (account_user_id, idempotency_key)
      );

      PRAGMA user_version = ${AGENTERA_ORGANIZATION_SCHEMA_VERSION};
    `);
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

export class AgenteraOrganizationDatabase {
  readonly paths: AgenteraOrganizationPaths;
  readonly databasePath: string;
  readonly sqlite: AgenteraOrganizationSqliteDatabase;
  private readonly randomUUID: () => string;
  private closed = false;

  constructor(
    paths: AgenteraOrganizationPaths,
    sqlite: AgenteraOrganizationSqliteDatabase,
    randomUUID: () => string = systemRandomUUID,
  ) {
    this.paths = paths;
    this.databasePath = paths.databasePath;
    this.sqlite = sqlite;
    this.randomUUID = randomUUID;
  }

  private assertOpen(): void {
    if (this.closed)
      throw new Error("AgentEra Organization database is closed.");
  }

  private transaction<T>(action: () => T): T {
    this.assertOpen();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }

  replaceOrganizations(
    accountUserId: string,
    organizations: readonly OrganizationSummary[],
    refreshedAt: string,
  ): void {
    const account = requireUUID(accountUserId, "account user ID");
    const refreshed = requireTimestamp(
      refreshedAt,
      "Organization refresh time",
    );
    const normalized = organizations.map(normalizeOrganizationSummary);
    requireDistinct(normalized, ({ id }) => id, "Organization");

    this.transaction(() => {
      const insert = this.sqlite.prepare(`
        INSERT INTO organization_summaries (
          account_user_id, organization_id, json, refreshed_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(account_user_id, organization_id) DO UPDATE SET
          json = excluded.json,
          refreshed_at = excluded.refreshed_at
      `);
      const retained = new Set<string>();
      for (const organization of normalized) {
        retained.add(organization.id);
        insert.run(
          account,
          organization.id,
          JSON.stringify(organization),
          refreshed,
        );
      }
      const rows = this.sqlite
        .prepare(
          "SELECT organization_id FROM organization_summaries WHERE account_user_id = ?",
        )
        .all(account) as Array<{ organization_id?: unknown }>;
      const remove = this.sqlite.prepare(
        "DELETE FROM organization_summaries WHERE account_user_id = ? AND organization_id = ?",
      );
      for (const row of rows) {
        const id = requireUUID(row.organization_id, "cached Organization ID");
        if (!retained.has(id)) remove.run(account, id);
      }
    });
  }

  readOrganizations(accountUserId: string): CachedOrganizations {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const rows = this.sqlite
      .prepare(
        `SELECT organization_id AS entity_id, json, refreshed_at
         FROM organization_summaries
         WHERE account_user_id = ?
         ORDER BY organization_id`,
      )
      .all(account) as CachedJSONRow[];
    const organizations = rows.map((row) => {
      const value = normalizeOrganizationSummary(
        parseCachedJSON(row.json, "Organization summary"),
      );
      if (value.id !== row.entity_id) {
        throw new Error("Invalid Organization summary cache identity.");
      }
      return value;
    });
    return {
      organizations,
      refreshedAt: consistentRefreshedAt(rows, "Organization summary"),
    };
  }

  replaceMembers(
    accountUserId: string,
    organizationId: string,
    members: readonly OrganizationMember[],
    refreshedAt: string,
  ): void {
    const account = requireUUID(accountUserId, "account user ID");
    const organization = requireUUID(organizationId, "Organization ID");
    const refreshed = requireTimestamp(
      refreshedAt,
      "Organization member refresh time",
    );
    const normalized = members.map(normalizeOrganizationMember);
    requireDistinct(normalized, ({ userId }) => userId, "Organization member");

    this.transaction(() => {
      this.sqlite
        .prepare(
          "DELETE FROM organization_members WHERE account_user_id = ? AND organization_id = ?",
        )
        .run(account, organization);
      const insert = this.sqlite.prepare(`
        INSERT INTO organization_members (
          account_user_id, organization_id, user_id, json, refreshed_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const value of normalized) {
        insert.run(
          account,
          organization,
          value.userId,
          JSON.stringify(value),
          refreshed,
        );
      }
    });
  }

  readMembers(
    accountUserId: string,
    organizationId: string,
  ): CachedOrganizationMembers {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const organization = requireUUID(organizationId, "Organization ID");
    const rows = this.sqlite
      .prepare(
        `SELECT user_id AS entity_id, json, refreshed_at
         FROM organization_members
         WHERE account_user_id = ? AND organization_id = ?
         ORDER BY user_id`,
      )
      .all(account, organization) as CachedJSONRow[];
    const members = rows.map((row) => {
      const value = normalizeOrganizationMember(
        parseCachedJSON(row.json, "Organization member"),
      );
      if (value.userId !== row.entity_id) {
        throw new Error("Invalid Organization member cache identity.");
      }
      return value;
    });
    return {
      members,
      refreshedAt: consistentRefreshedAt(rows, "Organization member"),
    };
  }

  replaceDepartments(
    accountUserId: string,
    organizationId: string,
    departments: readonly OrganizationDepartment[],
    refreshedAt: string,
  ): void {
    const account = requireUUID(accountUserId, "account user ID");
    const organization = requireUUID(organizationId, "Organization ID");
    const refreshed = requireTimestamp(
      refreshedAt,
      "Organization department refresh time",
    );
    const normalized = departments.map(normalizeOrganizationDepartment);
    requireDistinct(normalized, ({ id }) => id, "Organization department");

    this.transaction(() => {
      this.sqlite
        .prepare(
          "DELETE FROM organization_departments WHERE account_user_id = ? AND organization_id = ?",
        )
        .run(account, organization);
      const insert = this.sqlite.prepare(`
        INSERT INTO organization_departments (
          account_user_id, organization_id, department_id, json, refreshed_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const value of normalized) {
        insert.run(
          account,
          organization,
          value.id,
          JSON.stringify(value),
          refreshed,
        );
      }
    });
  }

  readDepartments(
    accountUserId: string,
    organizationId: string,
  ): CachedOrganizationDepartments {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const organization = requireUUID(organizationId, "Organization ID");
    const rows = this.sqlite
      .prepare(
        `SELECT department_id AS entity_id, json, refreshed_at
         FROM organization_departments
         WHERE account_user_id = ? AND organization_id = ?
         ORDER BY department_id`,
      )
      .all(account, organization) as CachedJSONRow[];
    const departments = rows.map((row) => {
      const value = normalizeOrganizationDepartment(
        parseCachedJSON(row.json, "Organization department"),
      );
      if (value.id !== row.entity_id) {
        throw new Error("Invalid Organization department cache identity.");
      }
      return value;
    });
    return {
      departments,
      refreshedAt: consistentRefreshedAt(rows, "Organization department"),
    };
  }

  replaceInvitations(
    accountUserId: string,
    organizationId: string,
    invitations: readonly OrganizationInvitation[],
    refreshedAt: string,
  ): void {
    const account = requireUUID(accountUserId, "account user ID");
    const organization = requireUUID(organizationId, "Organization ID");
    const refreshed = requireTimestamp(
      refreshedAt,
      "Organization invitation refresh time",
    );
    const normalized = invitations.map(normalizeOrganizationInvitation);
    requireDistinct(normalized, ({ id }) => id, "Organization invitation");

    this.transaction(() => {
      this.sqlite
        .prepare(
          "DELETE FROM organization_invitations WHERE account_user_id = ? AND organization_id = ?",
        )
        .run(account, organization);
      const insert = this.sqlite.prepare(`
        INSERT INTO organization_invitations (
          account_user_id, organization_id, invitation_id, json, refreshed_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const value of normalized) {
        insert.run(
          account,
          organization,
          value.id,
          JSON.stringify(value),
          refreshed,
        );
      }
    });
  }

  readInvitations(
    accountUserId: string,
    organizationId: string,
  ): CachedOrganizationInvitations {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const organization = requireUUID(organizationId, "Organization ID");
    const rows = this.sqlite
      .prepare(
        `SELECT invitation_id AS entity_id, json, refreshed_at
         FROM organization_invitations
         WHERE account_user_id = ? AND organization_id = ?
         ORDER BY invitation_id`,
      )
      .all(account, organization) as CachedJSONRow[];
    const invitations = rows.map((row) => {
      const value = normalizeOrganizationInvitation(
        parseCachedJSON(row.json, "Organization invitation"),
      );
      if (value.id !== row.entity_id) {
        throw new Error("Invalid Organization invitation cache identity.");
      }
      return value;
    });
    return {
      invitations,
      refreshedAt: consistentRefreshedAt(rows, "Organization invitation"),
    };
  }

  writeVerifiedPolicy(
    accountUserId: string,
    policy: VerifiedOrganizationPolicySnapshot,
    verifiedAt: string,
  ): void {
    const account = requireUUID(accountUserId, "account user ID");
    const normalized = normalizeVerifiedPolicy(policy);
    const verified = requireTimestamp(
      verifiedAt,
      "Organization policy verification time",
    );
    this.transaction(() => {
      const current = this.sqlite
        .prepare(
          `SELECT snapshot_id, policy_version
           FROM organization_policies
           WHERE account_user_id = ? AND organization_id = ? AND current = 1`,
        )
        .get(account, normalized.organizationId) as
        | { snapshot_id?: unknown; policy_version?: unknown }
        | undefined;
      if (current) {
        const currentSnapshotId = requireUUID(
          current.snapshot_id,
          "current cached policy snapshot ID",
        );
        const currentVersion = requirePositiveInteger(
          current.policy_version,
          "current cached policy version",
        );
        if (
          normalized.snapshot.policyVersion < currentVersion ||
          (normalized.snapshot.policyVersion === currentVersion &&
            normalized.snapshot.id !== currentSnapshotId)
        ) {
          throw new Error("AgentEra Organization verified policy is stale.");
        }
      }
      this.sqlite
        .prepare(
          `UPDATE organization_policies SET current = 0
           WHERE account_user_id = ? AND organization_id = ?`,
        )
        .run(account, normalized.organizationId);
      this.sqlite
        .prepare(
          `INSERT INTO organization_policies (
             account_user_id, organization_id, snapshot_id, policy_version,
             json, verified_at, current
           ) VALUES (?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(account_user_id, organization_id, snapshot_id) DO UPDATE SET
             policy_version = excluded.policy_version,
             json = excluded.json,
             verified_at = excluded.verified_at,
             current = 1`,
        )
        .run(
          account,
          normalized.organizationId,
          normalized.snapshot.id,
          normalized.snapshot.policyVersion,
          JSON.stringify(normalized),
          verified,
        );

      const stale = this.sqlite
        .prepare(
          `SELECT snapshot_id
           FROM organization_policies
           WHERE account_user_id = ? AND organization_id = ? AND current = 0
           ORDER BY policy_version DESC, snapshot_id DESC
           LIMIT -1 OFFSET ?`,
        )
        .all(
          account,
          normalized.organizationId,
          MAX_POLICY_HISTORY - 1,
        ) as Array<{ snapshot_id?: unknown }>;
      const remove = this.sqlite.prepare(
        `DELETE FROM organization_policies
         WHERE account_user_id = ? AND organization_id = ? AND snapshot_id = ? AND current = 0`,
      );
      for (const row of stale) {
        remove.run(
          account,
          normalized.organizationId,
          requireUUID(row.snapshot_id, "cached policy snapshot ID"),
        );
      }
    });
  }

  readPolicies(
    accountUserId: string,
    organizationId: string,
  ): readonly CachedOrganizationPolicy[] {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const organization = requireUUID(organizationId, "Organization ID");
    const rows = this.sqlite
      .prepare(
        `SELECT snapshot_id, policy_version, json, verified_at, current
         FROM organization_policies
         WHERE account_user_id = ? AND organization_id = ?
         ORDER BY policy_version, snapshot_id`,
      )
      .all(account, organization) as CachedPolicyRow[];
    let currentCount = 0;
    return rows.map((row) => {
      const policy = normalizeVerifiedPolicy(
        parseCachedJSON(row.json, "verified policy"),
      );
      if (
        policy.organizationId !== organization ||
        policy.snapshot.id !== row.snapshot_id ||
        policy.snapshot.policyVersion !== row.policy_version
      ) {
        throw new Error("Invalid verified policy cache identity.");
      }
      if (row.current !== 0 && row.current !== 1) {
        throw new Error("Invalid verified policy current marker.");
      }
      const current = row.current === 1;
      if (current) currentCount += 1;
      if (currentCount > 1) {
        throw new Error("Invalid verified policy current state.");
      }
      return {
        policy,
        verifiedAt: requireTimestamp(
          row.verified_at,
          "cached policy verification time",
        ),
        current,
      };
    });
  }

  readCurrentPolicy(
    accountUserId: string,
    organizationId: string,
  ): CurrentCachedOrganizationPolicy {
    const policies = this.readPolicies(accountUserId, organizationId);
    const current = policies.find((candidate) => candidate.current);
    return current
      ? { policy: current.policy, verifiedAt: current.verifiedAt }
      : { policy: null, verifiedAt: null };
  }

  acquireMutationIntent(
    accountUserId: string,
    input: OrganizationMutationIntentInput,
  ): OrganizationMutationIntent {
    const account = requireUUID(accountUserId, "account user ID");
    const operation = requireSafeText(
      input.operation,
      128,
      "Organization mutation operation",
    );
    if (!OPERATION_PATTERN.test(operation)) {
      throw new Error("Invalid Organization mutation operation.");
    }
    const resourceId = requireUUID(
      input.resourceId,
      "Organization mutation resource ID",
    );
    if (!DIGEST_PATTERN.test(input.requestDigest)) {
      throw new Error("Invalid Organization mutation request digest.");
    }
    const createdAt = requireTimestamp(
      input.createdAt,
      "Organization mutation creation time",
    );
    return this.transaction(() => {
      const existing = this.readMutationIntent(account, operation, resourceId);
      if (existing) {
        if (existing.requestDigest !== input.requestDigest) {
          throw new Error(
            "AgentEra Organization has a conflicting mutation intent.",
          );
        }
        return existing;
      }
      const idempotencyKey = this.randomUUID();
      if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
        throw new Error("Invalid Organization mutation idempotency key.");
      }
      this.sqlite
        .prepare(
          `INSERT INTO organization_mutation_intents (
             account_user_id, operation, resource_id, idempotency_key,
             request_digest, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          account,
          operation,
          resourceId,
          idempotencyKey,
          input.requestDigest,
          createdAt,
        );
      return {
        operation,
        resourceId,
        idempotencyKey,
        requestDigest: input.requestDigest,
        createdAt,
      };
    });
  }

  readMutationIntent(
    accountUserId: string,
    operationInput: string,
    resourceIdInput: string,
  ): OrganizationMutationIntent | null {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const operation = requireSafeText(
      operationInput,
      128,
      "Organization mutation operation",
    );
    if (!OPERATION_PATTERN.test(operation)) {
      throw new Error("Invalid Organization mutation operation.");
    }
    const resourceId = requireUUID(
      resourceIdInput,
      "Organization mutation resource ID",
    );
    const row = this.sqlite
      .prepare(
        `SELECT operation, resource_id, idempotency_key, request_digest, created_at
         FROM organization_mutation_intents
         WHERE account_user_id = ? AND operation = ? AND resource_id = ?`,
      )
      .get(account, operation, resourceId) as MutationIntentRow | undefined;
    if (!row) return null;
    if (
      row.operation !== operation ||
      row.resource_id !== resourceId ||
      typeof row.idempotency_key !== "string" ||
      !IDEMPOTENCY_PATTERN.test(row.idempotency_key) ||
      typeof row.request_digest !== "string" ||
      !DIGEST_PATTERN.test(row.request_digest)
    ) {
      throw new Error("Invalid Organization mutation intent cache value.");
    }
    return {
      operation,
      resourceId,
      idempotencyKey: row.idempotency_key,
      requestDigest: row.request_digest,
      createdAt: requireTimestamp(
        row.created_at,
        "cached Organization mutation creation time",
      ),
    };
  }

  completeMutationIntent(accountUserId: string, idempotencyKey: string): void {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      throw new Error("Invalid Organization mutation idempotency key.");
    }
    this.sqlite
      .prepare(
        "DELETE FROM organization_mutation_intents WHERE account_user_id = ? AND idempotency_key = ?",
      )
      .run(account, idempotencyKey);
  }

  purgeAccount(accountUserId: string): void {
    const account = requireUUID(accountUserId, "account user ID");
    this.transaction(() => {
      for (const table of [
        "organization_members",
        "organization_departments",
        "organization_invitations",
        "organization_policies",
        "organization_summaries",
        "organization_mutation_intents",
      ]) {
        this.sqlite
          .prepare(`DELETE FROM ${table} WHERE account_user_id = ?`)
          .run(account);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }
}

export function openAgenteraOrganizationDatabase(
  userDataPath: string,
  options: OpenAgenteraOrganizationDatabaseOptions = {},
): AgenteraOrganizationDatabase {
  const paths = resolveAgenteraOrganizationPaths(userDataPath);
  mkdirSync(paths.rootPath, { recursive: true, mode: 0o700 });
  chmodSync(paths.rootPath, 0o700);
  assertOutsideHermesHome(realpathSync.native(paths.rootPath));

  const sqlite = (options.databaseFactory ?? defaultDatabaseFactory)(
    paths.databasePath,
  );
  try {
    const canonicalRoot = canonicalPotentialPath(paths.rootPath);
    const canonicalDatabase = canonicalPotentialPath(paths.databasePath);
    assertOutsideHermesHome(canonicalDatabase);
    if (!isPathInside(canonicalRoot, canonicalDatabase)) {
      throw new Error(
        "AgentEra Organization database must remain inside its protected root.",
      );
    }
    if (existsSync(paths.databasePath)) chmodSync(paths.databasePath, 0o600);
    sqlite.exec("PRAGMA journal_mode=WAL");
    sqlite.exec("PRAGMA foreign_keys=ON");
    sqlite.exec("PRAGMA busy_timeout=5000");
    initializeSchema(sqlite);
    if (existsSync(paths.databasePath)) chmodSync(paths.databasePath, 0o600);
    return new AgenteraOrganizationDatabase(paths, sqlite, options.randomUUID);
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the initialization failure.
    }
    throw error;
  }
}
