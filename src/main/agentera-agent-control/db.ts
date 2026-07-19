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

export const AGENTERA_CONTROL_PLANE_SCHEMA_VERSION = 1;

export interface AgenteraSqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface AgenteraSqliteStatement {
  run(...parameters: unknown[]): AgenteraSqliteRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface AgenteraSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): AgenteraSqliteStatement;
  close(): void;
}

export interface AgenteraControlPlanePaths {
  rootPath: string;
  databasePath: string;
  draftsPath: string;
  versionsPath: string;
  projectionsPath: string;
}

export interface OpenAgenteraControlPlaneDatabaseOptions {
  databaseFactory?: (path: string) => AgenteraSqliteDatabase;
}

const localRequire = createRequire(
  typeof __filename === "string"
    ? __filename
    : join(process.cwd(), "package.json"),
);

function defaultDatabaseFactory(path: string): AgenteraSqliteDatabase {
  const loaded = localRequire("better-sqlite3") as
    | (new (databasePath: string) => AgenteraSqliteDatabase)
    | { default: new (databasePath: string) => AgenteraSqliteDatabase };
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

function assertOutsideHermesHome(controlPlaneRoot: string): void {
  const hermesHome = process.env.HERMES_HOME;
  if (
    typeof hermesHome === "string" &&
    hermesHome.length > 0 &&
    isPathInside(
      canonicalPotentialPath(hermesHome),
      canonicalPotentialPath(controlPlaneRoot),
    )
  ) {
    throw new Error(
      "AgentEra control-plane path must remain outside HERMES_HOME.",
    );
  }
}

export function resolveAgenteraControlPlanePaths(
  userDataPath: string,
): AgenteraControlPlanePaths {
  if (typeof userDataPath !== "string" || !isAbsolute(userDataPath)) {
    throw new Error("Electron userData path must be absolute.");
  }
  const rootPath = join(resolve(userDataPath), "agentera-control-plane");
  assertOutsideHermesHome(rootPath);
  return {
    rootPath,
    databasePath: join(rootPath, "control-plane.db"),
    draftsPath: join(rootPath, "drafts"),
    versionsPath: join(rootPath, "versions"),
    projectionsPath: join(rootPath, "projections"),
  };
}

function initializeSchema(sqlite: AgenteraSqliteDatabase): void {
  const current = sqlite.prepare("PRAGMA user_version").get() as
    | Record<string, unknown>
    | undefined;
  const currentVersion = current ? Number(Object.values(current)[0]) : 0;
  if (
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > AGENTERA_CONTROL_PLANE_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported AgentEra control-plane database version.");
  }

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_drafts (
        id TEXT PRIMARY KEY,
        source_agent_definition_id TEXT,
        base_agent_version_id TEXT,
        display_name TEXT NOT NULL,
        icon_media_type TEXT,
        icon_data_base64 TEXT,
        manifest_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        publication_attempt_revision INTEGER,
        publication_attempted_at TEXT,
        publication_idempotency_key TEXT,
        publication_error_code TEXT,
        publication_error_summary TEXT,
        published_definition_id TEXT,
        published_version_id TEXT,
        published_revision INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((icon_media_type IS NULL) = (icon_data_base64 IS NULL)),
        CHECK ((publication_attempt_revision IS NULL) = (publication_attempted_at IS NULL)),
        CHECK ((publication_attempt_revision IS NULL) = (publication_idempotency_key IS NULL))
      );

      CREATE TABLE IF NOT EXISTS draft_assets (
        draft_id TEXT NOT NULL REFERENCES agent_drafts(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        kind TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL,
        PRIMARY KEY (draft_id, path)
      );

      CREATE TABLE IF NOT EXISTS cached_agent_versions (
        version_id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        version_number INTEGER NOT NULL CHECK (version_number >= 1),
        content_digest TEXT NOT NULL,
        version_json TEXT NOT NULL,
        policy_snapshot_json TEXT,
        cache_relative_path TEXT NOT NULL,
        verified_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_agent_installations (
        agent_installation_id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        selected_version_id TEXT NOT NULL,
        runtime_profile_id TEXT,
        policy_snapshot_id TEXT,
        status TEXT NOT NULL,
        retry_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_bindings (
        id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL UNIQUE,
        hermes_session_id TEXT UNIQUE,
        binding_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signing_key_cache (
        origin TEXT NOT NULL,
        purpose TEXT NOT NULL,
        key_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (origin, purpose, key_id)
      );

      CREATE TABLE IF NOT EXISTS pending_sanitized_records (
        id TEXT PRIMARY KEY,
        record_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      PRAGMA user_version = ${AGENTERA_CONTROL_PLANE_SCHEMA_VERSION};
    `);
    sqlite.exec("COMMIT");
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

export class AgenteraControlPlaneDatabase {
  readonly databasePath: string;
  readonly paths: AgenteraControlPlanePaths;
  readonly sqlite: AgenteraSqliteDatabase;
  private closed = false;

  constructor(
    paths: AgenteraControlPlanePaths,
    sqlite: AgenteraSqliteDatabase,
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

export function openAgenteraControlPlaneDatabase(
  userDataPath: string,
  options: OpenAgenteraControlPlaneDatabaseOptions = {},
): AgenteraControlPlaneDatabase {
  const paths = resolveAgenteraControlPlanePaths(userDataPath);
  mkdirSync(paths.rootPath, { recursive: true, mode: 0o700 });
  chmodSync(paths.rootPath, 0o700);
  assertOutsideHermesHome(realpathSync.native(paths.rootPath));
  mkdirSync(paths.draftsPath, { recursive: true, mode: 0o700 });
  mkdirSync(paths.versionsPath, { recursive: true, mode: 0o700 });
  mkdirSync(paths.projectionsPath, { recursive: true, mode: 0o700 });

  const sqlite = (options.databaseFactory ?? defaultDatabaseFactory)(
    paths.databasePath,
  );
  try {
    sqlite.exec("PRAGMA journal_mode=WAL");
    sqlite.exec("PRAGMA foreign_keys=ON");
    sqlite.exec("PRAGMA busy_timeout=5000");
    initializeSchema(sqlite);
    return new AgenteraControlPlaneDatabase(paths, sqlite);
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the initialization failure.
    }
    throw error;
  }
}
