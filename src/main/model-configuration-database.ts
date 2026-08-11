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

export const MODEL_CONFIGURATION_SCHEMA_VERSION = 1;

export interface ModelConfigurationSqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface ModelConfigurationSqliteStatement {
  run(...parameters: unknown[]): ModelConfigurationSqliteRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface ModelConfigurationSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): ModelConfigurationSqliteStatement;
  close(): void;
}

export interface ModelConfigurationDatabasePaths {
  rootPath: string;
  databasePath: string;
}

export interface OpenModelConfigurationDatabaseOptions {
  databaseFactory?: (path: string) => ModelConfigurationSqliteDatabase;
}

const localRequire = createRequire(
  typeof __filename === "string"
    ? __filename
    : join(process.cwd(), "package.json"),
);

function defaultDatabaseFactory(
  path: string,
): ModelConfigurationSqliteDatabase {
  const loaded = localRequire("better-sqlite3") as
    | (new (databasePath: string) => ModelConfigurationSqliteDatabase)
    | {
        default: new (databasePath: string) => ModelConfigurationSqliteDatabase;
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
      "Aera model configuration database must remain outside HERMES_HOME.",
    );
  }
}

export function resolveModelConfigurationDatabasePaths(
  userDataPath: string,
): ModelConfigurationDatabasePaths {
  if (typeof userDataPath !== "string" || !isAbsolute(userDataPath)) {
    throw new Error("Electron userData path must be absolute.");
  }
  const rootPath = join(resolve(userDataPath), "model-configuration");
  assertOutsideHermesHome(rootPath);
  return {
    rootPath,
    databasePath: join(rootPath, "model-configuration.db"),
  };
}

function initializeSchema(sqlite: ModelConfigurationSqliteDatabase): void {
  const current = sqlite.prepare("PRAGMA user_version").get() as
    | Record<string, unknown>
    | undefined;
  const currentVersion = current ? Number(Object.values(current)[0]) : 0;
  if (
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > MODEL_CONFIGURATION_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported Aera model configuration database version.");
  }
  if (currentVersion === MODEL_CONFIGURATION_SCHEMA_VERSION) return;

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(`
      CREATE TABLE desktop_model_configuration_operations (
        operation_id TEXT PRIMARY KEY,
        owner_handle TEXT NOT NULL CHECK (length(owner_handle) BETWEEN 1 AND 512),
        profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 64),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'credential', 'provider', 'model_library',
          'native_route', 'activation', 'verification', 'committed',
          'rolled_back', 'recovery_required'
        )),
        stage TEXT NOT NULL CHECK (stage IN (
          'validation', 'credential', 'provider', 'model_library',
          'native_route', 'activation', 'verification', 'rollback', 'recovery'
        )),
        old_route_key TEXT NOT NULL CHECK (length(old_route_key) BETWEEN 1 AND 4096),
        new_route_key TEXT NOT NULL CHECK (length(new_route_key) BETWEEN 1 AND 4096),
        file_manifest_json TEXT NOT NULL CHECK (length(file_manifest_json) BETWEEN 2 AND 8192),
        before_digest_json TEXT NOT NULL CHECK (length(before_digest_json) BETWEEN 2 AND 8192),
        after_digest_json TEXT NOT NULL CHECK (length(after_digest_json) BETWEEN 2 AND 8192),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX desktop_model_configuration_operations_recovery_idx
        ON desktop_model_configuration_operations (state, updated_at);
      PRAGMA user_version = ${MODEL_CONFIGURATION_SCHEMA_VERSION};
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

export class ModelConfigurationDatabase {
  readonly paths: ModelConfigurationDatabasePaths;
  readonly databasePath: string;
  readonly sqlite: ModelConfigurationSqliteDatabase;
  private closed = false;

  constructor(
    paths: ModelConfigurationDatabasePaths,
    sqlite: ModelConfigurationSqliteDatabase,
  ) {
    this.paths = paths;
    this.databasePath = paths.databasePath;
    this.sqlite = sqlite;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }
}

export function openModelConfigurationDatabase(
  userDataPath: string,
  options: OpenModelConfigurationDatabaseOptions = {},
): ModelConfigurationDatabase {
  const paths = resolveModelConfigurationDatabasePaths(userDataPath);
  mkdirSync(paths.rootPath, { recursive: true, mode: 0o700 });
  chmodSync(paths.rootPath, 0o700);
  assertOutsideHermesHome(realpathSync.native(paths.rootPath));
  const sqlite = (options.databaseFactory ?? defaultDatabaseFactory)(
    paths.databasePath,
  );
  try {
    sqlite.exec("PRAGMA journal_mode=WAL");
    sqlite.exec("PRAGMA synchronous=FULL");
    sqlite.exec("PRAGMA foreign_keys=ON");
    sqlite.exec("PRAGMA busy_timeout=5000");
    initializeSchema(sqlite);
    if (existsSync(paths.databasePath)) chmodSync(paths.databasePath, 0o600);
    return new ModelConfigurationDatabase(paths, sqlite);
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the original initialization error.
    }
    throw error;
  }
}
