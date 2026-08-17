// @vitest-environment node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_CONFIGURATION_SCHEMA_VERSION,
  openModelConfigurationDatabase,
  resolveModelConfigurationDatabasePaths,
  type ModelConfigurationDatabase,
  type ModelConfigurationDatabasePaths,
  type ModelConfigurationNativeStartupEvidence,
  type ModelConfigurationSqliteDatabase,
} from "./model-configuration-database";

const roots: string[] = [];
const databases: ModelConfigurationDatabase[] = [];
const originalHermesHome = process.env.HERMES_HOME;

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), "aera-model-configuration-db-"));
  roots.push(root);
  return join(root, "user-data");
}

function databaseFor(
  userDataPath = temporaryUserData(),
): ModelConfigurationDatabase {
  const database = openModelConfigurationDatabase(userDataPath, {
    databaseFactory: (path) =>
      new DatabaseSync(path) as unknown as ModelConfigurationSqliteDatabase,
  });
  databases.push(database);
  return database;
}

function captureDatabaseOpenFailure(
  error: unknown,
  nativeStartupEvidenceSink?: (
    evidence: ModelConfigurationNativeStartupEvidence,
  ) => void,
): unknown {
  try {
    openModelConfigurationDatabase(temporaryUserData(), {
      databaseFactory: () => {
        throw error;
      },
      nativeStartupEvidenceSink,
    });
  } catch (thrown) {
    return thrown;
  }
  throw new Error("Expected model configuration database startup to fail.");
}

interface DatabaseFileSnapshot {
  bytes: Buffer;
  sha256: string;
  journalMode: string;
  directoryEntries: string[];
  stat: {
    dev: number;
    ino: number;
    mode: number;
    nlink: number;
    uid: number;
    gid: number;
    size: number;
    blocks: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
  };
}

function readJournalMode(databasePath: string): string {
  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = inspection.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: unknown }
      | undefined;
    if (typeof row?.journal_mode !== "string") {
      throw new Error("SQLite journal mode is unavailable.");
    }
    return row.journal_mode;
  } finally {
    inspection.close();
  }
}

function snapshotDatabase(
  paths: ModelConfigurationDatabasePaths,
): DatabaseFileSnapshot {
  const journalMode = readJournalMode(paths.databasePath);
  const bytes = readFileSync(paths.databasePath);
  const stat = statSync(paths.databasePath);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    journalMode,
    directoryEntries: readdirSync(paths.rootPath).sort(),
    stat: {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
      size: stat.size,
      blocks: stat.blocks,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      birthtimeMs: stat.birthtimeMs,
    },
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = originalHermesHome;
});

