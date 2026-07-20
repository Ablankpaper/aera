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
import type { StoredProductSpaceSelection } from "../../shared/agentera-product-space";

export const AGENTERA_PRODUCT_SPACE_SCHEMA_VERSION = 1;
export const LEGACY_WORKSPACE_SELECTION_MIGRATION =
  "legacy-workspace-selection-v1";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MIGRATION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_ACTIVE_WORKSPACES = 4096;

export interface AgenteraProductSpaceSqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface AgenteraProductSpaceSqliteStatement {
  run(...parameters: unknown[]): AgenteraProductSpaceSqliteRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface AgenteraProductSpaceSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): AgenteraProductSpaceSqliteStatement;
  close(): void;
}

export interface AgenteraProductSpacePaths {
  rootPath: string;
  databasePath: string;
}

export interface OpenAgenteraProductSpaceDatabaseOptions {
  databaseFactory?: (path: string) => AgenteraProductSpaceSqliteDatabase;
}

export interface LegacyWorkspaceSelectionMigrationInput {
  legacyWorkspaceId: string | null;
  activeWorkspaceIds: readonly string[];
  completedAt: string;
}

interface SelectionRow {
  kind?: unknown;
  scope_id?: unknown;
}

const localRequire = createRequire(
  typeof __filename === "string"
    ? __filename
    : join(process.cwd(), "package.json"),
);

function defaultDatabaseFactory(
  path: string,
): AgenteraProductSpaceSqliteDatabase {
  const loaded = localRequire("better-sqlite3") as
    | (new (databasePath: string) => AgenteraProductSpaceSqliteDatabase)
    | {
        default: new (
          databasePath: string,
        ) => AgenteraProductSpaceSqliteDatabase;
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
      "AgentEra product-space path must remain outside HERMES_HOME.",
    );
  }
}

export function resolveAgenteraProductSpacePaths(
  userDataPath: string,
): AgenteraProductSpacePaths {
  if (typeof userDataPath !== "string" || !isAbsolute(userDataPath)) {
    throw new Error("Electron userData path must be absolute.");
  }
  const rootPath = join(resolve(userDataPath), "agentera-product-space");
  assertOutsideHermesHome(rootPath);
  return { rootPath, databasePath: join(rootPath, "space.db") };
}

function requireUUID(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function normalizeSelection(value: unknown): StoredProductSpaceSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid product-space selection.");
  }
  const object = value as Record<string, unknown>;
  const fields = Object.keys(object).sort();
  if (object.kind === "PERSONAL") {
    if (fields.length !== 1 || fields[0] !== "kind") {
      throw new Error("Invalid Personal selection.");
    }
    return { kind: "PERSONAL" };
  }
  if (object.kind === "WORKSPACE") {
    if (fields.join("\0") !== "kind\0workspaceId") {
      throw new Error("Invalid Workspace selection.");
    }
    return {
      kind: "WORKSPACE",
      workspaceId: requireUUID(object.workspaceId, "Workspace ID"),
    };
  }
  if (object.kind === "ORGANIZATION") {
    if (fields.join("\0") !== "kind\0organizationId") {
      throw new Error("Invalid Organization selection.");
    }
    return {
      kind: "ORGANIZATION",
      organizationId: requireUUID(object.organizationId, "Organization ID"),
    };
  }
  throw new Error("Invalid product-space selection.");
}

function decodeSelection(
  row: SelectionRow | undefined,
): StoredProductSpaceSelection | null {
  if (!row) return null;
  if (row.kind === "PERSONAL" && row.scope_id === null) {
    return { kind: "PERSONAL" };
  }
  if (row.kind === "WORKSPACE") {
    return {
      kind: "WORKSPACE",
      workspaceId: requireUUID(row.scope_id, "cached Workspace ID"),
    };
  }
  if (row.kind === "ORGANIZATION") {
    return {
      kind: "ORGANIZATION",
      organizationId: requireUUID(row.scope_id, "cached Organization ID"),
    };
  }
  throw new Error("Invalid cached product-space selection.");
}

