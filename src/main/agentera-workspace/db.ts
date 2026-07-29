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
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspaceSummary,
} from "../../shared/agentera-workspace";
import {
  parseWorkspaceInvitation,
  parseWorkspaceMember,
  parseWorkspaceSummary,
} from "./client";

export const AGENTERA_WORKSPACE_SCHEMA_VERSION = 1;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_CACHE_ITEMS = 4096;

export interface AgenteraWorkspaceSqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface AgenteraWorkspaceSqliteStatement {
  run(...parameters: unknown[]): AgenteraWorkspaceSqliteRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface AgenteraWorkspaceSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): AgenteraWorkspaceSqliteStatement;
  close(): void;
}

export interface AgenteraWorkspacePaths {
  rootPath: string;
  databasePath: string;
}

export interface OpenAgenteraWorkspaceDatabaseOptions {
  databaseFactory?: (path: string) => AgenteraWorkspaceSqliteDatabase;
}

export interface CachedWorkspaces {
  workspaces: readonly WorkspaceSummary[];
  refreshedAt: string | null;
}

export interface CachedWorkspaceMembers {
  members: readonly WorkspaceMember[];
  refreshedAt: string | null;
}

export interface CachedWorkspaceInvitations {
  invitations: readonly WorkspaceInvitation[];
  refreshedAt: string | null;
}

interface CachedJSONRow {
  json: unknown;
  refreshed_at: unknown;
  entity_id: unknown;
}

const localRequire = createRequire(
  typeof __filename === "string"
    ? __filename
    : join(process.cwd(), "package.json"),
);

function defaultDatabaseFactory(path: string): AgenteraWorkspaceSqliteDatabase {
  const loaded = localRequire("better-sqlite3") as
    | (new (databasePath: string) => AgenteraWorkspaceSqliteDatabase)
    | {
        default: new (databasePath: string) => AgenteraWorkspaceSqliteDatabase;
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
    throw new Error("Aera Workspace path must remain outside HERMES_HOME.");
  }
}

export function resolveAgenteraWorkspacePaths(
  userDataPath: string,
): AgenteraWorkspacePaths {
  if (typeof userDataPath !== "string" || !isAbsolute(userDataPath)) {
    throw new Error("Electron userData path must be absolute.");
  }
  assertOutsideHermesHome(userDataPath);
  const rootPath = join(resolve(userDataPath), "agentera-workspace");
  assertOutsideHermesHome(rootPath);
  return {
    rootPath,
    databasePath: join(rootPath, "workspace.db"),
  };
}

function isUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function requireUUID(value: unknown, label: string): string {
  if (!isUUID(value)) throw new Error(`Invalid ${label}.`);
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

function normalizeWorkspaceSummary(value: unknown): WorkspaceSummary {
  const object = requireExactFields(
    value,
    [
      "archivedAt",
      "createdAt",
      "displayName",
      "id",
      "memberCount",
      "mutationState",
      "revision",
      "role",
      "status",
      "updatedAt",
    ],
    "Workspace summary",
  );
  return parseWorkspaceSummary({
    id: object.id,
    display_name: object.displayName,
    status: object.status,
    revision: object.revision,
    mutation_state: object.mutationState,
    role: object.role,
    member_count: object.memberCount,
    created_at: object.createdAt,
    updated_at: object.updatedAt,
    ...(object.archivedAt === null ? {} : { archived_at: object.archivedAt }),
  });
}

function normalizeWorkspaceMember(value: unknown): WorkspaceMember {
  const object = requireExactFields(
    value,
    ["joinedAt", "nickname", "revision", "role", "userId"],
    "Workspace member",
  );
  return parseWorkspaceMember({
    user_id: object.userId,
    role: object.role,
    revision: object.revision,
    joined_at: object.joinedAt,
    ...(object.nickname === null ? {} : { nickname: object.nickname }),
  });
}

function normalizeWorkspaceInvitation(value: unknown): WorkspaceInvitation {
  const object = requireExactFields(
    value,
    [
      "acceptedAt",
      "acceptedByUserId",
      "createdAt",
      "createdByUserId",
      "expiresAt",
      "id",
      "revokedAt",
      "status",
    ],
    "Workspace invitation",
  );
  return parseWorkspaceInvitation({
    id: object.id,
    status: object.status,
    created_at: object.createdAt,
    expires_at: object.expiresAt,
    ...(object.createdByUserId === null
      ? {}
      : { created_by_user_id: object.createdByUserId }),
    ...(object.acceptedByUserId === null
      ? {}
      : { accepted_by_user_id: object.acceptedByUserId }),
    ...(object.acceptedAt === null ? {} : { accepted_at: object.acceptedAt }),
    ...(object.revokedAt === null ? {} : { revoked_at: object.revokedAt }),
  });
}

function requireDistinctIDs<T extends { id: string }>(
  values: readonly T[],
  label: string,
): void {
  if (values.length > MAX_CACHE_ITEMS) {
    throw new Error(`Too many ${label} cache values.`);
  }
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`Duplicate ${label} cache value.`);
    ids.add(value.id);
  }
}