describe("ModelConfigurationDatabase", () => {
  const privateUserPath = ["", "Users", "private"].join("/");

  it("opens the stable restrictive userData database outside HERMES_HOME", () => {
    expect(() =>
      resolveModelConfigurationDatabasePaths("relative/path"),
    ).toThrow("absolute");
    const userDataPath = temporaryUserData();
    const paths = resolveModelConfigurationDatabasePaths(userDataPath);
    expect(paths).toEqual({
      rootPath: join(userDataPath, "model-configuration"),
      databasePath: join(
        userDataPath,
        "model-configuration",
        "model-configuration.db",
      ),
    });

    process.env.HERMES_HOME = paths.rootPath;
    expect(() => databaseFor(userDataPath)).toThrow("outside HERMES_HOME");
    delete process.env.HERMES_HOME;

    const database = databaseFor(userDataPath);
    expect(database.sqlite.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: MODEL_CONFIGURATION_SCHEMA_VERSION,
    });
    if (process.platform !== "win32") {
      expect(statSync(database.paths.rootPath).mode & 0o777).toBe(0o700);
      expect(statSync(database.paths.databasePath).mode & 0o777).toBe(0o600);
    }
  });

  it("creates only the bounded operation journal schema", () => {
    const database = databaseFor();
    const tables = database.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "desktop_model_configuration_operations",
    ]);
    const columns = database.sqlite
      .prepare("PRAGMA table_info(desktop_model_configuration_operations)")
      .all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["api_key", "absolute_path", "file_body"]),
    );
  });

  it("records loading and loaded evidence for the actual better-sqlite3 binary", () => {
    const evidence: ModelConfigurationNativeStartupEvidence[] = [];
    const database = openModelConfigurationDatabase(temporaryUserData(), {
      databaseFactory: (path) =>
        new DatabaseSync(path) as unknown as ModelConfigurationSqliteDatabase,
      nativeStartupEvidenceSink: (event) => evidence.push(event),
    });
    databases.push(database);

    expect(evidence.map(({ status }) => status)).toEqual(["loading", "loaded"]);
    for (const event of evidence) {
      expect(event).toMatchObject({
        platform: process.platform,
        processArchitecture: process.arch,
        electronAbi: process.versions.modules ?? null,
        electronVersion: process.versions.electron ?? null,
        nativeModuleLocator: "better-sqlite3/build/Release/better_sqlite3.node",
        detectedNativeAbi: "145",
        failureClass: null,
      });
      expect(event.nativeModuleLocator).not.toMatch(
        /(?:^\/|\/Users\/|[A-Za-z]:[\\/])/u,
      );
    }
  });

  it.each([
    {
      name: "ABI mismatch",
      error: Object.assign(
        new Error(
          [
            `${privateUserPath}/better_sqlite3.node token=private-token`,
            "NODE_MODULE_VERSION 137 was compiled",
            "NODE_MODULE_VERSION 145 is required",
          ].join(" "),
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_abi_mismatch",
    },
    {
      name: "ordinary native load failure",
      error: Object.assign(
        new Error(
          `dlopen(${privateUserPath}/better_sqlite3.node): private-key could not load`,
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_load_failed",
    },
    {
      name: "repeated identical ABI marker",
      error: Object.assign(
        new Error(
          [
            `dlopen(${privateUserPath}/better_sqlite3.node): secret-token`,
            "NODE_MODULE_VERSION 145 was observed",
            "NODE_MODULE_VERSION 145 was observed again",
          ].join(" "),
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_load_failed",
    },
  ] as const)(
    "records safe loading and failed evidence for $name",
    ({ error, expectedCode }) => {
      const evidence: ModelConfigurationNativeStartupEvidence[] = [];
      const thrown = captureDatabaseOpenFailure(error, (event) =>
        evidence.push(event),
      );

      expect(evidence.map(({ status }) => status)).toEqual([
        "loading",
        "failed",
      ]);
      expect(evidence[1]).toMatchObject({
        platform: process.platform,
        processArchitecture: process.arch,
        electronAbi: process.versions.modules ?? null,
        electronVersion: process.versions.electron ?? null,
        nativeModuleLocator: "better-sqlite3/build/Release/better_sqlite3.node",
        detectedNativeAbi: "145",
        failureClass: expectedCode,
      });
      expect(thrown).toMatchObject({
        code: expectedCode,
        evidence: evidence[1],
        cause: error,
      });
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain(error.message);
      expect(serialized).not.toContain(privateUserPath);
      expect(serialized).not.toMatch(/secret|token|private-key/iu);
      expect(serialized).not.toMatch(/(?:\/Users\/|[A-Za-z]:[\\/])/u);
    },
  );

  it("writes default native startup evidence without logging the raw failure", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = Object.assign(
      new Error(
        `dlopen(${privateUserPath}/better_sqlite3.node): token=private-token`,
      ),
      { code: "ERR_DLOPEN_FAILED" },
    );
    try {
      captureDatabaseOpenFailure(error);
      expect(log.mock.calls.map(([label]) => label)).toEqual([
        "[MODEL_CONFIGURATION_NATIVE_STARTUP]",
        "[MODEL_CONFIGURATION_NATIVE_STARTUP]",
      ]);
      const logged = log.mock.calls.map(([, payload]) =>
        JSON.parse(String(payload)),
      ) as ModelConfigurationNativeStartupEvidence[];
      expect(logged.map(({ status }) => status)).toEqual(["loading", "failed"]);
      const serialized = JSON.stringify(logged);
      expect(serialized).not.toContain(error.message);
      expect(serialized).not.toContain(privateUserPath);
      expect(serialized).not.toMatch(/token|private-key/iu);
    } finally {
      log.mockRestore();
    }
  });

  // @lat: [[beta27-reliability-plan#Acceptance and release boundary#Native startup failure classification]]
  it.each([
    {
      name: "ABI mismatch",
      error: Object.assign(
        new Error(
          [
            `The module '${privateUserPath}/Aera.app/better_sqlite3.node'`,
            "was compiled against a different Node.js version using",
            "NODE_MODULE_VERSION 137. This version of Node.js requires",
            "NODE_MODULE_VERSION 145.",
          ].join(" "),
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_abi_mismatch",
    },
    {
      name: "repeated identical ABI marker",
      error: Object.assign(
        new Error(
          [
            `dlopen(${privateUserPath}/better_sqlite3.node): failed to load`,
            "NODE_MODULE_VERSION 145 was observed before retrying",
            "NODE_MODULE_VERSION 145.",
          ].join(" "),
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_load_failed",
    },
    {
      name: "architecture mismatch",
      error: Object.assign(
        new Error(
          `dlopen(${privateUserPath}/better_sqlite3.node): mach-o file, but is an incompatible architecture`,
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_architecture_mismatch",
    },
    {
      name: "missing native dependency",
      error: Object.assign(
        new Error(
          `dlopen(${privateUserPath}/better_sqlite3.node): Library not loaded: @rpath/libmissing.dylib`,
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_dependency_missing",
    },
    {
      name: "native module load denied",
      error: Object.assign(
        new Error(
          `dlopen(${privateUserPath}/better_sqlite3.node): permission denied`,
        ),
        { code: "EACCES" },
      ),
      expectedCode: "native_module_load_denied",
    },
    {
      name: "unclassified native load failure",
      error: Object.assign(
        new Error(
          `dlopen(${privateUserPath}/better_sqlite3.node): failed for an unclassified reason`,
        ),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      expectedCode: "native_module_load_failed",
    },
    {
      name: "ordinary SQLite open failure",
      error: new Error(
        `SQLITE_CANTOPEN: unable to open ${privateUserPath}/model-configuration.db`,
      ),
      expectedCode: "model_configuration_database_unavailable",
    },
  ])(
    "classifies $name without exposing raw failure data",
    ({ error, expectedCode }) => {
      const thrown = captureDatabaseOpenFailure(error);
      expect(thrown).toMatchObject({
        name: "ModelConfigurationRuntimeError",
        code: expectedCode,
        evidence: {
          status: "failed",
          platform: process.platform,
          processArchitecture: process.arch,
          electronAbi: process.versions.modules,
          failureClass: expectedCode,
        },
      });

      const publicFailure = thrown as {
        code?: unknown;
        evidence?: unknown;
        message?: unknown;
      };
      const serialized = JSON.stringify({
        code: publicFailure.code,
        evidence: publicFailure.evidence,
        message: publicFailure.message,
      });
      expect(serialized).not.toContain(error.message);
      expect(serialized).toContain(
        "better-sqlite3/build/Release/better_sqlite3.node",
      );
      expect(serialized).not.toContain(`${privateUserPath}/`);
      expect(serialized).not.toMatch(/[A-Za-z]:\\\\/u);
    },
  );

  it("reopens a closed current-schema database", () => {
    const userDataPath = temporaryUserData();
    const first = databaseFor(userDataPath);
    first.close();
    databases.splice(databases.indexOf(first), 1);

    const reopened = databaseFor(userDataPath);
    expect(reopened.sqlite.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: MODEL_CONFIGURATION_SCHEMA_VERSION,
    });
  });

  it("refuses a future DELETE-journal schema without changing filesystem state", () => {
    const userDataPath = temporaryUserData();
    const paths = resolveModelConfigurationDatabasePaths(userDataPath);
    mkdirSync(paths.rootPath, { recursive: true });
    const futureVersion = MODEL_CONFIGURATION_SCHEMA_VERSION + 1;
    const seed = new DatabaseSync(paths.databasePath);
    try {
      seed.exec("PRAGMA journal_mode=DELETE");
      seed.exec(`PRAGMA user_version = ${futureVersion}`);
    } finally {
      seed.close();
    }
    const before = snapshotDatabase(paths);
    expect(before.journalMode).toBe("delete");

    let thrown: unknown;
    try {
      databaseFor(userDataPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "ModelConfigurationRuntimeError",
      code: "model_configuration_schema_unsupported",
    });
    expect(snapshotDatabase(paths)).toEqual(before);
  });
});