function initializeSchema(sqlite: AgenteraProductSpaceSqliteDatabase): void {
  const current = sqlite.prepare("PRAGMA user_version").get() as
    | Record<string, unknown>
    | undefined;
  const currentVersion = current ? Number(Object.values(current)[0]) : 0;
  if (
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > AGENTERA_PRODUCT_SPACE_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported AgentEra product-space database version.");
  }
  if (currentVersion === AGENTERA_PRODUCT_SPACE_SCHEMA_VERSION) return;
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(`
      CREATE TABLE product_space_selection (
        account_user_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('PERSONAL', 'WORKSPACE', 'ORGANIZATION')),
        scope_id TEXT,
        updated_at TEXT NOT NULL,
        CHECK ((kind = 'PERSONAL' AND scope_id IS NULL)
          OR (kind IN ('WORKSPACE', 'ORGANIZATION') AND scope_id IS NOT NULL))
      );

      CREATE TABLE product_space_migrations (
        account_user_id TEXT NOT NULL,
        migration TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (account_user_id, migration)
      );

      PRAGMA user_version = ${AGENTERA_PRODUCT_SPACE_SCHEMA_VERSION};
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

export class AgenteraProductSpaceDatabase {
  readonly paths: AgenteraProductSpacePaths;
  readonly databasePath: string;
  readonly sqlite: AgenteraProductSpaceSqliteDatabase;
  private closed = false;

  constructor(
    paths: AgenteraProductSpacePaths,
    sqlite: AgenteraProductSpaceSqliteDatabase,
  ) {
    this.paths = paths;
    this.databasePath = paths.databasePath;
    this.sqlite = sqlite;
  }

  private assertOpen(): void {
    if (this.closed)
      throw new Error("AgentEra product-space database is closed.");
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

  readSelection(accountUserId: string): StoredProductSpaceSelection | null {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const row = this.sqlite
      .prepare(
        "SELECT kind, scope_id FROM product_space_selection WHERE account_user_id = ?",
      )
      .get(account) as SelectionRow | undefined;
    return decodeSelection(row);
  }

  writeSelection(
    accountUserId: string,
    selectionInput: StoredProductSpaceSelection,
    updatedAt: string,
  ): void {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    const selection = normalizeSelection(selectionInput);
    const updated = requireTimestamp(updatedAt, "product-space update time");
    const scopeId =
      selection.kind === "PERSONAL"
        ? null
        : selection.kind === "WORKSPACE"
          ? selection.workspaceId
          : selection.organizationId;
    this.sqlite
      .prepare(
        `INSERT INTO product_space_selection (
           account_user_id, kind, scope_id, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_user_id) DO UPDATE SET
           kind = excluded.kind,
           scope_id = excluded.scope_id,
           updated_at = excluded.updated_at`,
      )
      .run(account, selection.kind, scopeId, updated);
  }

  hasMigration(accountUserId: string, migrationInput: string): boolean {
    this.assertOpen();
    const account = requireUUID(accountUserId, "account user ID");
    if (!MIGRATION_PATTERN.test(migrationInput)) {
      throw new Error("Invalid product-space migration.");
    }
    return (
      this.sqlite
        .prepare(
          `SELECT 1 AS present FROM product_space_migrations
           WHERE account_user_id = ? AND migration = ?`,
        )
        .get(account, migrationInput) !== undefined
    );
  }

  migrateLegacyWorkspaceSelection(
    accountUserId: string,
    input: LegacyWorkspaceSelectionMigrationInput,
  ): StoredProductSpaceSelection {
    const account = requireUUID(accountUserId, "account user ID");
    const completedAt = requireTimestamp(
      input.completedAt,
      "product-space migration time",
    );
    const legacy =
      input.legacyWorkspaceId === null
        ? null
        : requireUUID(input.legacyWorkspaceId, "legacy Workspace ID");
    if (
      !Array.isArray(input.activeWorkspaceIds) ||
      input.activeWorkspaceIds.length > MAX_ACTIVE_WORKSPACES
    ) {
      throw new Error("Invalid active Workspace IDs.");
    }
    const active = new Set<string>();
    for (const value of input.activeWorkspaceIds) {
      const id = requireUUID(value, "active Workspace ID");
      if (active.has(id)) throw new Error("Duplicate active Workspace ID.");
      active.add(id);
    }
    return this.transaction(() => {
      const current = this.readSelection(account);
      if (this.hasMigration(account, LEGACY_WORKSPACE_SELECTION_MIGRATION)) {
        return current ?? { kind: "PERSONAL" };
      }
      const selection =
        current ??
        (legacy !== null && active.has(legacy)
          ? ({ kind: "WORKSPACE", workspaceId: legacy } as const)
          : ({ kind: "PERSONAL" } as const));
      if (current === null)
        this.writeSelection(account, selection, completedAt);
      this.sqlite
        .prepare(
          `INSERT INTO product_space_migrations (
             account_user_id, migration, completed_at
           ) VALUES (?, ?, ?)`,
        )
        .run(account, LEGACY_WORKSPACE_SELECTION_MIGRATION, completedAt);
      return selection;
    });
  }

  purgeAccount(accountUserId: string): void {
    const account = requireUUID(accountUserId, "account user ID");
    this.transaction(() => {
      this.sqlite
        .prepare(
          "DELETE FROM product_space_selection WHERE account_user_id = ?",
        )
        .run(account);
      this.sqlite
        .prepare(
          "DELETE FROM product_space_migrations WHERE account_user_id = ?",
        )
        .run(account);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }
}

export function openAgenteraProductSpaceDatabase(
  userDataPath: string,
  options: OpenAgenteraProductSpaceDatabaseOptions = {},
): AgenteraProductSpaceDatabase {
  const paths = resolveAgenteraProductSpacePaths(userDataPath);
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
        "AgentEra product-space database must remain inside its protected root.",
      );
    }
    if (existsSync(paths.databasePath)) chmodSync(paths.databasePath, 0o600);
    sqlite.exec("PRAGMA journal_mode=WAL");
    sqlite.exec("PRAGMA foreign_keys=ON");
    sqlite.exec("PRAGMA busy_timeout=5000");
    initializeSchema(sqlite);
    if (existsSync(paths.databasePath)) chmodSync(paths.databasePath, 0o600);
    return new AgenteraProductSpaceDatabase(paths, sqlite);
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the initialization failure.
    }
    throw error;
  }
}