function requireDistinctMemberIDs(values: readonly WorkspaceMember[]): void {
  if (values.length > MAX_CACHE_ITEMS) {
    throw new Error("Too many Workspace member cache values.");
  }
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.userId)) {
      throw new Error("Duplicate Workspace member cache value.");
    }
    ids.add(value.userId);
  }
}

function parseCachedJSON(raw: unknown, label: string): unknown {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256 * 1024) {
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

function initializeSchema(sqlite: AgenteraWorkspaceSqliteDatabase): void {
  const current = sqlite.prepare("PRAGMA user_version").get() as
    | Record<string, unknown>
    | undefined;
  const currentVersion = current ? Number(Object.values(current)[0]) : 0;
  if (
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > AGENTERA_WORKSPACE_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported Aera Workspace database version.");
  }
  if (currentVersion === AGENTERA_WORKSPACE_SCHEMA_VERSION) return;

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(`
      CREATE TABLE workspace_cache (
        account_user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        refreshed_at TEXT NOT NULL,
        PRIMARY KEY (account_user_id, workspace_id)
      );

      CREATE TABLE workspace_member_cache (
        account_user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        member_user_id TEXT NOT NULL,
        member_json TEXT NOT NULL,
        refreshed_at TEXT NOT NULL,
        PRIMARY KEY (account_user_id, workspace_id, member_user_id)
      );

      CREATE TABLE workspace_invitation_cache (
        account_user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        invitation_id TEXT NOT NULL,
        invitation_json TEXT NOT NULL,
        refreshed_at TEXT NOT NULL,
        PRIMARY KEY (account_user_id, workspace_id, invitation_id)
      );

      CREATE TABLE workspace_selection (
        account_user_id TEXT PRIMARY KEY,
        selected_workspace_id TEXT,
        updated_at TEXT NOT NULL
      );

      PRAGMA user_version = ${AGENTERA_WORKSPACE_SCHEMA_VERSION};
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

export class AgenteraWorkspaceDatabase {
  readonly databasePath: string;
  readonly paths: AgenteraWorkspacePaths;
  readonly sqlite: AgenteraWorkspaceSqliteDatabase;
  private closed = false;

  constructor(
    paths: AgenteraWorkspacePaths,
    sqlite: AgenteraWorkspaceSqliteDatabase,
  ) {
    this.paths = paths;
    this.databasePath = paths.databasePath;
    this.sqlite = sqlite;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Aera Workspace database is closed.");
  }

  private transaction(action: () => void): void {
    this.assertOpen();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.sqlite.exec("COMMIT");
    } catch (error) {
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }

  replaceWorkspaces(
    accountUserId: string,
    workspaces: readonly WorkspaceSummary[],
    refreshedAt: string,
  ): void {
    const account = requireUUID(accountUserId, "account user ID");
    const refreshed = requireTimestamp(refreshedAt, "Workspace refresh time");
    const normalized = workspaces.map(normalizeWorkspaceSummary);
    requireDistinctIDs(normalized, "Workspace");

    this.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM workspace_cache WHERE account_user_id = ?")
        .run(account);
      const insert = this.sqlite.prepare(`
        INSERT INTO workspace_cache (
          account_user_id, workspace_id, summary_json, refreshed_at
        ) VALUES (?, ?, ?, ?)
      `);
      for (const workspace of normalized) {
        insert.run(account, workspace.id, JSON.stringify(workspace), refreshed);
      }
      this.sqlite
        .prepare(
          `DELETE FROM workspace_member_cache
           WHERE account_user_id = ?
             AND workspace_id NOT IN (
               SELECT workspace_id FROM workspace_cache
               WHERE account_user_id = ?
             )`,
        )
        .run(account, account);
      this.sqlite
        .prepare(
          `DELETE FROM workspace_invitation_cache
           WHERE account_user_id = ?
             AND workspace_id NOT IN (
               SELECT workspace_id FROM workspace_cache
               WHERE account_user_id = ?
             )`,
        )
        .run(account, account);
    });
  }

  readWorkspaces(accountUserId: string): CachedWorkspaces {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const rows = this.sqlite
      .prepare(
        `SELECT workspace_id AS entity_id, summary_json AS json, refreshed_at
         FROM workspace_cache
         WHERE account_user_id = ?
         ORDER BY workspace_id`,
      )
      .all(account) as CachedJSONRow[];
    const workspaces = rows.map((row) => {
      const workspace = normalizeWorkspaceSummary(
        parseCachedJSON(row.json, "Workspace summary"),
      );
      if (workspace.id !== row.entity_id) {
        throw new Error("Invalid Workspace summary cache identity.");
      }
      return workspace;
    });
    return {
      workspaces,
      refreshedAt: consistentRefreshedAt(rows, "Workspace summary"),
    };
  }

  replaceMembers(
    accountUserId: string,
    workspaceId: string,
    members: readonly WorkspaceMember[],
    refreshedAt: string,
  ): void {
    const account = requireUUID(accountUserId, "account user ID");
    const workspace = requireUUID(workspaceId, "Workspace ID");
    const refreshed = requireTimestamp(
      refreshedAt,
      "Workspace member refresh time",
    );
    const normalized = members.map(normalizeWorkspaceMember);
    requireDistinctMemberIDs(normalized);

    this.transaction(() => {
      this.sqlite
        .prepare(
          "DELETE FROM workspace_member_cache WHERE account_user_id = ? AND workspace_id = ?",
        )
        .run(account, workspace);
      const insert = this.sqlite.prepare(`
        INSERT INTO workspace_member_cache (
          account_user_id, workspace_id, member_user_id, member_json, refreshed_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const value of normalized) {
        insert.run(
          account,
          workspace,
          value.userId,
          JSON.stringify(value),
          refreshed,
        );
      }
    });
  }

  readMembers(
    accountUserId: string,
    workspaceId: string,
  ): CachedWorkspaceMembers {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const workspace = requireUUID(workspaceId, "Workspace ID");
    const rows = this.sqlite
      .prepare(
        `SELECT member_user_id AS entity_id, member_json AS json, refreshed_at
         FROM workspace_member_cache
         WHERE account_user_id = ? AND workspace_id = ?
         ORDER BY member_user_id`,
      )
      .all(account, workspace) as CachedJSONRow[];
    const members = rows.map((row) => {
      const value = normalizeWorkspaceMember(
        parseCachedJSON(row.json, "Workspace member"),
      );
      if (value.userId !== row.entity_id) {
        throw new Error("Invalid Workspace member cache identity.");
      }
      return value;
    });
    return {
      members,
      refreshedAt: consistentRefreshedAt(rows, "Workspace member"),
    };
  }

  replaceInvitations(
    accountUserId: string,
    workspaceId: string,
    invitations: readonly WorkspaceInvitation[],
    refreshedAt: string,
  ): void {
    const account = requireUUID(accountUserId, "account user ID");
    const workspace = requireUUID(workspaceId, "Workspace ID");
    const refreshed = requireTimestamp(
      refreshedAt,
      "Workspace invitation refresh time",
    );
    const normalized = invitations.map(normalizeWorkspaceInvitation);
    requireDistinctIDs(normalized, "Workspace invitation");

    this.transaction(() => {
      this.sqlite
        .prepare(
          "DELETE FROM workspace_invitation_cache WHERE account_user_id = ? AND workspace_id = ?",
        )
        .run(account, workspace);
      const insert = this.sqlite.prepare(`
        INSERT INTO workspace_invitation_cache (
          account_user_id, workspace_id, invitation_id, invitation_json, refreshed_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const value of normalized) {
        insert.run(
          account,
          workspace,
          value.id,
          JSON.stringify(value),
          refreshed,
        );
      }
    });
  }

  readInvitations(
    accountUserId: string,
    workspaceId: string,
  ): CachedWorkspaceInvitations {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const workspace = requireUUID(workspaceId, "Workspace ID");
    const rows = this.sqlite
      .prepare(
        `SELECT invitation_id AS entity_id, invitation_json AS json, refreshed_at
         FROM workspace_invitation_cache
         WHERE account_user_id = ? AND workspace_id = ?
         ORDER BY invitation_id`,
      )
      .all(account, workspace) as CachedJSONRow[];
    const invitations = rows.map((row) => {
      const value = normalizeWorkspaceInvitation(
        parseCachedJSON(row.json, "Workspace invitation"),
      );
      if (value.id !== row.entity_id) {
        throw new Error("Invalid Workspace invitation cache identity.");
      }
      return value;
    });
    return {
      invitations,
      refreshedAt: consistentRefreshedAt(rows, "Workspace invitation"),
    };
  }

  writeSelectedWorkspace(
    accountUserId: string,
    workspaceId: string | null,
    updatedAt: string,
  ): void {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const updated = requireTimestamp(updatedAt, "Workspace selection time");
    let selected: string | null = null;
    if (workspaceId !== null) {
      selected = requireUUID(workspaceId, "selected Workspace ID");
      const row = this.sqlite
        .prepare(
          "SELECT summary_json FROM workspace_cache WHERE account_user_id = ? AND workspace_id = ?",
        )
        .get(account, selected) as { summary_json?: unknown } | undefined;
      if (typeof row?.summary_json !== "string") {
        throw new Error("Workspace selection requires an active cache entry.");
      }
      const workspace = normalizeWorkspaceSummary(
        parseCachedJSON(row.summary_json, "Workspace summary"),
      );
      if (workspace.id !== selected || workspace.status !== "active") {
        throw new Error("Workspace selection requires an active cache entry.");
      }
    }
    this.sqlite
      .prepare(
        `INSERT INTO workspace_selection (
           account_user_id, selected_workspace_id, updated_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(account_user_id) DO UPDATE SET
           selected_workspace_id = excluded.selected_workspace_id,
           updated_at = excluded.updated_at`,
      )
      .run(account, selected, updated);
  }

  readSelectedWorkspace(accountUserId: string): string | null {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const row = this.sqlite
      .prepare(
        "SELECT selected_workspace_id FROM workspace_selection WHERE account_user_id = ?",
      )
      .get(account) as { selected_workspace_id?: unknown } | undefined;
    if (row === undefined || row.selected_workspace_id === null) return null;
    return requireUUID(row.selected_workspace_id, "cached Workspace selection");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }
}

export function openAgenteraWorkspaceDatabase(
  userDataPath: string,
  options: OpenAgenteraWorkspaceDatabaseOptions = {},
): AgenteraWorkspaceDatabase {
  const paths = resolveAgenteraWorkspacePaths(userDataPath);
  mkdirSync(paths.rootPath, { recursive: true, mode: 0o700 });
  chmodSync(paths.rootPath, 0o700);
  assertOutsideHermesHome(realpathSync.native(paths.rootPath));

  const sqlite = (options.databaseFactory ?? defaultDatabaseFactory)(
    paths.databasePath,
  );
  try {
    if (existsSync(paths.databasePath)) chmodSync(paths.databasePath, 0o600);
    sqlite.exec("PRAGMA journal_mode=WAL");
    sqlite.exec("PRAGMA foreign_keys=ON");
    sqlite.exec("PRAGMA busy_timeout=5000");
    initializeSchema(sqlite);
    return new AgenteraWorkspaceDatabase(paths, sqlite);
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the initialization failure.
    }
    throw error;
  }
}
