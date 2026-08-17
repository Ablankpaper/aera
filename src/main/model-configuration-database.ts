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
import type { ModelConfigurationStartupFailureCode } from "../shared/model-configuration";

export const MODEL_CONFIGURATION_SCHEMA_VERSION = 1;

export interface ModelConfigurationNativeStartupEvidence {
  status: "loaded" | "failed";
  platform: NodeJS.Platform;
  processArchitecture: string;
  electronAbi: string | null;
  detectedNativeAbi: string | null;
  failureClass: ModelConfigurationStartupFailureCode | null;
}

export class ModelConfigurationRuntimeError extends Error {
  readonly code: ModelConfigurationStartupFailureCode;
  readonly evidence: ModelConfigurationNativeStartupEvidence;

  constructor(
    code: ModelConfigurationStartupFailureCode,
    evidence: ModelConfigurationNativeStartupEvidence,
    options?: { cause?: unknown },
  ) {
    super(
      `Aera model configuration runtime is unavailable (${code}).`,
      options,
    );
    this.name = "ModelConfigurationRuntimeError";
    this.code = code;
    this.evidence = evidence;
  }
}

class UnsupportedModelConfigurationSchemaError extends Error {}

function errorParts(error: unknown): { code: string; message: string } {
  if (typeof error !== "object" || error === null) {
    return { code: "", message: String(error ?? "") };
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : "",
    message: typeof candidate.message === "string" ? candidate.message : "",
  };
}

function nativeModuleVersions(message: string): string[] {
  return [...message.matchAll(/NODE_MODULE_VERSION\s+(\d+)/giu)].map(
    (match) => match[1],
  );
}

export function classifyNativeLoadFailure(
  error: unknown,
): ModelConfigurationStartupFailureCode | null {
  const { code, message } = errorParts(error);
  const versions = nativeModuleVersions(message);
  if (new Set(versions).size >= 2) return "native_module_abi_mismatch";

  const nativeLoad =
    code === "ERR_DLOPEN_FAILED" ||
    /(?:dlopen|\.node(?:\b|['")]))/iu.test(message);
  if (!nativeLoad) return null;
  if (
    /(?:incompatible|wrong) architecture|bad cpu type|not a valid win32 application/iu.test(
      message,
    )
  ) {
    return "native_module_architecture_mismatch";
  }
  if (
    /library not loaded|cannot open shared object file|image not found|specified module could not be found/iu.test(
      message,
    )
  ) {
    return "native_module_dependency_missing";
  }
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    /permission denied|operation not permitted|access is denied/iu.test(message)
  ) {
    return "native_module_load_denied";
  }
  return "native_module_load_failed";
}

function startupEvidence(
  code: ModelConfigurationStartupFailureCode,
  error: unknown,
): ModelConfigurationNativeStartupEvidence {
  const versions = nativeModuleVersions(errorParts(error).message);
  return {
    status: "failed",
    platform: process.platform,
    processArchitecture: process.arch,
    electronAbi: process.versions.modules ?? null,
    detectedNativeAbi: versions[0] ?? null,
    failureClass: code,
  };
}

function runtimeError(
  code: ModelConfigurationStartupFailureCode,
  cause: unknown,
): ModelConfigurationRuntimeError {
  if (cause instanceof ModelConfigurationRuntimeError) return cause;
  return new ModelConfigurationRuntimeError(
    code,
    startupEvidence(code, cause),
    {
      cause,
    },
  );
}

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

function readSchemaVersion(sqlite: ModelConfigurationSqliteDatabase): number {
  const current = sqlite.prepare("PRAGMA user_version").get() as
    | Record<string, unknown>
    | undefined;
  const currentVersion = current ? Number(Object.values(current)[0]) : 0;
  if (
    Number.isSafeInteger(currentVersion) &&
    currentVersion > MODEL_CONFIGURATION_SCHEMA_VERSION
  ) {
    throw new UnsupportedModelConfigurationSchemaError();
  }
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
    throw new Error("Unsupported Aera model configuration database version.");
  }
  return currentVersion;
}

function initializeSchema(
  sqlite: ModelConfigurationSqliteDatabase,
  currentVersion: number,
): void {
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
  let sqlite: ModelConfigurationSqliteDatabase;
  try {
    sqlite = (options.databaseFactory ?? defaultDatabaseFactory)(
      paths.databasePath,
    );
  } catch (error) {
    throw runtimeError(
      classifyNativeLoadFailure(error) ??
        "model_configuration_database_unavailable",
      error,
    );
  }
  try {
    const currentVersion = readSchemaVersion(sqlite);
    sqlite.exec("PRAGMA journal_mode=WAL");
    sqlite.exec("PRAGMA synchronous=FULL");
    sqlite.exec("PRAGMA foreign_keys=ON");
    sqlite.exec("PRAGMA busy_timeout=5000");
    initializeSchema(sqlite, currentVersion);
    if (existsSync(paths.databasePath)) chmodSync(paths.databasePath, 0o600);
    return new ModelConfigurationDatabase(paths, sqlite);
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the original initialization error.
    }
    throw runtimeError(
      error instanceof UnsupportedModelConfigurationSchemaError
        ? "model_configuration_schema_unsupported"
        : "model_configuration_database_unavailable",
      error,
    );
  }
}
